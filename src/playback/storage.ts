import { LMS_ORIGINS } from "../security/policy";
import { itemKey, object, stableId } from "./bridge";
import type { PlaylistItem } from "./playlist";

export const PLAYBACK_STORAGE_KEY = "unidock.playback.v2";
const LEGACY_PLAYBACK_STORAGE_KEY = "unidock.playback.v1";
const SALT_KEY = "unidock.playback.salt";

export interface StoredPlayback {
  version: 2;
  accountKey: string;
  origin: string;
  /** Current item first, followed by the remaining click-ordered playlist. */
  playlist: PlaylistItem[];
  /** Recovery pointer only. Authorization tokens, handles and URLs are never stored. */
  player: { tabId: number; id: string; courseId: string } | null;
  /** Any worker interruption or failure requires an explicit resume. */
  stopped: boolean;
}

export function emptyPlayback(accountKey = "", origin = ""): StoredPlayback {
  return {
    version: 2,
    accountKey,
    origin,
    playlist: [],
    player: null,
    stopped: true,
  };
}

function playlistItem(value: unknown): value is PlaylistItem {
  return (
    object(value) &&
    Object.keys(value).length === 2 &&
    itemKey(value.id) &&
    stableId(value.courseId) &&
    value.id.startsWith(`${value.courseId}:`)
  );
}

export function parseStoredPlayback(value: unknown): StoredPlayback | null {
  if (
    !object(value) ||
    Object.keys(value).length !== 6 ||
    value.version !== 2 ||
    typeof value.accountKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.accountKey) ||
    !LMS_ORIGINS.some((origin) => origin === value.origin) ||
    typeof value.stopped !== "boolean" ||
    !Array.isArray(value.playlist) ||
    value.playlist.length > 100 ||
    !value.playlist.every(playlistItem) ||
    new Set(value.playlist.map((item) => item.id)).size !==
      value.playlist.length
  )
    return null;
  if (
    value.player !== null &&
    (!object(value.player) ||
      Object.keys(value.player).length !== 3 ||
      typeof value.player.tabId !== "number" ||
      !Number.isInteger(value.player.tabId) ||
      value.player.tabId < 0 ||
      !itemKey(value.player.id) ||
      !stableId(value.player.courseId) ||
      !value.player.id.startsWith(`${value.player.courseId}:`))
  )
    return null;
  return value as unknown as StoredPlayback;
}

export interface PlaybackStore {
  load(): Promise<StoredPlayback | null>;
  save(state: StoredPlayback): Promise<void>;
  clear(): Promise<void>;
  erase(): Promise<void>;
}

export class ChromePlaybackStore implements PlaybackStore {
  private saltPromise?: Promise<string>;
  accountSalt(): Promise<string> {
    return (this.saltPromise ??= (async () => {
      const values = await chrome.storage.local.get(SALT_KEY);
      const known: unknown = values[SALT_KEY];
      if (typeof known === "string" && /^[a-f0-9]{64}$/.test(known))
        return known;
      return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    })());
  }
  async load(): Promise<StoredPlayback | null> {
    await chrome.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    const values = await chrome.storage.local.get([
      PLAYBACK_STORAGE_KEY,
      LEGACY_PLAYBACK_STORAGE_KEY,
    ]);
    // Scheduled v1 state is deliberately never migrated or allowed to auto-run.
    if (values[LEGACY_PLAYBACK_STORAGE_KEY] !== undefined)
      await chrome.storage.local.remove(LEGACY_PLAYBACK_STORAGE_KEY);
    const raw: unknown = values[PLAYBACK_STORAGE_KEY];
    const state = parseStoredPlayback(raw);
    if (raw !== undefined && !state) await this.clear();
    return state;
  }
  async save(state: StoredPlayback): Promise<void> {
    await chrome.storage.local.set({
      [PLAYBACK_STORAGE_KEY]: state,
      [SALT_KEY]: await this.accountSalt(),
    });
  }
  async clear(): Promise<void> {
    await chrome.storage.local.remove(PLAYBACK_STORAGE_KEY);
  }
  async erase(): Promise<void> {
    await chrome.storage.local.remove([
      PLAYBACK_STORAGE_KEY,
      LEGACY_PLAYBACK_STORAGE_KEY,
      SALT_KEY,
    ]);
    await chrome.storage.session.remove("unidock.playback.owned-tab");
    this.saltPromise = undefined;
  }
}
