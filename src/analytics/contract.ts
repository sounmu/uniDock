// Closed panel -> background messages for aggregate usage statistics.
// A signal carries only fixed codes and one bounded duration; operation IDs,
// LMS data, URLs, labels and raw errors never cross this boundary.
import {
  CORE_RESULTS,
  ERROR_CODES,
  MAX_DURATION_MS,
  OPERATIONS,
  SERVICES,
  TRIGGERS,
  type CoreResult,
  type ErrorCode,
  type Operation,
  type Service,
  type Trigger,
} from "./report";

export const ANALYTICS_SETTINGS_KEY = "unidock.analytics.v2";
export const ANALYTICS_STATE_KEY = "unidock.analytics-counters.v1";
/** PostHog-era consent with a random install UUID; removed on migration. */
export const LEGACY_ANALYTICS_KEY = "unidock.analytics.v1";
export const ANALYTICS_ALARM = "unidock.analytics.flush";

export type AnalyticsNotice = "first_run" | "changed";
export interface AnalyticsSettings {
  version: 2;
  enabled: boolean;
  /** Pending notice; collection starts only after the panel has shown it. */
  notice: AnalyticsNotice | null;
}
export interface AnalyticsStatus {
  available: boolean;
  enabled: boolean;
  notice: AnalyticsNotice | null;
}

export const SCREEN_SERVICES = {
  COURSES_LIST: "courses",
  ASSIGNMENTS_LIST: "courses",
  RECORDINGS_LIST: "courses",
  DOCUMENTS_LIST: "courses",
  TODO_LIST: "tasks",
  UPCOMING_LIST: "tasks",
  PLAYBACK: "playback",
  CAPTIONS: "captions",
  INFO: "settings",
} as const satisfies Record<string, Service>;
export type AnalyticsScreen = keyof typeof SCREEN_SERVICES;

export type AnalyticsSignal =
  | { kind: "service"; service: Service }
  | { kind: "core"; result: CoreResult }
  | { kind: "op_start"; operation: Operation; trigger: Trigger }
  | {
      kind: "op_end";
      operation: Operation;
      trigger: Trigger;
      outcome: "success";
      duration_ms: number;
    }
  | {
      kind: "op_end";
      operation: Operation;
      trigger: Trigger;
      outcome: "failure";
      error: ErrorCode;
    }
  | {
      kind: "op_end";
      operation: Operation;
      trigger: Trigger;
      outcome: "timeout" | "cancel";
    };

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function member(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}
export function isAnalyticsSignal(value: unknown): value is AnalyticsSignal {
  if (!record(value)) return false;
  const size = Object.keys(value).length;
  switch (value.kind) {
    case "service":
      return size === 2 && member(SERVICES, value.service);
    case "core":
      return size === 2 && member(CORE_RESULTS, value.result);
    case "op_start":
      return (
        size === 3 &&
        member(OPERATIONS, value.operation) &&
        member(TRIGGERS, value.trigger)
      );
    case "op_end": {
      if (
        !member(OPERATIONS, value.operation) ||
        !member(TRIGGERS, value.trigger)
      )
        return false;
      if (value.outcome === "success")
        return (
          size === 5 &&
          Number.isInteger(value.duration_ms) &&
          (value.duration_ms as number) >= 0 &&
          (value.duration_ms as number) <= MAX_DURATION_MS
        );
      if (value.outcome === "failure")
        return size === 5 && member(ERROR_CODES, value.error);
      return size === 4 && member(["timeout", "cancel"], value.outcome);
    }
    default:
      return false;
  }
}

export type AnalyticsCommand =
  | { version: 1; type: "ANALYTICS_STATUS" }
  | { version: 1; type: "ANALYTICS_SET"; enabled: boolean }
  | { version: 1; type: "ANALYTICS_NOTICE_SHOWN" }
  | { version: 1; type: "ANALYTICS_SIGNAL"; signal: AnalyticsSignal };
export function isAnalyticsCommand(value: unknown): value is AnalyticsCommand {
  if (!record(value) || value.version !== 1) return false;
  const size = Object.keys(value).length;
  switch (value.type) {
    case "ANALYTICS_STATUS":
    case "ANALYTICS_NOTICE_SHOWN":
      return size === 2;
    case "ANALYTICS_SET":
      return size === 3 && typeof value.enabled === "boolean";
    case "ANALYTICS_SIGNAL":
      return size === 3 && isAnalyticsSignal(value.signal);
    default:
      return false;
  }
}
export function isAnalyticsSettings(
  value: unknown,
): value is AnalyticsSettings {
  return (
    record(value) &&
    Object.keys(value).length === 3 &&
    value.version === 2 &&
    typeof value.enabled === "boolean" &&
    (value.notice === null ||
      value.notice === "first_run" ||
      value.notice === "changed")
  );
}
export function isAnalyticsStatus(value: unknown): value is AnalyticsStatus {
  return (
    record(value) &&
    Object.keys(value).length === 3 &&
    typeof value.available === "boolean" &&
    typeof value.enabled === "boolean" &&
    (value.notice === null ||
      value.notice === "first_run" ||
      value.notice === "changed")
  );
}
export function collecting(status: AnalyticsStatus): boolean {
  return status.available && status.enabled && status.notice === null;
}
