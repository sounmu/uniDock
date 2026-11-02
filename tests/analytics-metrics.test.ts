import { expect, it } from "vitest";
import {
  approxP95Ms,
  cancelRate,
  dailyShares,
  formatRatio,
  movingAverage7,
  periodRatio,
  ratio,
  sameWeekdayLastWeek,
  successRate,
  weightedMeanMs,
} from "../src/analytics/metrics";
import {
  DATA_API_QUERIES,
  gaTimestampMs,
  rowsToGaEvents,
  runReportBody,
  runReportRows,
} from "../src/analytics/ga4";
import { summarize } from "../src/analytics/summary";
import {
  FIXTURE_FROM,
  FIXTURE_ROWS,
  FIXTURE_TO,
} from "../scripts/analytics-fixture";
import {
  LEARNING_SERVICES,
  emptyCounters,
  latencyBucket,
  reportRows,
  seoulDate,
  seoulDayStart,
} from "../src/analytics/report";

it("computes daily shares with each date's own learning-service denominator", () => {
  const shares = dailyShares(
    [
      { date: "2026-11-01", service: "courses", entries: 7 },
      { date: "2026-11-01", service: "tasks", entries: 3 },
      { date: "2026-11-01", service: "settings", entries: 50 },
      { date: "2026-11-02", service: "courses", entries: 2 },
      { date: "2026-11-02", service: "tasks", entries: 8 },
    ],
    LEARNING_SERVICES,
  );
  expect(Object.fromEntries(shares.get("2026-11-01")!)).toEqual({
    courses: 0.7,
    tasks: 0.3,
  });
  expect(Object.fromEntries(shares.get("2026-11-02")!)).toEqual({
    courses: 0.2,
    tasks: 0.8,
  });
});

it("computes reach, rates, weighted latency and N/A for empty denominators", () => {
  expect(ratio(6, 10)).toBe(0.6);
  expect(ratio(5, 10)).toBe(0.5);
  const outcomes = { success: 8, failure: 1, timeout: 1, cancel: 2 };
  expect(successRate(outcomes)).toBe(0.8);
  expect(cancelRate(outcomes)).toBe(2 / 12);
  expect(ratio(1, 0)).toBeNull();
  expect(formatRatio(ratio(1, 0))).toBe("N/A");
  expect(weightedMeanMs(1_000 + 9_000, 2)).toBe(5_000);
  // Period ratio is not the mean of daily ratios (1/1 and 0/9 -> 10%, not 50%).
  expect(
    periodRatio([
      { numerator: 1, denominator: 1 },
      { numerator: 0, denominator: 9 },
    ]),
  ).toBe(0.1);
});

it("derives approximate p95 from fixed buckets, never from the mean", () => {
  expect(approxP95Ms({ lt1s: 90, "3to10s": 10 })).toBe(10_000);
  expect(approxP95Ms({ lt1s: 96, ge120m: 4 })).toBe(1_000);
  expect(approxP95Ms({})).toBeNull();
  expect(latencyBucket(999)).toBe("lt1s");
  expect(latencyBucket(1_000)).toBe("1to3s");
});

it("builds 7-day moving averages and same-weekday comparisons only from present dates", () => {
  const series = new Map<string, number>();
  for (let day = 1; day <= 14; day++)
    series.set(`2026-11-${String(day).padStart(2, "0")}`, day);
  expect(movingAverage7(series, "2026-11-14")).toBe((8 + 14) / 2);
  expect(movingAverage7(series, "2026-11-06")).toBeNull();
  expect(sameWeekdayLastWeek(series, "2026-11-14")).toEqual({
    previous: 7,
    change: 1,
  });
});

it("keeps 200 uses in one aggregate event as a metric value of 200", () => {
  const counters = emptyCounters();
  counters.service_entries.courses = 200;
  const events = rowsToGaEvents(reportRows(counters));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    name: "ud_service_agg",
    params: { ud_service: "courses", ud_service_entries: 200 },
  });
});

