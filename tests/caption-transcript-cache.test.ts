import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CAPTION_TRANSCRIPT_CACHE_KEY,
  hasCachedTranscripts,
  loadCachedTranscript,
  saveCachedTranscript,
  withCaptionCacheLock,
  readCaptionCacheEpoch,
  type CachedTranscript,
} from "../src/captions/transcript-cache";
import { CAPTION_SESSION_EPOCH_KEY } from "../src/caption-server-settings";

let stored: Record<string, unknown>;
let session: Record<string, unknown>;
const key = (n: number) => `unidock-${n.toString(16).padStart(40, "0")}`;
const value: CachedTranscript = {
  items: [{ index: 0, time: "00:00", text: "저장한 자막" }],
  engine: "whisper", modelRevision: "r1",
  extractedAt: "2026-11-05T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z",
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T00:00:00Z"));
  stored = {};
  session = {};
  vi.stubGlobal("chrome", { storage: { local: {
    get: async (name: string) => ({ [name]: stored[name] }),
    set: async (patch: Record<string, unknown>) => { Object.assign(stored, patch); },
  }, session: {
    get: async (name: string) => ({ [name]: session[name] }),
  } } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("restores full captions for the same lecture and misses a different one", async () => {
  expect(await hasCachedTranscripts()).toBe(false);
  await saveCachedTranscript(key(1), value);
  expect(await loadCachedTranscript(key(1))).toEqual(value);
  expect(await loadCachedTranscript(key(2))).toBeNull();
  expect(await hasCachedTranscripts()).toBe(true);
});

it("rejects expired and malformed stored captions", async () => {
  await saveCachedTranscript(key(1), value);
  vi.setSystemTime(new Date(value.expiresAt));
  expect(await loadCachedTranscript(key(1))).toBeNull();
  stored[CAPTION_TRANSCRIPT_CACHE_KEY] = { [key(2)]: { ...value, items: [{ text: 5 }] } };
  expect(await loadCachedTranscript(key(2))).toBeNull();
});

it("evicts the oldest entry when the count budget is reached", async () => {
  for (let n = 0; n < 21; n++) await saveCachedTranscript(key(n), value);
  expect(await loadCachedTranscript(key(0))).toBeNull();
  expect(await loadCachedTranscript(key(20))).toEqual(value);
  expect(Object.keys(stored[CAPTION_TRANSCRIPT_CACHE_KEY] as object)).toHaveLength(20);
});

it("bounds stored UTF8 bytes and rejects oversized individual transcripts", async () => {
  const large = { ...value, items: Array.from({ length: 100 }, (_, index) => ({
    index, time: "00:00", text: "가".repeat(10000),
  })) };
  await saveCachedTranscript(key(1), large);
  await saveCachedTranscript(key(2), large);
  expect(await loadCachedTranscript(key(1))).toBeNull();
  expect(await loadCachedTranscript(key(2))).toEqual(large);
  await saveCachedTranscript(key(3), { ...large, items: [...large.items, ...large.items] });
  expect(await loadCachedTranscript(key(3))).toBeNull();
  expect(new TextEncoder().encode(JSON.stringify(stored)).length).toBeLessThan(4 * 1024 * 1024 + 100);
});

it("preserves both lectures when separate panels save concurrently", async () => {
  await Promise.all([
    saveCachedTranscript(key(1), value),
    saveCachedTranscript(key(2), value),
  ]);
  expect(await loadCachedTranscript(key(1))).toEqual(value);
  expect(await loadCachedTranscript(key(2))).toEqual(value);
});

it("finishes deletion after an in-flight save without resurrecting caption text", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const get = chrome.storage.local.get;
  vi.spyOn(chrome.storage.local, "get").mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    return { [CAPTION_TRANSCRIPT_CACHE_KEY]: { [key(1)]: value } };
  });
  const saving = saveCachedTranscript(key(2), value);
  await started.promise;
  // revokeAndClear invalidates the session generation before taking the cache lock.
  session[CAPTION_SESSION_EPOCH_KEY] = "deleted";
  let erased = false;
  const erasing = withCaptionCacheLock(async () => {
    delete stored[CAPTION_TRANSCRIPT_CACHE_KEY];
    erased = true;
  });
  expect(erased).toBe(false);
  release.resolve();
  await Promise.all([saving, erasing]);
  expect(stored[CAPTION_TRANSCRIPT_CACHE_KEY]).toBeUndefined();
  chrome.storage.local.get = get;
});

it("rejects a transcript response that arrives after local deletion", async () => {
  const epoch = await readCaptionCacheEpoch();
  await withCaptionCacheLock(async () => {
    session[CAPTION_SESSION_EPOCH_KEY] = "deleted";
    delete stored[CAPTION_TRANSCRIPT_CACHE_KEY];
  });
  await saveCachedTranscript(key(1), value, epoch);
  expect(stored[CAPTION_TRANSCRIPT_CACHE_KEY]).toBeUndefined();
});
