// GA4 projection of collector totals. Used only by the collector server and
// the GA4 setup/report scripts; the extension never talks to Google.
import {
  DAY_MS,
  parseDims,
  seoulDayStart,
  type Metric,
  type Row,
} from "./report.ts";

export const GA_EVENTS = {
  activity: "ud_activity_agg",
  core: "ud_core_agg",
  service: "ud_service_agg",
  operation: "ud_operation_agg",
  error: "ud_error_agg",
  latency: "ud_latency_agg",
  pipeline: "ud_pipeline_agg",
} as const;
export type GaEventName = (typeof GA_EVENTS)[keyof typeof GA_EVENTS];

const DIMENSION_PARAMS: Record<string, string> = {
  core_result: "ud_core_result",
  service: "ud_service",
  operation: "ud_operation",
  trigger: "ud_trigger",
  version: "ud_extension_version",
  error_code: "ud_error_code",
  bucket: "ud_latency_bucket",
  status: "ud_pipeline_status",
};
const METRIC_TARGETS: Record<Metric, { event: GaEventName; param: string }> = {
  active_installs: { event: GA_EVENTS.activity, param: "ud_active_installs" },
  core_installs: { event: GA_EVENTS.activity, param: "ud_core_installs" },
  core_results: { event: GA_EVENTS.core, param: "ud_core_results" },
  service_entries: { event: GA_EVENTS.service, param: "ud_service_entries" },
  service_installs: { event: GA_EVENTS.service, param: "ud_service_installs" },
  op_started: { event: GA_EVENTS.operation, param: "ud_op_started" },
  op_success: { event: GA_EVENTS.operation, param: "ud_op_success" },
  op_failure: { event: GA_EVENTS.operation, param: "ud_op_failure" },
  op_timeout: { event: GA_EVENTS.operation, param: "ud_op_timeout" },
  op_cancel: { event: GA_EVENTS.operation, param: "ud_op_cancel" },
  op_duration_ms_sum: {
    event: GA_EVENTS.operation,
    param: "ud_duration_ms_sum",
  },
  op_duration_count: { event: GA_EVENTS.operation, param: "ud_duration_count" },
  op_errors: { event: GA_EVENTS.error, param: "ud_op_errors" },
  op_latency: { event: GA_EVENTS.latency, param: "ud_latency_count" },
  pipeline_reports: { event: GA_EVENTS.pipeline, param: "ud_pipeline_reports" },
};

