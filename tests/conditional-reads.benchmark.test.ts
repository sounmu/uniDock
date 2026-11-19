import { expect, it } from "vitest";
import { listQuery } from "../src/api/client";
import { ConditionalReads } from "../src/api/conditional-reads";
import { NavigationCatalog } from "../src/navigation-catalog";
import {
  createCanvasFixture,
  fixtureCourse,
  fixtureOrigin as origin,
} from "./conditional-reads-fixture";

// Opt-in: UNIDOCK_BENCH=1 npx vitest run tests/conditional-reads.benchmark.test.ts
const CYCLES = 6;
const RTT_MS = 20;
const BYTES_PER_MS = 1000;
const MODULES = 24;
const ITEMS_PER_MODULE = 12;
const now = Date.parse("2026-09-11T00:00:00Z");

interface Cycle {
  ms: number;
  calls: number;
  notModified: number;
  bodyBytes: number;
}

async function switchCycle(
  canvas: ReturnType<typeof createCanvasFixture>,
  reads?: ConditionalReads,
): Promise<Cycle> {
  canvas.reset();
  const started = performance.now();
  for (const type of [
    "RECORDINGS_LIST",
    "DOCUMENTS_LIST",
    "RECORDINGS_LIST",
  ] as const) {
    const catalog = new NavigationCatalog();
    const scope = reads?.scope();
    const result = await listQuery(
      origin,
      { version: 1, type, course: "Course" },
      canvas.fetcher,
      now,
      catalog,
      fixtureCourse,
      undefined,
      scope,
    );
    if (result.status !== "success") throw new Error(result.code);
    scope?.commit();
    catalog.clear();
  }
  return { ms: performance.now() - started, ...canvas.stats() };
}

async function scenario(conditional: boolean): Promise<Cycle[]> {
  const canvas = createCanvasFixture({
    modules: MODULES,
    itemsPerModule: ITEMS_PER_MODULE,
    rttMs: RTT_MS,
    bytesPerMs: BYTES_PER_MS,
  });
  const reads = conditional ? new ConditionalReads() : undefined;
  const cycles: Cycle[] = [];
  for (let cycle = 0; cycle < CYCLES; cycle++)
    cycles.push(await switchCycle(canvas, reads));
  return cycles;
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

it.skipIf(!process.env.UNIDOCK_BENCH)(
  "benchmark: recordings/documents switch before vs after",
  async () => {
    const before = await scenario(false);
    const after = await scenario(true);
    const report = [
      `fixture: ${MODULES} modules x ${ITEMS_PER_MODULE} items, RTT ${RTT_MS}ms, ${BYTES_PER_MS} B/ms, cycle = recordings -> documents -> recordings`,
    ];
    for (const [name, cycles] of [
      ["before (unconditional)", before],
      ["after (ETag revalidation)", after],
    ] as const) {
      const warm = cycles.slice(1);
      report.push(
        `${name}: cold ${cycles[0]!.ms.toFixed(0)}ms/${cycles[0]!.calls} calls/${cycles[0]!.bodyBytes} B; ` +
          `warm median ${median(warm.map((c) => c.ms)).toFixed(0)}ms, ` +
          `${median(warm.map((c) => c.calls))} calls (${median(warm.map((c) => c.notModified))} x 304), ` +
          `${median(warm.map((c) => c.bodyBytes))} B`,
      );
    }
    process.stdout.write(`\n${report.join("\n")}\n`);
    expect(median(after.slice(1).map((c) => c.bodyBytes))).toBe(0);
  },
  120_000,
);
