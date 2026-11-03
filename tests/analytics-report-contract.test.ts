import { expect, it } from "vitest";
import fixture from "./fixtures/analytics-report-contract.json";
import {
  isDailyReport,
  latencyBucket,
  reportRows,
  seoulDate,
  seoulDayStart,
} from "../src/analytics/report";

// These bytes are also consumed by the Go collector's wire contract tests.
// Parse the wire, not the fixture's convenience input: malformed JSON,
// duplicate keys and integral exponent/decimal notation are part of the API.
it.each(fixture.reports)("matches the collector contract: $name", (sample) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sample.wire);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    expect(sample.valid).toBe(false);
    return;
  }
  expect(isDailyReport(parsed)).toBe(sample.valid);
  if (isDailyReport(parsed)) {
    expect(reportRows(parsed, parsed.extension_version)).toEqual(sample.rows);
  }
});

it("changes calendar days at Seoul midnight and latency buckets at their bounds", () => {
  expect(seoulDate(Date.parse("2026-10-31T14:59:59Z"))).toBe("2026-10-31");
  expect(seoulDate(Date.parse("2026-10-31T15:00:00Z"))).toBe("2026-11-01");
  expect(seoulDayStart("2026-11-01")).toBe(Date.parse("2026-10-31T15:00:00Z"));
  expect(latencyBucket(999)).toBe("lt1s");
  expect(latencyBucket(1_000)).toBe("1to3s");
});
