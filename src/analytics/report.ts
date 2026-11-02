// Shared, dependency-free wire contract for aggregate usage reports.
// Imported by the extension background, the collector server and the GA4
// scripts, so it must not reference browser globals or build flags.
// Every value is a closed code, a bounded integer or a Seoul calendar date:
// a report cannot carry LMS data, URLs, free text or install identifiers.

export const SERVICES = [
  "courses",
  "tasks",
  "playback",
  "captions",
  "settings",
] as const;
export type Service = (typeof SERVICES)[number];
/** Share/reach denominators use learning services only; settings is excluded. */
export const LEARNING_SERVICES = [
  "courses",
  "tasks",
  "playback",
  "captions",
] as const satisfies readonly Service[];

/** Meaningful outcomes observed in the foreground panel (core value). */
export const CORE_RESULTS = [
  "tasks_shown",
  "course_items_shown",
  "recording_opened",
  "document_opened",
  "document_downloaded",
  "captions_exported",
  "ai_captions_exported",
  "playback_started",
] as const;
export type CoreResult = (typeof CORE_RESULTS)[number];

export const OPERATIONS = [
  "courses_load",
  "course_items_load",
  "tasks_load",
  "recording_open",
  "document_open",
  "document_download",
  "captions_detect",
  "captions_export",
  "ai_captions_generate",
  "ai_captions_export",
  "ai_handoff",
  "playback_start",
  "playback_refresh",
] as const;
export type Operation = (typeof OPERATIONS)[number];

