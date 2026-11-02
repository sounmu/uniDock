// Turns dated ledger rows (from the collector or from GA4 Data API sums) into
// the product report. Pure and shared by tests and scripts/ga4-report.mjs.
import {
  LATENCY_KEYS,
  LEARNING_SERVICES,
  addDays,
  parseDims,
  type LatencyBucket,
  type Metric,
  type Row,
  type Trigger,
} from "./report.ts";
import {
  approxP95Ms,
  cancelRate,
  dailyShares,
  movingAverage7,
  periodRatio,
  ratio,
  sameWeekdayLastWeek,
  successRate,
  weightedMeanMs,
} from "./metrics.ts";

export interface DatedRow extends Row {
  date: string;
}
export interface OperationSummary {
  operation: string;
  version: string | null;
  started: number;
  success: number;
  failure: number;
  timeout: number;
  cancel: number;
  successRate: number | null;
  cancelRate: number | null;
  meanMs: number | null;
  p95Ms: number | null;
  samples: number;
  errors: Record<string, number>;
}

export function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

export function summarize(
  rows: readonly DatedRow[],
  from: string,
  to: string,
  trigger: Trigger = "user",
) {
  const dates = dateRange(from, to);
  const inRange = rows.filter((row) => row.date >= from && row.date <= to);
  const total = (
    metric: Metric,
    date?: string,
    match: (dims: Record<string, string>) => boolean = () => true,
    source: readonly DatedRow[] = inRange,
  ) =>
    source
      .filter(
        (row) =>
          row.metric === metric &&
          (date === undefined || row.date === date) &&
          match(parseDims(row.dims)),
      )
      .reduce((sum, row) => sum + row.value, 0);
  const series = (metric: Metric) => {
    const map = new Map<string, number>();
    for (const row of rows)
      if (row.metric === metric)
        map.set(row.date, (map.get(row.date) ?? 0) + row.value);
    return map;
  };
  const active = series("active_installs");

  const overview = dates.map((date) => {
    const installs = total("active_installs", date);
    const core = total("core_installs", date);
    return {
      date,
      activeInstalls: active.has(date) ? installs : null,
      coreInstalls: core,
      coreRate: ratio(core, installs),
      coreResults: total("core_results", date),
      activeMovingAverage7: movingAverage7(active, date),
      ...sameWeekdayLastWeek(active, date),
    };
  });
  const periodActive = total("active_installs");
  const periodCore = total("core_installs");

  const learning = LEARNING_SERVICES as readonly string[];
  const entryRows = inRange
    .filter((row) => row.metric === "service_entries")
    .map((row) => ({
      date: row.date,
      service: parseDims(row.dims).service ?? "",
      entries: row.value,
    }));
  const shares = dailyShares(entryRows, learning);
  const byService = (service: string) => (dims: Record<string, string>) =>
    dims.service === service;
  const features = {
    daily: dates.map((date) => ({
      date,
      services: learning.map((service) => {
        const entries = total("service_entries", date, byService(service));
        const installs = total("service_installs", date, byService(service));
        return {
          service,
          entries,
          share: shares.get(date)?.get(service) ?? null,
          installs,
          reach: ratio(installs, total("active_installs", date)),
          intensity: ratio(entries, installs),
        };
      }),
    })),
    period: learning.map((service) => {
      const entries = total("service_entries", undefined, byService(service));
      const installs = total("service_installs", undefined, byService(service));
      return {
        service,
        entries,
        share: periodRatio([
          {
            numerator: entries,
            denominator: total("service_entries", undefined, (dims) =>
              learning.includes(dims.service ?? ""),
            ),
          },
        ]),
        installDays: installs,
        reach: ratio(installs, periodActive),
        intensity: ratio(entries, installs),
      };
    }),
    settingsEntries: total("service_entries", undefined, byService("settings")),
  };

  const opKeys = new Set<string>();
  for (const row of inRange) {
    if (!row.metric.startsWith("op_")) continue;
    const dims = parseDims(row.dims);
    if (dims.trigger === trigger && dims.operation)
      opKeys.add(`${dims.operation}|${dims.version ?? ""}`);
  }
  const operation = (
    name: string,
    version: string | null,
  ): OperationSummary => {
    const match = (dims: Record<string, string>) =>
      dims.operation === name &&
      dims.trigger === trigger &&
      (version === null || dims.version === version);
    const counts = {
      success: total("op_success", undefined, match),
      failure: total("op_failure", undefined, match),
      timeout: total("op_timeout", undefined, match),
      cancel: total("op_cancel", undefined, match),
    };
    const buckets: Partial<Record<LatencyBucket, number>> = {};
    for (const bucket of LATENCY_KEYS)
      buckets[bucket] = total(
        "op_latency",
        undefined,
        (dims) => match(dims) && dims.bucket === bucket,
      );
    const errors: Record<string, number> = {};
    for (const row of inRange)
      if (row.metric === "op_errors") {
        const dims = parseDims(row.dims);
        if (match(dims) && dims.error_code)
          errors[dims.error_code] = (errors[dims.error_code] ?? 0) + row.value;
      }
    const samples = total("op_duration_count", undefined, match);
    return {
      operation: name,
      version,
      started: total("op_started", undefined, match),
      ...counts,
      successRate: successRate(counts),
      cancelRate: cancelRate(counts),
      meanMs: weightedMeanMs(
        total("op_duration_ms_sum", undefined, match),
        samples,
      ),
      p95Ms: approxP95Ms(buckets),
      samples,
      errors,
    };
  };
  const operationNames = [
    ...new Set([...opKeys].map((key) => key.split("|")[0]!)),
  ].sort();
  const quality = {
    trigger,
    operations: operationNames.map((name) => operation(name, null)),
    byVersion: [...opKeys].sort().map((key) => {
      const [name, version] = key.split("|") as [string, string];
      return operation(name, version);
    }),
  };

  const pipeline = dates.map((date) => {
    const statuses: Record<string, number> = {};
    for (const row of inRange)
      if (row.metric === "pipeline_reports" && row.date === date) {
        const status = parseDims(row.dims).status ?? "";
        statuses[status] = (statuses[status] ?? 0) + row.value;
      }
    return { date, statuses };
  });

  return {
    from,
    to,
    overview,
    period: {
      activeInstallDays: periodActive,
      coreInstallDays: periodCore,
      coreRate: ratio(periodCore, periodActive),
      coreResults: total("core_results"),
    },
    features,
    quality,
    pipeline,
  };
}
export type ProductSummary = ReturnType<typeof summarize>;
