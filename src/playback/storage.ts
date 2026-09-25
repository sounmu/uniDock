import { DEFAULT_PLAYBACK_SETTINGS, type PlaybackSettings } from "./scheduler";
import {
  confirmedDeadline,
  itemKey,
  object,
  stableId,
  validSettings,
  validCalendarOverride,
  type CalendarOverride,
} from "./bridge";
import { LMS_ORIGINS } from "../security/policy";

export const PLAYBACK_STORAGE_KEY = "unidock.playback.v1";
const SALT_KEY = "unidock.playback.salt";
export interface PlaybackConfirmation {
  id: string;
  courseId: string;
  deadline: string;
  durationMinutes: number;
  completion: "incomplete";
  sourceDeadline: string | null;
}
export interface StoredPlayback {
  version: 1;
  accountKey: string;
  origin: string;
  settings: PlaybackSettings;
  finishedIds: string[];
  excludedIds: string[];
  terminalAt: Record<string, number>;
  /** A tab pointer is recovery-only. Tokens, document IDs, URLs and payloads are never stored. */
  player: { tabId: number; id: string; courseId: string } | null;
  stopped: boolean;
  confirmations: PlaybackConfirmation[];
  calendarOverrides: CalendarOverride[];
}
export function emptyPlayback(accountKey = "", origin = ""): StoredPlayback {
  return {
    version: 1,
    accountKey,
    origin,
    settings: { ...DEFAULT_PLAYBACK_SETTINGS, courseIds: [] },
    finishedIds: [],
    excludedIds: [],
    terminalAt: {},
    player: null,
    stopped: false,
    confirmations: [],
    calendarOverrides: [],
  };
}
export function parseStoredPlayback(value: unknown): StoredPlayback | null {
  if (
    !object(value) ||
    Object.keys(value).length !== 11 ||
    value.version !== 1 ||
    typeof value.accountKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.accountKey) ||
    !LMS_ORIGINS.some((origin) => origin === value.origin) ||
    !validSettings(value.settings) ||
    typeof value.stopped !== "boolean"
  )
    return null;
  for (const ids of [value.finishedIds, value.excludedIds])
    if (
      !Array.isArray(ids) ||
      ids.length > 10000 ||
      !ids.every(itemKey) ||
      new Set(ids).size !== ids.length
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
  if (
    !Array.isArray(value.confirmations) ||
    value.confirmations.length > 10000 ||
    !value.confirmations.every(
      (item) =>
        object(item) &&
        Object.keys(item).length === 6 &&
        itemKey(item.id) &&
        stableId(item.courseId) &&
        item.id.startsWith(`${item.courseId}:`) &&
        confirmedDeadline(item.deadline) &&
        typeof item.durationMinutes === "number" &&
        Number.isFinite(item.durationMinutes) &&
        item.durationMinutes > 0 &&
        item.durationMinutes <= 1440 &&
        item.completion === "incomplete" &&
        (item.sourceDeadline === null ||
          (typeof item.sourceDeadline === "string" &&
            item.sourceDeadline.length <= 40)),
    )
  )
    return null;
  if (
    !object(value.terminalAt) ||
    Object.keys(value.terminalAt).length > 10000 ||
    !Object.entries(value.terminalAt).every(
      ([id, at]) =>
        itemKey(id) && typeof at === "number" && Number.isFinite(at) && at >= 0,
    )
  )
    return null;
  if (
    !Array.isArray(value.calendarOverrides) ||
    value.calendarOverrides.length > 10000 ||
    !value.calendarOverrides.every(validCalendarOverride)
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
      const salt = Array.from(
        crypto.getRandomValues(new Uint8Array(32)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      // Discovery while OFF is ephemeral; consented save() is the only durable write.
      return salt;
    })());
  }
  async load(): Promise<StoredPlayback | null> {
    // Content scripts never receive direct access to this account-scoped storage.
    await chrome.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    const values = await chrome.storage.local.get(PLAYBACK_STORAGE_KEY);
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
    await chrome.storage.local.remove([PLAYBACK_STORAGE_KEY, SALT_KEY]);
    await chrome.storage.session.remove("unidock.playback.owned-tab");
    this.saltPromise = undefined;
  }
}