/** user = started by an explicit panel action; auto = started by the panel itself. */
export const TRIGGERS = ["user", "auto"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const OUTCOMES = ["success", "failure", "timeout", "cancel"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Fixed error codes. Anything else is reported as OTHER; raw errors never leave. */
export const ERROR_CODES = [
  // LMS query protocol (src/protocol.ts `errors`)
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
  "DOWNLOAD_FAILED",
  "RATE_LIMITED",
  // Captions, downloads, playback, AI captions
  "ACTIVATE_TAB",
  "NO_CAPTIONS",
  "UNSAFE_CAPTION",
  "PARTIAL",
  "INTERRUPTED",
  "MIME_MISMATCH",
  "COPY_FAILED",
  "PERMISSION",
  "UPLOAD",
  "TOO_LARGE",
  "SERVER",
  "AUTH",
  "EXPIRED",
  "PLAYBACK",
  "OTHER",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export function errorCode(value: unknown): ErrorCode {
  return typeof value === "string" &&
    (ERROR_CODES as readonly string[]).includes(value)
    ? (value as ErrorCode)
    : "OTHER";
}

/** Fixed latency buckets for successful logical operations (upper bound exclusive). */
export const LATENCY_BUCKETS = [
  { key: "lt1s", maxMs: 1_000 },
  { key: "1to3s", maxMs: 3_000 },
  { key: "3to10s", maxMs: 10_000 },
  { key: "10to30s", maxMs: 30_000 },
  { key: "30to60s", maxMs: 60_000 },
  { key: "1to3m", maxMs: 180_000 },
  { key: "3to10m", maxMs: 600_000 },
  { key: "10to30m", maxMs: 1_800_000 },
  { key: "30to120m", maxMs: 7_200_000 },
  { key: "ge120m", maxMs: Number.POSITIVE_INFINITY },
] as const;
export type LatencyBucket = (typeof LATENCY_BUCKETS)[number]["key"];
export const LATENCY_KEYS = LATENCY_BUCKETS.map(
  (bucket) => bucket.key,
) as readonly LatencyBucket[];
/** Longer durations are still counted as outcomes but not as latency samples. */
export const MAX_DURATION_MS = 86_400_000;
export function latencyBucket(ms: number): LatencyBucket {
  for (const bucket of LATENCY_BUCKETS)
    if (ms < bucket.maxMs) return bucket.key;
  return "ge120m";
}

export const REPORT_SCHEMA = 1;
export const MAX_REPORT_BYTES = 8192;
export const MAX_COUNT = 100_000;
/** Reports older than this (by Seoul date) are dropped locally and rejected as expired. */
export const REPORT_MAX_AGE_DAYS = 7;
/** Duplicate-suppression markers outlive the oldest acceptable resend. */
export const REPORT_ID_RETENTION_DAYS = 10;

export interface OperationCounters {
  started: number;
  success: number;
  failure: number;
  timeout: number;
  cancel: number;
  /** Fixed error code per failure/timeout; sums to failure + timeout. */
  errors: Partial<Record<ErrorCode, number>>;
  /** Successful operations only. */
  duration_ms_sum: number;
  duration_count: number;
  /** Sums to duration_count. */
  buckets: Partial<Record<LatencyBucket, number>>;
}
export type OperationTable = Partial<
  Record<Operation, Partial<Record<Trigger, OperationCounters>>>
>;
/** One install's unreported delta for one Seoul date. */
export interface DailyCounters {
  active_installs: 0 | 1;
  core_installs: 0 | 1;
  core_results: Partial<Record<CoreResult, number>>;
  service_entries: Partial<Record<Service, number>>;
  service_installs: Partial<Record<Service, 0 | 1>>;
  operations: OperationTable;
}
export interface DailyReport extends DailyCounters {
  schema: typeof REPORT_SCHEMA;
  /** One-use random UUID; never reused and never an install identifier. */
  report_id: string;
  /** Asia/Seoul calendar date the counted activity happened on. */
  date: string;
  extension_version: string;
}

export function emptyCounters(): DailyCounters {
  return {
    active_installs: 0,
    core_installs: 0,
    core_results: {},
    service_entries: {},
    service_installs: {},
    operations: {},
  };
}
export function emptyOperation(): OperationCounters {
  return {
    started: 0,
    success: 0,
    failure: 0,
    timeout: 0,
    cancel: 0,
    errors: {},
    duration_ms_sum: 0,
    duration_count: 0,
    buckets: {},
  };
}
export function isEmptyCounters(counters: DailyCounters): boolean {
  return reportRows(counters).length === 0;
}

// Asia/Seoul is a fixed UTC+9 offset with no daylight saving time.
export const SEOUL_OFFSET_MS = 9 * 3_600_000;
export const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function seoulDate(epochMs: number): string {
  return new Date(epochMs + SEOUL_OFFSET_MS).toISOString().slice(0, 10);
}
export function seoulDayStart(date: string): number {
  return Date.parse(`${date}T00:00:00.000+09:00`);
}
export function addDays(date: string, days: number): string {
  return seoulDate(seoulDayStart(date) + days * DAY_MS);
}
export function isSeoulDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    DATE.test(value) &&
    Number.isFinite(seoulDayStart(value)) &&
    seoulDate(seoulDayStart(value)) === value
  );
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^\d{1,4}(?:\.\d{1,5}){1,3}$/;
function plain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function count(value: unknown, max = MAX_COUNT): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max
  );
}
function flag(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}
function closedMap(
  value: unknown,
  keys: readonly string[],
  valid: (entry: unknown) => boolean,
): boolean {
  if (!plain(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) => keys.includes(key) && valid(entry),
  );
}
function sum(map: Record<string, number | undefined>): number {
  let total = 0;
  for (const value of Object.values(map)) total += value ?? 0;
  return total;
}
function validOperation(value: unknown): boolean {
  if (!plain(value)) return false;
  const keys = [
    "started",
    "success",
    "failure",
    "timeout",
    "cancel",
    "errors",
    "duration_ms_sum",
    "duration_count",
    "buckets",
  ];
  if (Object.keys(value).length !== keys.length) return false;
  if (!keys.every((key) => key in value)) return false;
  const op = value as unknown as OperationCounters;
  return (
    count(op.started) &&
    count(op.success) &&
    count(op.failure) &&
    count(op.timeout) &&
    count(op.cancel) &&
    closedMap(op.errors, ERROR_CODES, (entry) => count(entry)) &&
    count(op.duration_count) &&
    op.duration_count <= op.success &&
    count(
      op.duration_ms_sum,
      Math.max(0, op.duration_count) * MAX_DURATION_MS,
    ) &&
    closedMap(op.buckets, LATENCY_KEYS, (entry) => count(entry)) &&
    sum(op.buckets) === op.duration_count &&
    sum(op.errors) === op.failure + op.timeout &&
    (op.errors.TIMEOUT ?? 0) >= op.timeout
  );
}
export function isDailyCounters(value: unknown): value is DailyCounters {
  if (!plain(value)) return false;
  return (
    flag(value.active_installs) &&
    flag(value.core_installs) &&
    closedMap(value.core_results, CORE_RESULTS, (entry) => count(entry)) &&
    closedMap(value.service_entries, SERVICES, (entry) => count(entry)) &&
    closedMap(value.service_installs, SERVICES, flag) &&
    closedMap(value.operations, OPERATIONS, (byTrigger) =>
      closedMap(byTrigger, TRIGGERS, validOperation),
    )
  );
}
const REPORT_KEYS = [
  "schema",
  "report_id",
  "date",
  "extension_version",
  "active_installs",
  "core_installs",
  "core_results",
  "service_entries",
  "service_installs",
  "operations",
];
export function isDailyReport(value: unknown): value is DailyReport {
  return (
    plain(value) &&
    Object.keys(value).length === REPORT_KEYS.length &&
    REPORT_KEYS.every((key) => key in value) &&
    value.schema === REPORT_SCHEMA &&
    typeof value.report_id === "string" &&
    UUID.test(value.report_id) &&
    isSeoulDate(value.date) &&
    typeof value.extension_version === "string" &&
    VERSION.test(value.extension_version) &&
    isDailyCounters(value)
  );
}

