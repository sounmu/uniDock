import type { Transcript } from "./transcript";
import { CAPTION_SESSION_EPOCH_KEY } from "../caption-server-settings";

export const CAPTION_TRANSCRIPT_CACHE_KEY = "unidock.caption-transcripts.v1";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 20;
const CACHE_LOCK = "unidock-caption-cache";

/** Shared by panel writers and background erasure, including across windows. */
export function withCaptionCacheLock<T>(action: () => Promise<T>): Promise<T> {
  return navigator.locks.request(CACHE_LOCK, action);
}

async function readEpoch(): Promise<string | null> {
  const value = (await chrome.storage.session.get(CAPTION_SESSION_EPOCH_KEY))[
    CAPTION_SESSION_EPOCH_KEY
  ];
  return typeof value === "string" ? value : null;
}

export function readCaptionCacheEpoch(): Promise<string | null> {
  return withCaptionCacheLock(readEpoch);
}

export interface CachedTranscript {
  readonly items: Transcript["items"];
  readonly engine: string;
  readonly modelRevision: string;
  readonly expiresAt: string;
  readonly extractedAt: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(value: unknown): CachedTranscript | null {
  if (
    !object(value) ||
    typeof value.expiresAt !== "string" ||
    !(Date.parse(value.expiresAt) > Date.now()) ||
    typeof value.extractedAt !== "string" ||
    !Number.isFinite(Date.parse(value.extractedAt)) ||
    typeof value.engine !== "string" || value.engine.length > 200 ||
    typeof value.modelRevision !== "string" || value.modelRevision.length > 200 ||
    !Array.isArray(value.items) || value.items.length > 20000
  ) return null;
  const items: Transcript["items"] = [];
  for (const item of value.items) {
    if (
      !object(item) || typeof item.index !== "number" ||
      !Number.isSafeInteger(item.index) || item.index < 0 ||
      typeof item.time !== "string" || item.time.length > 32 ||
      typeof item.text !== "string" || item.text.length > 20000
    ) return null;
    items.push({ index: item.index, time: item.time, text: item.text });
  }
  return {
    items,
    engine: value.engine,
    modelRevision: value.modelRevision,
    expiresAt: value.expiresAt,
    extractedAt: value.extractedAt,
  };
}

async function records(): Promise<Record<string, CachedTranscript>> {
  const stored = (await chrome.storage.local.get(CAPTION_TRANSCRIPT_CACHE_KEY))[
    CAPTION_TRANSCRIPT_CACHE_KEY
  ];
  const result: Record<string, CachedTranscript> = {};
  if (!object(stored)) return result;
  for (const [key, value] of Object.entries(stored)) {
    if (!/^unidock-[0-9a-f]{40}$/.test(key)) continue;
    const parsed = parse(value);
    if (parsed) result[key] = parsed;
  }
  return result;
}

export async function hasCachedTranscripts(): Promise<boolean> {
  return Object.keys(await records()).length > 0;
}

export async function loadCachedTranscript(key: string): Promise<CachedTranscript | null> {
  return (await records())[key] ?? null;
}

export async function saveCachedTranscript(
  key: string,
  value: CachedTranscript,
  expectedEpoch?: string | null,
): Promise<void> {
  if (!/^unidock-[0-9a-f]{40}$/.test(key)) return;
  const parsed = parse(value);
  if (!parsed) return;
  const bytes = (data: unknown) => new TextEncoder().encode(JSON.stringify(data)).byteLength;
  if (bytes({ [key]: parsed }) > MAX_BYTES) return;
  const epoch = expectedEpoch === undefined ? await readCaptionCacheEpoch() : expectedEpoch;
  await withCaptionCacheLock(async () => {
    if (await readEpoch() !== epoch) return;
    const entries = await records();
    delete entries[key];
    entries[key] = parsed;
    while (Object.keys(entries).length > MAX_ENTRIES || bytes(entries) > MAX_BYTES) {
      const oldest = Object.keys(entries)[0];
      if (!oldest) break;
      delete entries[oldest];
    }
    await chrome.storage.local.set({ [CAPTION_TRANSCRIPT_CACHE_KEY]: entries });
  });
}
