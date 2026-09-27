import { validHandle, type ErrorCode } from "../protocol";
import type { PlaybackCandidate, PlaylistItem } from "./playlist";
import { LMS_ORIGINS } from "../security/policy";
import { navigationUrl } from "../security/navigation";

export type PlaybackCommand =
  | {
      version: 1;
      type:
        | "PLAYBACK_STATUS"
        | "PLAYBACK_REFRESH"
        | "PLAYBACK_PAUSE"
        | "PLAYBACK_RESUME"
        | "PLAYBACK_STOP_ALL";
    }
  | {
      version: 1;
      type: "PLAYBACK_START";
      /** Opaque, one-use handles in the exact order selected by the user. */
      handles: readonly string[];
      /** Routing plus an ephemeral proof of the content document that issued the handles. */
      sourceTabId: number;
      documentToken: string;
    }
  | { version: 1; type: "LOCAL_DATA_DELETE_ALL" }
  | { version: 1; type: "PLAYBACK_CANCEL"; id: string };
export type RuntimeStatus =
  | "idle"
  | "starting"
  | "playing"
  | "paused"
  | "stopped"
  | "blocked-login"
  | "blocked-autoplay"
  | "failed";
export interface PlaybackSnapshot {
  readonly courses: readonly { id: string; name: string }[];
  readonly labels: Readonly<Record<string, string>>;
  readonly queue: readonly PlaylistItem[];
  readonly status: RuntimeStatus;
  readonly current: PlaylistItem | null;
}
const runtimeStatuses: readonly RuntimeStatus[] = [
  "idle",
  "starting",
  "playing",
  "paused",
  "stopped",
  "blocked-login",
  "blocked-autoplay",
  "failed",
];
export type PlaybackError =
  ErrorCode | "UNAVAILABLE" | "ACCOUNT_CHANGED" | "PLAYER_LOST" | "STORAGE";
export type PlaybackResult =
  | { status: "success"; snapshot: PlaybackSnapshot }
  | { status: "error"; code: PlaybackError };

/** Internal content/background contract. Never accepts an endpoint, URL or account from the panel. */
export interface PlaybackDiscovery {
  readonly accountKey: string;
  readonly origin: string;
  readonly courses: readonly { id: string; name: string }[];
  readonly candidates: readonly PlaybackCandidate[];
}
export const PLAYBACK_DISCOVER = {
  version: 1,
  type: "PLAYBACK_DISCOVER",
} as const;
export interface ResolvedRecording {
  readonly discovery: PlaybackDiscovery;
  readonly id: string;
  readonly courseId: string;
}
export type DiscoveryResult =
  | { status: "success"; discovery: PlaybackDiscovery }
  | { status: "error"; code: PlaybackError };
