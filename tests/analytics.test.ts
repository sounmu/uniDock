import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AnalyticsRuntime,
  MAX_ATTEMPTS,
  SEAL_INTERVAL_MS,
} from "../src/analytics/runtime";
import {
  ANALYTICS_SETTINGS_KEY,
  ANALYTICS_STATE_KEY,
  LEGACY_ANALYTICS_KEY,
  isAnalyticsCommand,
  type AnalyticsSignal,
} from "../src/analytics/contract";
import {
  emptyCounters,
  isDailyReport,
  seoulDate,
  type DailyReport,
} from "../src/analytics/report";

const ENDPOINT = "https://stats.test";
const at = (local: string) => Date.parse(`${local}+09:00`);
let uuidCounter = 0;
const uuid = () =>
  `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function storage(initial: Record<string, unknown> = {}) {
  const stored: Record<string, unknown> = structuredClone(initial);
  const keys = (value: string | string[]) =>
    Array.isArray(value) ? value : [value];
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (value: string | string[]) =>
          structuredClone(
            Object.fromEntries(
              keys(value)
                .filter((key) => key in stored)
                .map((key) => [key, stored[key]]),
            ),
          ),
        ),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(stored, structuredClone(values));
        }),
        remove: vi.fn(async (value: string | string[]) => {
          for (const key of keys(value)) delete stored[key];
        }),
        clear: vi.fn(async () => {
          for (const key of Object.keys(stored)) delete stored[key];
        }),
        setAccessLevel: vi.fn(async () => {}),
      },
    },
  });
  return stored;
}
function harness(
  options: { initial?: Record<string, unknown>; endpoint?: string } = {},
) {
  const stored = storage(options.initial);
  const clock = { now: at("2026-11-01T10:00:00") };
  const sent: DailyReport[] = [];
  const bodies: string[] = [];
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () => new Response(null, { status: 200 }),
  );
  // Every attempt is recorded, including ones a test makes fail.
  const record = (url: string, init: RequestInit) => {
    bodies.push(init.body as string);
    sent.push(JSON.parse(init.body as string) as DailyReport);
    return fetch(url, init);
  };
  const make = () =>
    new AnalyticsRuntime(options.endpoint ?? ENDPOINT, "0.5.0", {
      now: () => clock.now,
      fetch: record,
      uuid,
    });
  const runtime = make();
  const send = (target: AnalyticsRuntime, data: AnalyticsSignal) =>
    target.command({ version: 1, type: "ANALYTICS_SIGNAL", signal: data });
  return { stored, clock, sent, bodies, fetch, runtime, make, send };
}
async function collectingHarness(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  await h.runtime.installed("install");
  await h.runtime.command({ version: 1, type: "ANALYTICS_NOTICE_SHOWN" });
  return h;
}
const service = (name: "courses" | "tasks" | "settings" = "courses") =>
  ({ kind: "service", service: name }) as const;
async function flush(h: ReturnType<typeof harness>, runtime = h.runtime) {
  h.clock.now += SEAL_INTERVAL_MS;
  await runtime.wake();
}
function total(
  reports: readonly DailyReport[],
  pick: (r: DailyReport) => number,
) {
  return reports.reduce((sum, report) => sum + pick(report), 0);
}
async function resetStatistics(
  runtime: AnalyticsRuntime,
  reset: "off" | "erase",
) {
  if (reset === "erase") {
    await runtime.erase(() => chrome.storage.local.clear());
    return;
  }
  await runtime.command({ version: 1, type: "ANALYTICS_SET", enabled: false });
  await runtime.command({ version: 1, type: "ANALYTICS_SET", enabled: true });
}

it("starts a fresh install ON but collects nothing until the panel has shown the notice", async () => {
  const h = harness();
  await h.runtime.installed("install");
  expect(
    await h.runtime.command({ version: 1, type: "ANALYTICS_STATUS" }),
  ).toEqual({ available: true, enabled: true, notice: "first_run" });
  expect(await h.send(h.runtime, service())).toEqual({ ok: false });
  expect(h.stored[ANALYTICS_STATE_KEY]).toBeUndefined();
  expect(
    await h.runtime.command({ version: 1, type: "ANALYTICS_NOTICE_SHOWN" }),
  ).toEqual({ available: true, enabled: true, notice: null });
  expect(await h.send(h.runtime, service())).toEqual({ ok: true });
});

it.each([
  [
    { version: 1, enabled: false },
    { enabled: false, notice: null },
  ],
  [
    {
      version: 1,
      enabled: true,
      id: "00000000-0000-4000-8000-0000000000aa",
    },
    { enabled: true, notice: "changed" },
  ],
  [undefined, { enabled: true, notice: "changed" }],
])(
  "migrates PostHog-era setting %j without keeping its UUID",
  async (legacy, expected) => {
    const h = harness({
      initial: legacy === undefined ? {} : { [LEGACY_ANALYTICS_KEY]: legacy },
    });
    await h.runtime.installed("update");
    expect(h.stored[LEGACY_ANALYTICS_KEY]).toBeUndefined();
    expect(h.stored[ANALYTICS_SETTINGS_KEY]).toEqual({
      version: 2,
      ...expected,
    });
    expect(JSON.stringify(h.stored)).not.toContain("0000000000aa");
  },
);

it("counts an active install and a service install once per day across many entries and flushes", async () => {
  const h = await collectingHarness();
  for (let i = 0; i < 5; i++) await h.send(h.runtime, service("courses"));
  await h.send(h.runtime, service("tasks"));
  await flush(h);
  for (let i = 0; i < 3; i++) await h.send(h.runtime, service("courses"));
  await flush(h);
  expect(h.sent).toHaveLength(2);
  expect(h.sent.every(isDailyReport)).toBe(true);
  expect(h.sent.map((report) => report.date)).toEqual([
    "2026-11-01",
    "2026-11-01",
  ]);
  expect(total(h.sent, (r) => r.active_installs)).toBe(1);
  expect(total(h.sent, (r) => r.service_installs.courses ?? 0)).toBe(1);
  expect(total(h.sent, (r) => r.service_installs.tasks ?? 0)).toBe(1);
  expect(total(h.sent, (r) => r.service_entries.courses ?? 0)).toBe(8);
  expect(new Set(h.sent.map((r) => r.report_id)).size).toBe(2);
});

it("never reports more core installs than active installs for the same date", async () => {
  const h = await collectingHarness();
  await h.send(h.runtime, { kind: "core", result: "document_downloaded" });
  await h.send(h.runtime, { kind: "core", result: "captions_exported" });
  await flush(h);
  const [report] = h.sent;
  expect(report).toMatchObject({
    active_installs: 1,
    core_installs: 1,
    core_results: { document_downloaded: 1, captions_exported: 1 },
  });
});

it.each(["off", "erase"] as const)(
  "restores the denominator after %s discards activity before its first send",
  async (reset) => {
    const h = await collectingHarness();
    await h.send(h.runtime, service("courses"));
    await h.send(h.runtime, { kind: "core", result: "document_downloaded" });
    await resetStatistics(h.runtime, reset);
    expect(h.sent).toHaveLength(0);
    await h.send(h.runtime, { kind: "core", result: "tasks_shown" });
    await h.send(h.runtime, service("tasks"));
    await flush(h);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      active_installs: 1,
      core_installs: 1,
      service_installs: { tasks: 1 },
      service_entries: { tasks: 1 },
    });
    expect(h.sent[0]?.service_entries.courses).toBeUndefined();
    expect(h.sent[0]?.core_results.document_downloaded).toBeUndefined();
  },
);

it.each(["off", "erase"] as const)(
  "keeps acknowledged install counts across a restart and repeated %s",
  async (reset) => {
    const h = await collectingHarness();
    await h.send(h.runtime, service());
    await h.send(h.runtime, { kind: "core", result: "tasks_shown" });
    await flush(h);
    const restarted = h.make();
    for (let cycle = 0; cycle < 2; cycle++) {
      await resetStatistics(restarted, reset);
      await h.send(restarted, service());
      await h.send(restarted, service("tasks"));
      await h.send(restarted, { kind: "core", result: "tasks_shown" });
      await flush(h, restarted);
    }
    expect(total(h.sent, (r) => r.active_installs)).toBe(1);
    expect(total(h.sent, (r) => r.core_installs)).toBe(1);
    expect(total(h.sent, (r) => r.service_installs.courses ?? 0)).toBe(1);
    expect(total(h.sent, (r) => r.service_installs.tasks ?? 0)).toBe(1);
  },
);

it.each(["off", "erase"] as const)(
  "recollects discarded pending numerators with an acknowledged denominator after %s",
  async (reset) => {
    const h = await collectingHarness();
    await h.send(h.runtime, service());
    await flush(h);
    await h.send(h.runtime, service("tasks"));
    await h.send(h.runtime, { kind: "core", result: "tasks_shown" });
    await resetStatistics(h.runtime, reset);
    await h.send(h.runtime, service("tasks"));
    await h.send(h.runtime, { kind: "core", result: "tasks_shown" });
    await flush(h);
    expect(h.sent[1]).toMatchObject({
      active_installs: 0,
      core_installs: 1,
      service_installs: { tasks: 1 },
      service_entries: { tasks: 1 },
    });
    expect(total(h.sent, (r) => r.active_installs)).toBe(1);
    expect(total(h.sent, (r) => r.core_installs)).toBe(1);
  },
);

it.each([
  { reset: "off", accepted: false },
  { reset: "off", accepted: true },
  { reset: "erase", accepted: false },
  { reset: "erase", accepted: true },
] as const)(
  "does not guess delivery after $reset when the response is lost (accepted=$accepted)",
  async ({ reset, accepted }) => {
    const h = await collectingHarness();
    const received: DailyReport[] = [];
    h.fetch.mockImplementation(async () => {
      const report = h.sent.at(-1);
      if (!report) throw new Error("missing request");
      received.push(report);
      return new Response(null, { status: 200 });
    });
    h.fetch.mockImplementationOnce(async () => {
      const report = h.sent.at(-1);
      if (!report) throw new Error("missing request");
      if (accepted) received.push(report);
      throw new TypeError("response lost");
    });
    await h.send(h.runtime, service());
    await flush(h);
    const restarted = h.make();
    await resetStatistics(restarted, reset);
    await h.send(restarted, service());
    await h.send(restarted, service("tasks"));
    await h.send(restarted, { kind: "core", result: "tasks_shown" });
    await flush(h, restarted);
    expect(h.sent[1]).toMatchObject({
      active_installs: 0,
      core_installs: 0,
      service_installs: {},
      service_entries: { courses: 1, tasks: 1 },
      core_results: { tasks_shown: 1 },
    });
    expect(total(received, (r) => r.active_installs)).toBe(accepted ? 1 : 0);
    expect(total(received, (r) => r.core_installs)).toBe(0);
    // The uncertainty lasts only for its original Seoul day.
    h.clock.now = at("2026-11-02T10:00:00");
    await h.send(restarted, { kind: "core", result: "tasks_shown" });
    await h.send(restarted, service("tasks"));
    await flush(h, restarted);
    expect(h.sent[2]).toMatchObject({
      date: "2026-11-02",
      active_installs: 1,
      core_installs: 1,
      service_installs: { tasks: 1 },
    });
  },
);

it("treats sealed reports as unsent when the pre-fetch durable write fails", async () => {
  const h = await collectingHarness();
  await h.send(h.runtime, service());
  vi.mocked(chrome.storage.local.set)
    .mockImplementationOnce(async (values) => {
      Object.assign(h.stored, structuredClone(values));
    })
    .mockRejectedValueOnce(new Error("storage unavailable"));
  await flush(h);
  expect(h.fetch).not.toHaveBeenCalled();
  expect(h.stored[ANALYTICS_STATE_KEY]).toMatchObject({
    pending: [],
    queue: [expect.objectContaining({ attempts: 0 })],
  });
  const restarted = h.make();
  await resetStatistics(restarted, "erase");
  await h.send(restarted, { kind: "core", result: "tasks_shown" });
  await flush(h, restarted);
  expect(h.sent[0]).toMatchObject({ active_installs: 1, core_installs: 1 });
});

it.each(["off", "erase"] as const)(
  "preserves an uncertain numerator without blocking other reach after %s when active is confirmed",
  async (reset) => {
    const h = await collectingHarness();
    await h.send(h.runtime, service());
    await flush(h);
    h.fetch.mockRejectedValueOnce(new TypeError("response lost"));
    await h.send(h.runtime, { kind: "core", result: "tasks_shown" });
    await flush(h);
    await resetStatistics(h.runtime, reset);
    await h.send(h.runtime, { kind: "core", result: "tasks_shown" });
    await h.send(h.runtime, service("tasks"));
    await flush(h);
    expect(h.sent[2]).toMatchObject({
      active_installs: 0,
      core_installs: 0,
      service_installs: { tasks: 1 },
      core_results: { tasks_shown: 1 },
    });
  },
);

it.each(["pending", "queued", "unproven"] as const)(
  "migrates legacy %s flags without assuming that attempts=0 proves non-delivery",
  async (location) => {
    const date = "2026-11-01";
    const counters = {
      ...emptyCounters(),
      active_installs: 1 as const,
      service_entries: { courses: 1 },
      service_installs: { courses: 1 as const },
    };
    const report: DailyReport = {
      ...counters,
      schema: 1,
      report_id: uuid(),
      date,
      extension_version: "0.5.0",
    };
    const h = await collectingHarness({
      initial: {
        [ANALYTICS_STATE_KEY]: {
          version: 1,
          day: { date, active: true, core: false, services: ["courses"] },
          pending:
            location === "pending"
              ? [{ date, version: "0.5.0", counters }]
              : [],
          queue:
            location === "queued"
              ? [
                  {
                    id: report.report_id,
                    date,
                    body: JSON.stringify(report),
                    attempts: 0,
                    next_attempt_at: 0,
                  },
                ]
              : [],
          last_seal_at: 0,
        },
      },
    });
    await resetStatistics(h.runtime, "erase");
    await h.send(h.runtime, { kind: "core", result: "tasks_shown" });
    await h.send(h.runtime, service("tasks"));
    await flush(h);
    const knownUnsent = location === "pending";
    expect(h.sent[0]).toMatchObject({
      active_installs: knownUnsent ? 1 : 0,
      core_installs: knownUnsent ? 1 : 0,
      service_installs: knownUnsent ? { tasks: 1 } : {},
      core_results: { tasks_shown: 1 },
    });
  },
);

it("keeps each report on its original Seoul date across midnight", async () => {
  const h = await collectingHarness();
  h.clock.now = at("2026-11-01T23:59:30");
  await h.send(h.runtime, service());
  await h.send(h.runtime, {
    kind: "op_start",
    operation: "captions_export",
    trigger: "user",
  });
  h.clock.now = at("2026-11-02T00:00:30");
  await h.send(h.runtime, service());
  await h.send(h.runtime, {
    kind: "op_end",
    operation: "captions_export",
    trigger: "user",
    outcome: "success",
    duration_ms: 1500,
  });
  await h.runtime.wake();
  expect(h.sent.map((r) => [r.date, r.active_installs])).toEqual([
    ["2026-11-01", 1],
    ["2026-11-02", 1],
  ]);
  expect(h.sent[0]!.operations.captions_export?.user?.started).toBe(1);
  expect(h.sent[1]!.operations.captions_export?.user).toMatchObject({
    started: 0,
    success: 1,
    duration_count: 1,
    duration_ms_sum: 1500,
    buckets: { "1to3s": 1 },
  });
});

it("survives a worker restart without recounting and resends the identical queued bytes", async () => {
  const h = await collectingHarness();
  h.fetch.mockRejectedValueOnce(new TypeError("offline"));
  await h.send(h.runtime, service());
  await flush(h);
  const queued = (
    h.stored[ANALYTICS_STATE_KEY] as { queue: { body: string }[] }
  ).queue;
  expect(queued).toHaveLength(1);
  const restarted = h.make();
  await h.send(restarted, service());
  h.clock.now += 6 * 3_600_000;
  await restarted.wake();
  expect(h.bodies[1]).toBe(queued[0]!.body);
  expect(h.sent[1]!.report_id).toBe(h.sent[0]!.report_id);
  expect(total(h.sent.slice(1), (r) => r.active_installs)).toBe(1);
});

it("loses and double-counts nothing when captures and flushes interleave", async () => {
  const h = await collectingHarness();
  const work: Promise<unknown>[] = [];
  for (let i = 0; i < 40; i++) {
    work.push(h.send(h.runtime, service(i % 2 ? "courses" : "tasks")));
    if (i % 7 === 0) {
      h.clock.now += SEAL_INTERVAL_MS;
      work.push(h.runtime.wake());
    }
  }
  await Promise.all(work);
  await flush(h);
  expect(
    total(
      h.sent,
      (r) => (r.service_entries.courses ?? 0) + (r.service_entries.tasks ?? 0),
    ),
  ).toBe(40);
  expect(total(h.sent, (r) => r.active_installs)).toBe(1);
  expect(new Set(h.sent.map((r) => r.report_id)).size).toBe(h.sent.length);
});

it("retries transient failures with backoff, drops rejected reports, and bounds attempts", async () => {
  const h = await collectingHarness();
  h.fetch.mockResolvedValueOnce(new Response(null, { status: 400 }));
  await h.send(h.runtime, service());
  await flush(h);
  const state = () =>
    h.stored[ANALYTICS_STATE_KEY] as { queue: { attempts: number }[] };
  expect(state().queue).toHaveLength(0);
  h.fetch.mockResolvedValue(new Response(null, { status: 503 }));
  await h.send(h.runtime, service("tasks"));
  await flush(h);
  expect(state().queue[0]!.attempts).toBe(1);
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    h.clock.now += 7 * 3_600_000;
    await h.runtime.wake();
  }
  expect(state().queue).toHaveLength(0);
  expect(new Set(h.sent.slice(1).map((r) => r.report_id)).size).toBe(1);
});

it.each(["off", "erase"] as const)(
  "%s during an in-flight send keeps uncertain flags without orphan numerators",
  async (reset) => {
    const h = await collectingHarness();
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    h.fetch.mockImplementationOnce((_url, init) => {
      init.signal?.addEventListener("abort", () =>
        response.reject(new Error("abort")),
      );
      started.resolve();
      return response.promise;
    });
    await h.send(h.runtime, service());
    h.clock.now += SEAL_INTERVAL_MS;
    const sending = h.runtime.wake();
    await started.promise;
    await resetStatistics(h.runtime, reset);
    response.resolve(new Response(null, { status: 200 }));
    await sending;
    expect(h.stored[ANALYTICS_STATE_KEY]).toMatchObject({
      pending: [],
      queue: [],
    });
    await h.send(h.runtime, service());
    await h.send(h.runtime, service("tasks"));
    await h.send(h.runtime, { kind: "core", result: "tasks_shown" });
    await flush(h);
    const after = h.sent.slice(1);
    expect(total(after, (r) => r.active_installs)).toBe(0);
    expect(total(after, (r) => r.core_installs)).toBe(0);
    expect(total(after, (r) => r.service_installs.tasks ?? 0)).toBe(0);
    expect(total(after, (r) => r.service_entries.courses ?? 0)).toBe(1);
  },
);

it("clear-data keeps an earlier OFF but can recollect discarded unsent flags", async () => {
  const h = await collectingHarness();
  await h.send(h.runtime, service());
  await h.runtime.command({
    version: 1,
    type: "ANALYTICS_SET",
    enabled: false,
  });
  expect(await h.send(h.runtime, service())).toEqual({ ok: false });
  const result = await h.runtime.erase(async () => {
    await chrome.storage.local.clear();
    return "cleared";
  });
  expect(result).toBe("cleared");
  expect(h.stored[ANALYTICS_SETTINGS_KEY]).toEqual({
    version: 2,
    enabled: false,
    notice: null,
  });
  await h.runtime.command({ version: 1, type: "ANALYTICS_SET", enabled: true });
  await h.send(h.runtime, service());
  await flush(h);
  expect(total(h.sent, (r) => r.active_installs)).toBe(1);
});

it("records one final outcome per operation with fixed codes and valid reports", async () => {
  const h = await collectingHarness();
  const end = (outcome: "failure" | "timeout" | "cancel") =>
    h.send(h.runtime, {
      kind: "op_end",
      operation: "document_download",
      trigger: "user",
      ...(outcome === "failure"
        ? { outcome, error: "INTERRUPTED" as const }
        : { outcome }),
    } as AnalyticsSignal);
  await h.send(h.runtime, {
    kind: "op_start",
    operation: "document_download",
    trigger: "user",
  });
  await end("failure");
  await end("timeout");
  await end("cancel");
  await flush(h);
  const op = h.sent[0]!.operations.document_download!.user!;
  expect(op).toMatchObject({
    started: 1,
    failure: 1,
    timeout: 1,
    cancel: 1,
    errors: { INTERRUPTED: 1, TIMEOUT: 1 },
  });
  expect(isDailyReport(h.sent[0])).toBe(true);
});

it("rejects free text, URLs, IDs and unknown codes at the message boundary", () => {
  const bad = [
    { kind: "service", service: "https://mylms.korea.ac.kr/courses/1" },
    { kind: "core", result: "tasks_shown", title: "Calculus" },
    {
      kind: "op_end",
      operation: "document_download",
      trigger: "user",
      outcome: "failure",
      error: "student@korea.ac.kr",
    },
    {
      kind: "op_end",
      operation: "document_download",
      trigger: "user",
      outcome: "success",
      duration_ms: 1.5,
    },
    {
      kind: "op_start",
      operation: "document_download",
      trigger: "user",
      id: "op-1",
    },
  ];
  for (const signal of bad)
    expect(
      isAnalyticsCommand({ version: 1, type: "ANALYTICS_SIGNAL", signal }),
    ).toBe(false);
});

it("sends exactly the closed report shape with no install identifier, cookies or referrer", async () => {
  const h = await collectingHarness();
  await h.send(h.runtime, service());
  await flush(h);
  await h.send(h.runtime, service("tasks"));
  await flush(h);
  const [url, init] = h.fetch.mock.calls[0]!;
  expect(url).toBe(`${ENDPOINT}/v1/reports`);
  expect(init).toMatchObject({
    method: "POST",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
  });
  expect(Object.keys(h.sent[0]!).sort()).toEqual(
    [
      "active_installs",
      "core_installs",
      "core_results",
      "date",
      "extension_version",
      "operations",
      "report_id",
      "schema",
      "service_entries",
      "service_installs",
    ].sort(),
  );
  expect(h.sent[0]!.report_id).not.toBe(h.sent[1]!.report_id);
});

it("drops data older than the collector window instead of relabeling it as today", async () => {
  const h = await collectingHarness();
  h.fetch.mockRejectedValue(new TypeError("offline"));
  await h.send(h.runtime, service());
  await flush(h);
  h.clock.now = at("2026-11-09T10:00:00");
  await h.runtime.wake();
  expect(h.stored[ANALYTICS_STATE_KEY]).toMatchObject({ queue: [] });
  expect(seoulDate(h.clock.now)).toBe("2026-11-09");
});

it("does nothing without a configured collector origin", async () => {
  const h = harness({ endpoint: "" });
  await h.runtime.installed("install");
  await h.runtime.command({ version: 1, type: "ANALYTICS_NOTICE_SHOWN" });
  expect(await h.send(h.runtime, service())).toEqual({ ok: false });
  await h.runtime.wake();
  expect(h.fetch).not.toHaveBeenCalled();
  expect(
    await h.runtime.command({ version: 1, type: "ANALYTICS_STATUS" }),
  ).toMatchObject({ available: false });
});
