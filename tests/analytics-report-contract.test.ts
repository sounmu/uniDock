import { expect, it } from "vitest";
import fixture from "./fixtures/analytics-report-contract.json";
import schema from "../documentation/api/stats-report.schema.json";
import { Ajv2020 } from "ajv/dist/2020";
import {
  CORE_RESULTS,
  ERROR_CODES,
  LATENCY_KEYS,
  MAX_COUNT,
  MAX_DURATION_MS,
  OPERATIONS,
  REPORT_SCHEMA,
  SERVICES,
  TRIGGERS,
  isDailyReport,
  latencyBucket,
  reportRows,
  seoulDate,
  seoulDayStart,
} from "../src/analytics/report";

const validateStructure = new Ajv2020({ allErrors: true }).compile(schema);

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
    expect(
      validateStructure(parsed),
      JSON.stringify(validateStructure.errors),
    ).toBe(true);
    expect(reportRows(parsed, parsed.extension_version)).toEqual(sample.rows);
  }
});

it("keeps emitted codes and bounds within the pinned collector schema", () => {
  expect(schema.properties.schema.enum).toEqual([REPORT_SCHEMA]);
  expect(Object.keys(schema.properties.core_results.properties).sort()).toEqual(
    [...CORE_RESULTS].sort(),
  );
  expect(
    Object.keys(schema.properties.service_entries.properties).sort(),
  ).toEqual([...SERVICES].sort());
  expect(
    Object.keys(schema.properties.service_installs.properties).sort(),
  ).toEqual([...SERVICES].sort());
  expect(Object.keys(schema.properties.operations.properties).sort()).toEqual(
    [...OPERATIONS].sort(),
  );
  for (const operation of OPERATIONS) {
    expect(
      Object.keys(
        schema.properties.operations.properties[operation].properties,
      ).sort(),
    ).toEqual([...TRIGGERS].sort());
  }
  expect(
    Object.keys(schema.$defs.operation.properties.errors.properties).sort(),
  ).toEqual([...ERROR_CODES].sort());
  expect(
    Object.keys(schema.$defs.operation.properties.buckets.properties).sort(),
  ).toEqual([...LATENCY_KEYS].sort());
  expect(schema.$defs.count.maximum).toBe(MAX_COUNT);
  expect(schema.$defs.operation.properties.duration_ms_sum.maximum).toBe(
    MAX_COUNT * MAX_DURATION_MS,
  );
});

it("changes calendar days at Seoul midnight and latency buckets at their bounds", () => {
  expect(seoulDate(Date.parse("2026-10-31T14:59:59Z"))).toBe("2026-10-31");
  expect(seoulDate(Date.parse("2026-10-31T15:00:00Z"))).toBe("2026-11-01");
  expect(seoulDayStart("2026-11-01")).toBe(Date.parse("2026-10-31T15:00:00Z"));
  expect(latencyBucket(999)).toBe("lt1s");
  expect(latencyBucket(1_000)).toBe("1to3s");
});