export const playbackErrors: readonly PlaybackError[] = [
  "LOGIN_REQUIRED",
  "OPEN_LMS",
  "RELOAD_TAB",
  "FORBIDDEN",
  "NETWORK",
  "TIMEOUT",
  "INVALID_RESPONSE",
  "POLICY",
  "LIMIT",
  "COURSE_NOT_FOUND",
  "COURSE_AMBIGUOUS",
  "BUSY",
  "STALE_SELECTION",
  "TAB_OPEN_FAILED",
  "UNAVAILABLE",
  "ACCOUNT_CHANGED",
  "PLAYER_LOST",
  "STORAGE",
];
export function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function stableId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);
}
export function itemKey(value: unknown): value is string {
  return (
    typeof value === "string" && /^[1-9]\d{0,19}:[1-9]\d{0,19}$/.test(value)
  );
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
function course(value: unknown): value is { id: string; name: string } {
  return (
    object(value) &&
    Object.keys(value).length === 2 &&
    stableId(value.id) &&
    typeof value.name === "string" &&
    value.name.length <= 2000
  );
}
export function isPlaybackCommand(value: unknown): value is PlaybackCommand {
  if (!object(value) || value.version !== 1) return false;
  switch (value.type) {
    case "PLAYBACK_STATUS":
    case "PLAYBACK_REFRESH":
    case "PLAYBACK_PAUSE":
    case "PLAYBACK_RESUME":
    case "PLAYBACK_STOP_ALL":
    case "LOCAL_DATA_DELETE_ALL":
      return Object.keys(value).length === 2;
    case "PLAYBACK_START":
      return (
        Object.keys(value).length === 5 &&
        Array.isArray(value.handles) &&
        value.handles.length > 0 &&
        value.handles.length <= 100 &&
        value.handles.every(validHandle) &&
        new Set(value.handles).size === value.handles.length &&
        typeof value.sourceTabId === "number" &&
        Number.isInteger(value.sourceTabId) &&
        value.sourceTabId >= 0 &&
        validHandle(value.documentToken)
      );
    case "PLAYBACK_CANCEL":
      return Object.keys(value).length === 3 && itemKey(value.id);
    default:
      return false;
  }
}

export interface PlaybackSource {
  readonly sourceTabId: number;
  readonly documentToken: string;
}
export function backgroundSender(
  sender: chrome.runtime.MessageSender,
): boolean {
  return (
    sender.id === chrome.runtime.id &&
    sender.tab === undefined &&
    (sender.url === undefined ||
      sender.url === chrome.runtime.getURL("background.js"))
  );
}
export function panelSender(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL("sidepanel.html") &&
    (sender.tab?.url === undefined ||
      sender.tab.url === chrome.runtime.getURL("sidepanel.html"))
  );
}
export function playerPage(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      ((url.origin === "https://kucom.korea.ac.kr" &&
        url.pathname.startsWith("/em/")) ||
        navigationUrl(value, value) === value)
    );
  } catch {
    return false;
  }
}
export function isDiscovery(value: unknown): value is PlaybackDiscovery {
  return (
    object(value) &&
    Object.keys(value).length === 4 &&
    typeof value.accountKey === "string" &&
    /^[a-f0-9]{64}$/.test(value.accountKey) &&
    LMS_ORIGINS.some((origin) => origin === value.origin) &&
    Array.isArray(value.courses) &&
    value.courses.length <= 100 &&
    value.courses.every(course) &&
    Array.isArray(value.candidates) &&
    value.candidates.length <= 10000 &&
    value.candidates.every(
      (candidate) =>
        object(candidate) &&
        Object.keys(candidate).length ===
          (candidate.title === undefined ? 2 : 3) &&
        itemKey(candidate.id) &&
        stableId(candidate.courseId) &&
        candidate.id.startsWith(`${candidate.courseId}:`) &&
        (candidate.title === undefined ||
          (typeof candidate.title === "string" &&
            candidate.title.length <= 2000)),
    ) &&
    new Set(value.candidates.map((candidate) => candidate.id)).size ===
      value.candidates.length
  );
}
export async function playbackCommand(
  command: PlaybackCommand,
): Promise<PlaybackResult> {
  try {
    const result: unknown = await chrome.runtime.sendMessage(command);
    if (
      object(result) &&
      result.status === "error" &&
      playbackErrors.some((code) => code === result.code)
    )
      return result as PlaybackResult;
    if (object(result) && result.status === "success") {
      const snapshot = result.snapshot;
      if (
        object(snapshot) &&
        Object.keys(snapshot).length === 5 &&
        Array.isArray(snapshot.courses) &&
        snapshot.courses.length <= 100 &&
        snapshot.courses.every(course) &&
        object(snapshot.labels) &&
        Object.keys(snapshot.labels).length <= 10000 &&
        Object.entries(snapshot.labels).every(
          ([id, label]) =>
            itemKey(id) && typeof label === "string" && label.length <= 2000,
        ) &&
        Array.isArray(snapshot.queue) &&
        snapshot.queue.length <= 99 &&
        snapshot.queue.every(playlistItem) &&
        new Set(snapshot.queue.map((item) => item.id)).size ===
          snapshot.queue.length &&
        runtimeStatuses.includes(snapshot.status as RuntimeStatus) &&
        (snapshot.current === null || playlistItem(snapshot.current)) &&
        !snapshot.queue.some(
          (item) => item.id === (snapshot.current as PlaylistItem | null)?.id,
        )
      )
        return result as PlaybackResult;
    }
    return { status: "error", code: "INVALID_RESPONSE" };
  } catch {
    return { status: "error", code: "UNAVAILABLE" };
  }
}

export interface PlayerBinding {
  readonly runId: string;
  readonly token: string;
  readonly deadline: number;
}
export type PlayerSignal =
  | "starting"
  | "playing"
  | "paused"
  | "ended"
  | "blocked-login"
  | "blocked-autoplay"
  | "failed";
export type PlayerControl = PlayerBinding & {
  readonly version: 1;
  readonly type: "PLAYBACK_PLAYER_CONTROL";
} & (
    | { readonly action: "pause" | "stop" }
    | { readonly action: "resume"; readonly leaseUntil: number }
  );
export function isPlayerBinding(value: unknown): value is PlayerBinding {
  return (
    object(value) &&
    typeof value.runId === "string" &&
    /^[a-f0-9-]{36}$/.test(value.runId) &&
    typeof value.token === "string" &&
    /^[a-f0-9-]{36}$/.test(value.token) &&
    typeof value.deadline === "number" &&
    Number.isFinite(value.deadline)
  );
}

export function isPlayerControl(value: unknown): value is PlayerControl {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.type !== "PLAYBACK_PLAYER_CONTROL" ||
    !isPlayerBinding(value)
  )
    return false;
  if (value.action === "pause" || value.action === "stop")
    return Object.keys(value).length === 6;
  return (
    value.action === "resume" &&
    Object.keys(value).length === 7 &&
    typeof value.leaseUntil === "number" &&
    Number.isFinite(value.leaseUntil)
  );
}