it("attaches the extension version only to operation events", () => {
  const counters = emptyCounters();
  counters.active_installs = 1;
  counters.operations.captions_export = {
    user: {
      started: 1,
      success: 1,
      failure: 0,
      timeout: 0,
      cancel: 0,
      errors: {},
      duration_ms_sum: 500,
      duration_count: 1,
      buckets: { lt1s: 1 },
    },
  };
  const events = rowsToGaEvents(reportRows(counters, "0.5.0"));
  const activity = events.find((e) => e.name === "ud_activity_agg")!;
  const operation = events.find((e) => e.name === "ud_operation_agg")!;
  expect(activity.params).toEqual({ ud_active_installs: 1 });
  expect(operation.params).toMatchObject({
    ud_operation: "captions_export",
    ud_trigger: "user",
    ud_extension_version: "0.5.0",
    ud_op_success: 1,
    ud_duration_ms_sum: 500,
  });
});

it("produces the documented report values from the synthetic ledger", () => {
  const summary = summarize(FIXTURE_ROWS, FIXTURE_FROM, FIXTURE_TO);
  const day = (date: string, service: string) =>
    summary.features.daily
      .find((d) => d.date === date)!
      .services.find((s) => s.service === service)!;
  expect([
    day("2026-11-01", "courses").share,
    day("2026-11-01", "tasks").share,
  ]).toEqual([0.7, 0.3]);
  expect([
    day("2026-11-02", "courses").share,
    day("2026-11-02", "tasks").share,
  ]).toEqual([0.2, 0.8]);
  expect([
    day("2026-11-01", "courses").reach,
    day("2026-11-01", "tasks").reach,
  ]).toEqual([0.6, 0.5]);
  expect(summary.period.coreRate).toBe(0.5);
  expect(
    summary.features.period.find((s) => s.service === "courses")!.share,
  ).toBe(9 / 20);
  const [download] = summary.quality.operations;
  expect(summary.quality.operations).toHaveLength(1);
  expect(download).toMatchObject({
    operation: "document_download",
    successRate: 0.8,
    cancelRate: 2 / 12,
    meanMs: 4250,
    p95Ms: 30_000,
    errors: { INTERRUPTED: 1, TIMEOUT: 1 },
  });
  for (const d of summary.overview)
    expect(d.coreInstalls).toBeLessThanOrEqual(d.activeInstalls ?? 0);
});

it("reads back exactly the exported sums through Data API customEvent metrics", () => {
  const byDate = new Map<string, typeof FIXTURE_ROWS>();
  for (const row of FIXTURE_ROWS)
    byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
  const readBack = DATA_API_QUERIES.flatMap((query) => {
    const body = runReportBody(query, FIXTURE_FROM, FIXTURE_TO);
    expect(body.metrics.every((m) => m.name.startsWith("customEvent:"))).toBe(
      true,
    );
    expect(JSON.stringify(body)).not.toMatch(/eventCount|countCustomEvent/);
    // Simulates GA summing each custom metric per date and dimension values.
    const rows = [...byDate].flatMap(([date, rows]) =>
      rowsToGaEvents(rows)
        .filter((event) => event.name === query.event)
        .map((event) => ({
          dimensionValues: [
            { value: date.replaceAll("-", "") },
            ...query.dimensions.map((name) => ({
              value: String(event.params[name]),
            })),
          ],
          metricValues: query.metrics.map(({ param }) => ({
            value: String(event.params[param] ?? 0),
          })),
        })),
    );
    return runReportRows(query, { rows });
  });
  const key = (r: { date: string; metric: string; dims: string }) =>
    `${r.date} ${r.metric} ${r.dims}`;
  expect(new Map(readBack.map((r) => [key(r), r.value]))).toEqual(
    new Map(FIXTURE_ROWS.map((r) => [key(r), r.value])),
  );
});

it("uses Asia/Seoul dates and refuses GA timestamps outside the 72-hour window", () => {
  expect(seoulDate(Date.parse("2026-10-31T14:59:59Z"))).toBe("2026-10-31");
  expect(seoulDate(Date.parse("2026-10-31T15:00:00Z"))).toBe("2026-11-01");
  const now = Date.parse("2026-11-04T03:00:00Z");
  const today = gaTimestampMs("2026-11-04", now)!;
  expect(seoulDate(today)).toBe("2026-11-04");
  expect(today).toBeLessThanOrEqual(now);
  const old = gaTimestampMs("2026-11-01", now)!;
  expect(seoulDate(old)).toBe("2026-11-01");
  expect(now - old).toBeLessThan(72 * 3_600_000);
  expect(gaTimestampMs("2026-10-31", now)).toBeNull();
  expect(seoulDayStart("2026-11-01")).toBe(Date.parse("2026-10-31T15:00:00Z"));
});
