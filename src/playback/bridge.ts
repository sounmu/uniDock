import { validDate, validHandle, type ErrorCode } from "../protocol";
import type {
  PlaybackSettings,
  PlaybackCandidate,
  PlaybackPlan,
  ScheduledPlayback,
  LmsCredit,
} from "./scheduler";
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
  | { version: 1; type: "PLAYBACK_CONFIGURE"; settings: PlaybackSettings }
  | {
      version: 1;
      type: "PLAYBACK_CONFIRM";
      handle: string;
      deadline: string;
      durationMinutes: number;
      completion: "incomplete";
    }
  | {
      version: 1;
      type: "CALENDAR_OVERRIDES_GET";
      sources: readonly CalendarSource[];
    }
  | { version: 1; type: "CALENDAR_OVERRIDE_SET"; override: CalendarOverride }
  | { version: 1; type: "CALENDAR_OVERRIDE_REMOVE"; id: string }
  | { version: 1; type: "LOCAL_DATA_DELETE_ALL" }
  | { version: 1; type: "PLAYBACK_CANCEL"; id: string };
export interface CalendarSource {
  readonly id: string;
  readonly sourceRevision: string;
}
export type CalendarOverride = CalendarSource &
  (
    | { readonly excluded: true }
    | {
        readonly excluded: false;
        readonly date: string;
        readonly time?: string;
      }
  );
export type CalendarOverrideView = CalendarOverride & {
  readonly confirmationRequired: boolean;
};
export function validCalendarSource(value: unknown): value is CalendarSource {
  return (
    object(value) &&
    typeof value.id === "string" &&
    /^(announcement|planner|assignment):[a-f0-9]{8}(?::copy:[1-9]\d{0,4})?$/.test(
      value.id,
    ) &&
    typeof value.sourceRevision === "string" &&
    value.sourceRevision.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?$/.test(value.sourceRevision) &&
    Number.isFinite(Date.parse(value.sourceRevision))
  );
}
export function validCalendarOverride(
  value: unknown,
): value is CalendarOverride {
  return (
    validCalendarSource(value) &&
    object(value) &&
    (value.excluded === true
      ? Object.keys(value).length === 3
      : value.excluded === false &&
        validDate(value.date) &&
        (value.time === undefined
          ? Object.keys(value).length === 4
          : Object.keys(value).length === 5 &&
            typeof value.time === "string" &&
            /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)))
  );
}
export function confirmedDeadline(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}
export type RuntimeStatus =
  | "idle"
  | "scheduled"
  | "starting"
  | "playing"
  | "paused"
  | "stopped"
  | "blocked-login"
  | "blocked-autoplay"
  | "confirmation-required"
  | "failed";
export interface PlaybackSnapshot {
  readonly settings: PlaybackSettings;
  readonly courses: readonly { id: string; name: string }[];
  readonly labels: Readonly<Record<string, string>>;
  readonly queue: PlaybackPlan["queue"];
  readonly blocked: PlaybackPlan["blocked"];
  readonly status: RuntimeStatus;
  readonly active: (ScheduledPlayback & { credit: LmsCredit }) | null;
  readonly finishedIds: readonly string[];
  readonly confirmationRequired: boolean;
  readonly calendarOverrides: readonly CalendarOverrideView[];
}
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
export function validSettings(value: unknown): value is PlaybackSettings {
  if (
    !object(value) ||
    Object.keys(value).length !== 6 ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.courseIds) ||
    value.courseIds.length > 100 ||
    !value.courseIds.every(stableId) ||
    new Set(value.courseIds).size !== value.courseIds.length
  )
    return false;
  const {
    windowStartHour: start,
    windowEndHour: end,
    leadHours,
    marginMinutes,
  } = value;
  return (
    typeof start === "number" &&
    Number.isInteger(start) &&
    start >= 0 &&
    typeof end === "number" &&
    Number.isInteger(end) &&
    end <= 24 &&
    end > start &&
    typeof leadHours === "number" &&
    Number.isInteger(leadHours) &&
    leadHours >= 0 &&
    leadHours <= 168 &&
    typeof marginMinutes === "number" &&
    Number.isInteger(marginMinutes) &&
    marginMinutes >= 0 &&
    marginMinutes <= 120
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
    case "PLAYBACK_CONFIRM":
      return (
        Object.keys(value).length === 6 &&
        validHandle(value.handle) &&
        confirmedDeadline(value.deadline) &&
        typeof value.durationMinutes === "number" &&
        Number.isFinite(value.durationMinutes) &&
        value.durationMinutes > 0 &&
        value.durationMinutes <= 1440 &&
        value.completion === "incomplete"
      );
    case "CALENDAR_OVERRIDES_GET":
      return (
        Object.keys(value).length === 3 &&
        Array.isArray(value.sources) &&
        value.sources.length <= 10000 &&
        value.sources.every(
          (source) =>
            validCalendarSource(source) && Object.keys(source).length === 2,
        )
      );
    case "CALENDAR_OVERRIDE_SET":
      return (
        Object.keys(value).length === 3 && validCalendarOverride(value.override)
      );
    case "CALENDAR_OVERRIDE_REMOVE":
      return (
        Object.keys(value).length === 3 &&
        typeof value.id === "string" &&
        /^(announcement|planner|assignment):[a-f0-9]{8}(?::copy:[1-9]\d{0,4})?$/.test(
          value.id,
        )
      );
    case "PLAYBACK_CONFIGURE":
      return Object.keys(value).length === 3 && validSettings(value.settings);
    case "PLAYBACK_CANCEL":
      return Object.keys(value).length === 3 && itemKey(value.id);
    default:
      return false;
  }
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
    value.courses.every(
      (course) =>
        object(course) &&
        Object.keys(course).length === 2 &&
        stableId(course.id) &&
        typeof course.name === "string" &&
        course.name.length <= 2000,
    ) &&
    Array.isArray(value.candidates) &&
    value.candidates.length <= 10000 &&
    value.candidates.every(
      (candidate) =>
        object(candidate) &&
        Object.keys(candidate).length ===
          (candidate.title === undefined ? 5 : 6) &&
        itemKey(candidate.id) &&
        stableId(candidate.courseId) &&
        candidate.id.startsWith(`${candidate.courseId}:`) &&
        (candidate.title === undefined ||
          (typeof candidate.title === "string" &&
            candidate.title.length <= 2000)) &&
        (candidate.deadline === null ||
          (typeof candidate.deadline === "string" &&
            candidate.deadline.length <= 40)) &&
        (candidate.durationMinutes === null ||
          (typeof candidate.durationMinutes === "number" &&
            Number.isFinite(candidate.durationMinutes) &&
            candidate.durationMinutes > 0 &&
            candidate.durationMinutes <= 1440)) &&
        ["complete", "incomplete", "unknown"].includes(
          String(candidate.completion),
        ),
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
    if (
      object(result) &&
      result.status === "success" &&
      object(result.snapshot) &&
      validSettings(result.snapshot.settings) &&
      Array.isArray(result.snapshot.courses) &&
      Array.isArray(result.snapshot.queue) &&
      Array.isArray(result.snapshot.blocked) &&
      Array.isArray(result.snapshot.finishedIds) &&
      typeof result.snapshot.confirmationRequired === "boolean" &&
      typeof result.snapshot.status === "string"
    )
      return result as PlaybackResult;
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
  readonly action: "start" | "pause" | "resume" | "stop";
};
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