export interface GaDefinition {
  parameterName: string;
  displayName: string;
  description: string;
}
export const CUSTOM_DIMENSIONS: readonly GaDefinition[] = [
  {
    parameterName: "ud_service",
    displayName: "UD service",
    description:
      "uniDock service code (courses/tasks/playback/captions/settings)",
  },
  {
    parameterName: "ud_core_result",
    displayName: "UD core result",
    description: "Fixed core-value result code",
  },
  {
    parameterName: "ud_operation",
    displayName: "UD operation",
    description: "Fixed logical operation code",
  },
  {
    parameterName: "ud_trigger",
    displayName: "UD trigger",
    description: "user or auto",
  },
  {
    parameterName: "ud_extension_version",
    displayName: "UD extension version",
    description: "Extension version (operation events only)",
  },
  {
    parameterName: "ud_error_code",
    displayName: "UD error code",
    description: "Fixed error code",
  },
  {
    parameterName: "ud_latency_bucket",
    displayName: "UD latency bucket",
    description: "Fixed duration bucket of successful operations",
  },
  {
    parameterName: "ud_pipeline_status",
    displayName: "UD pipeline status",
    description: "Collector reception status",
  },
];
export const CUSTOM_METRICS: readonly GaDefinition[] = [
  {
    parameterName: "ud_active_installs",
    displayName: "UD active installs",
    description:
      "Installs that used the foreground panel on the date (one per install per date)",
  },
  {
    parameterName: "ud_core_installs",
    displayName: "UD core installs",
    description:
      "Active installs that observed a core result on the date (one per install per date)",
  },
  {
    parameterName: "ud_core_results",
    displayName: "UD core results",
    description: "Core results observed in the foreground panel",
  },
  {
    parameterName: "ud_service_entries",
    displayName: "UD service entries",
    description: "Entries into a service",
  },
  {
    parameterName: "ud_service_installs",
    displayName: "UD service installs",
    description:
      "Installs that entered the service on the date (one per install per service per date)",
  },
  {
    parameterName: "ud_op_started",
    displayName: "UD operations started",
    description: "Logical operations started (by start date)",
  },
  {
    parameterName: "ud_op_success",
    displayName: "UD operations succeeded",
    description: "Final success (by completion date)",
  },
  {
    parameterName: "ud_op_failure",
    displayName: "UD operations failed",
    description: "Final failure (by completion date)",
  },
  {
    parameterName: "ud_op_timeout",
    displayName: "UD operations timed out",
    description: "Final timeout (by completion date)",
  },
  {
    parameterName: "ud_op_cancel",
    displayName: "UD operations cancelled",
    description: "Final user cancel (by completion date)",
  },
  {
    parameterName: "ud_duration_ms_sum",
    displayName: "UD duration ms sum",
    description: "Sum of successful operation durations in milliseconds",
  },
  {
    parameterName: "ud_duration_count",
    displayName: "UD duration samples",
    description: "Successful operations with a duration sample",
  },
  {
    parameterName: "ud_op_errors",
    displayName: "UD operation errors",
    description: "Failures and timeouts per fixed error code",
  },
  {
    parameterName: "ud_latency_count",
    displayName: "UD latency bucket count",
    description: "Successful operations per duration bucket",
  },
  {
    parameterName: "ud_pipeline_reports",
    displayName: "UD pipeline reports",
    description: "Reports received by the collector per status",
  },
];

export interface GaEvent {
  name: GaEventName;
  params: Record<string, string | number>;
  /** Ledger rows whose delta this event carries. */
  rows: Row[];
}
/** Groups non-zero rows into one GA event per (event name, dimension values). */
export function rowsToGaEvents(rows: readonly Row[]): GaEvent[] {
  const events = new Map<string, GaEvent>();
  for (const row of rows) {
    if (row.value <= 0) continue;
    const target = METRIC_TARGETS[row.metric];
    const key = `${target.event}#${row.dims}`;
    let event = events.get(key);
    if (!event) {
      const params: Record<string, string | number> = {};
      for (const [dim, value] of Object.entries(parseDims(row.dims))) {
        const param = DIMENSION_PARAMS[dim];
        if (!param) throw new Error("UNKNOWN_DIMENSION");
        params[param] = value;
      }
      event = { name: target.event, params, rows: [] };
      events.set(key, event);
    }
    event.params[target.param] =
      Number(event.params[target.param] ?? 0) + row.value;
    event.rows.push(row);
  }
  return [...events.values()];
}

/** GA4 Measurement Protocol accepts timestamps up to 72 hours in the past. */
export const GA_MAX_BACKDATE_MS = 72 * 3_600_000;
const GA_SAFETY_MS = 3_600_000;
/**
 * A timestamp inside the Seoul date (reported by the property's Asia/Seoul
 * time zone) that GA still accepts, or null when the date can no longer be
 * exported without being misattributed to another day.
 */
export function gaTimestampMs(date: string, now: number): number | null {
  const start = seoulDayStart(date);
  const end = start + DAY_MS - 1_000;
  const earliest = now - GA_MAX_BACKDATE_MS + GA_SAFETY_MS;
  const ts = Math.min(end, now, Math.max(start + DAY_MS / 2, earliest));
  return ts < start || ts < earliest || ts > now ? null : ts;
}
export const GA_MAX_EVENTS_PER_REQUEST = 25;

