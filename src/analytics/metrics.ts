// Report-side metric math shared by documentation examples, tests and the
// GA4/collector report script. A null result is displayed as N/A.
import { LATENCY_BUCKETS, addDays, type LatencyBucket } from "./report.ts";

export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}
/** Period ratio = sum of numerators / sum of denominators, never a mean of daily ratios. */
export function periodRatio(
  days: readonly { numerator: number; denominator: number }[],
): number | null {
  let numerator = 0;
  let denominator = 0;
  for (const day of days) {
    numerator += day.numerator;
    denominator += day.denominator;
  }
  return ratio(numerator, denominator);
}
/** Per-date share; each date uses only its own learning-service total. */
export function dailyShares(
  rows: readonly { date: string; service: string; entries: number }[],
  learningServices: readonly string[],
): Map<string, Map<string, number | null>> {
  const totals = new Map<string, number>();
  for (const row of rows)
    if (learningServices.includes(row.service))
      totals.set(row.date, (totals.get(row.date) ?? 0) + row.entries);
  const shares = new Map<string, Map<string, number | null>>();
  for (const row of rows) {
    if (!learningServices.includes(row.service)) continue;
    const day = shares.get(row.date) ?? new Map<string, number | null>();
    day.set(row.service, ratio(row.entries, totals.get(row.date) ?? 0));
    shares.set(row.date, day);
  }
  return shares;
}
export function successRate(o: {
  success: number;
  failure: number;
  timeout: number;
}): number | null {
  return ratio(o.success, o.success + o.failure + o.timeout);
}
export function cancelRate(o: {
  success: number;
  failure: number;
  timeout: number;
  cancel: number;
}): number | null {
  return ratio(o.cancel, o.success + o.failure + o.timeout + o.cancel);
}
/** Weighted mean over all samples: total duration / total samples. */
export function weightedMeanMs(sumMs: number, samples: number): number | null {
  return ratio(sumMs, samples);
}
/**
 * Approximate p95 from fixed bucket counts: the upper bound of the first
 * bucket whose cumulative count reaches 95%. Infinity means "above the last
 * finite bound".
 */
export function approxP95Ms(
  counts: Partial<Record<LatencyBucket, number>>,
): number | null {
  let total = 0;
  for (const bucket of LATENCY_BUCKETS) total += counts[bucket.key] ?? 0;
  if (total === 0) return null;
  let cumulative = 0;
  for (const bucket of LATENCY_BUCKETS) {
    cumulative += counts[bucket.key] ?? 0;
    if (cumulative >= 0.95 * total) return bucket.maxMs;
  }
  return Number.POSITIVE_INFINITY;
}
/** Trailing 7-day mean ending on `date`; null when any of the 7 dates has no data. */
export function movingAverage7(
  series: ReadonlyMap<string, number>,
  date: string,
): number | null {
  let total = 0;
  for (let offset = 0; offset < 7; offset++) {
    const value = series.get(addDays(date, -offset));
    if (value === undefined) return null;
    total += value;
  }
  return total / 7;
}
export function sameWeekdayLastWeek(
  series: ReadonlyMap<string, number>,
  date: string,
): { previous: number | null; change: number | null } {
  const current = series.get(date);
  const previous = series.get(addDays(date, -7)) ?? null;
  return {
    previous,
    change:
      current === undefined || previous === null
        ? null
        : ratio(current - previous, previous),
  };
}
export function formatRatio(value: number | null, digits = 1): string {
  return value === null ? "N/A" : `${(value * 100).toFixed(digits)}%`;
}