export type Metric =
  | "active_installs"
  | "core_installs"
  | "core_results"
  | "service_entries"
  | "service_installs"
  | "op_started"
  | "op_success"
  | "op_failure"
  | "op_timeout"
  | "op_cancel"
  | "op_duration_ms_sum"
  | "op_duration_count"
  | "op_errors"
  | "op_latency"
  | "pipeline_reports";
export interface Row {
  metric: Metric;
  /** Canonical `key=value|key=value` string of closed codes, or "". */
  dims: string;
  value: number;
}
export function dims(entries: readonly (readonly [string, string])[]): string {
  return entries.map(([key, value]) => `${key}=${value}`).join("|");
}
export function parseDims(value: string): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    value.split("|").map((part) => {
      const at = part.indexOf("=");
      return [part.slice(0, at), part.slice(at + 1)];
    }),
  );
}
/** Non-zero rows only. Version is attached to operation rows only. */
export function reportRows(counters: DailyCounters, version = ""): Row[] {
  const rows: Row[] = [];
  const push = (metric: Metric, key: string, value: number | undefined) => {
    if (value) rows.push({ metric, dims: key, value });
  };
  push("active_installs", "", counters.active_installs);
  push("core_installs", "", counters.core_installs);
  for (const result of CORE_RESULTS)
    push(
      "core_results",
      dims([["core_result", result]]),
      counters.core_results[result],
    );
  for (const service of SERVICES) {
    const key = dims([["service", service]]);
    push("service_entries", key, counters.service_entries[service]);
    push("service_installs", key, counters.service_installs[service]);
  }
  for (const operation of OPERATIONS)
    for (const trigger of TRIGGERS) {
      const op = counters.operations[operation]?.[trigger];
      if (!op) continue;
      const base: [string, string][] = [
        ["operation", operation],
        ["trigger", trigger],
        ["version", version],
      ];
      const key = dims(base);
      push("op_started", key, op.started);
      push("op_success", key, op.success);
      push("op_failure", key, op.failure);
      push("op_timeout", key, op.timeout);
      push("op_cancel", key, op.cancel);
      push("op_duration_ms_sum", key, op.duration_ms_sum);
      push("op_duration_count", key, op.duration_count);
      for (const code of ERROR_CODES)
        push(
          "op_errors",
          dims([...base, ["error_code", code]]),
          op.errors[code],
        );
      for (const bucket of LATENCY_KEYS)
        push(
          "op_latency",
          dims([...base, ["bucket", bucket]]),
          op.buckets[bucket],
        );
    }
  return rows;
}

/** Collector reception status, keyed by the Seoul date the server received it. */
export const PIPELINE_STATUSES = [
  "accepted",
  "accepted_late",
  "duplicate",
  "invalid",
  "expired",
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];