/**
 * GA4 Data API runReport queries that read the aggregates back. Metrics are
 * `customEvent:` SUMs of the registered custom metrics, never eventCount: one
 * event can carry, for example, 200 service entries.
 */
export interface DataApiQuery {
  event: GaEventName;
  dimensions: string[];
  metrics: { param: string; metric: Metric }[];
}
const OP_DIMS = ["ud_operation", "ud_trigger", "ud_extension_version"];
export const DATA_API_QUERIES: readonly DataApiQuery[] = [
  {
    event: GA_EVENTS.activity,
    dimensions: [],
    metrics: [
      { param: "ud_active_installs", metric: "active_installs" },
      { param: "ud_core_installs", metric: "core_installs" },
    ],
  },
  {
    event: GA_EVENTS.core,
    dimensions: ["ud_core_result"],
    metrics: [{ param: "ud_core_results", metric: "core_results" }],
  },
  {
    event: GA_EVENTS.service,
    dimensions: ["ud_service"],
    metrics: [
      { param: "ud_service_entries", metric: "service_entries" },
      { param: "ud_service_installs", metric: "service_installs" },
    ],
  },
  {
    event: GA_EVENTS.operation,
    dimensions: OP_DIMS,
    metrics: [
      { param: "ud_op_started", metric: "op_started" },
      { param: "ud_op_success", metric: "op_success" },
      { param: "ud_op_failure", metric: "op_failure" },
      { param: "ud_op_timeout", metric: "op_timeout" },
      { param: "ud_op_cancel", metric: "op_cancel" },
      { param: "ud_duration_ms_sum", metric: "op_duration_ms_sum" },
      { param: "ud_duration_count", metric: "op_duration_count" },
    ],
  },
  {
    event: GA_EVENTS.error,
    dimensions: [...OP_DIMS, "ud_error_code"],
    metrics: [{ param: "ud_op_errors", metric: "op_errors" }],
  },
  {
    event: GA_EVENTS.latency,
    dimensions: [...OP_DIMS, "ud_latency_bucket"],
    metrics: [{ param: "ud_latency_count", metric: "op_latency" }],
  },
  {
    event: GA_EVENTS.pipeline,
    dimensions: ["ud_pipeline_status"],
    metrics: [{ param: "ud_pipeline_reports", metric: "pipeline_reports" }],
  },
];
export function runReportBody(
  query: DataApiQuery,
  startDate: string,
  endDate: string,
) {
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: ["date", ...query.dimensions].map((name) =>
      name === "date" ? { name } : { name: `customEvent:${name}` },
    ),
    metrics: query.metrics.map(({ param }) => ({
      name: `customEvent:${param}`,
    })),
    dimensionFilter: {
      filter: {
        fieldName: "eventName",
        stringFilter: { matchType: "EXACT", value: query.event },
      },
    },
    limit: 100000,
  };
}
const PARAM_DIMENSIONS = Object.fromEntries(
  Object.entries(DIMENSION_PARAMS).map(([dim, param]) => [param, dim]),
);
/** Converts a runReport response back into dated ledger rows. */
export function runReportRows(
  query: DataApiQuery,
  response: {
    rows?: {
      dimensionValues?: { value?: string }[];
      metricValues?: { value?: string }[];
    }[];
  },
): (Row & { date: string })[] {
  const rows: (Row & { date: string })[] = [];
  for (const row of response.rows ?? []) {
    const values = (row.dimensionValues ?? []).map((v) => v.value ?? "");
    const raw = values[0] ?? "";
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    const key = query.dimensions
      .map(
        (param, index) =>
          `${PARAM_DIMENSIONS[param]}=${values[index + 1] ?? ""}`,
      )
      .join("|");
    query.metrics.forEach(({ metric }, index) => {
      const value = Number(row.metricValues?.[index]?.value ?? 0);
      if (value) rows.push({ date, metric, dims: key, value });
    });
  }
  return rows;
}
