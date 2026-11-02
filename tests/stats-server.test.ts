import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAY_MS,
  MAX_REPORT_BYTES,
  REPORT_ID_RETENTION_DAYS,
  addDays,
  emptyCounters,
  emptyOperation,
  reportRows,
  seoulDate,
  seoulDayStart,
  type DailyReport,
  type Row,
} from "../src/analytics/report.ts";
import { rowsToGaEvents } from "../src/analytics/ga4.ts";
import { createWorker, type Env } from "../server/stats/src/worker.ts";
import type { ExportSummary } from "../server/stats/src/export.ts";
import {
  createSqliteD1,
  type SqliteD1,
} from "../server/stats/test/sqlite-d1.ts";

const NOW = Date.parse("2026-11-01T03:00:00Z");
const TODAY = seoulDate(NOW);
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const GA_SECRET = "ga-secret-value-xyz";
const ADMIN = "admin-token-abc";
const SCHEMA = readFileSync(
  new URL("../server/stats/schema.sql", import.meta.url),
  "utf8",
);

interface Call {
  url: string;
  body: {
    client_id: string;
    timestamp_micros: string;
    non_personalized_ads: boolean;
    events: { name: string; params: Record<string, string | number> }[];
  };
}
interface StatusBody {
  last_received_at: string | null;
  last_export_status: string | null;
  pipeline: Record<string, Record<string, number>>;
  exports: Record<string, number>;
  unexported: {
    date: string;
    rows: number;
    value_sum: number;
    exportable: boolean;
  }[];
}

let db: SqliteD1;
let env: Env;
let clock: number;
let calls: Call[];
let respond: (url: string) => Response | Promise<Response>;
let texts: string[];
let worker: ReturnType<typeof createWorker>;

beforeEach(() => {
  db = createSqliteD1();
  db.exec(SCHEMA);
  clock = NOW;
  calls = [];
  texts = [];
  respond = () => new Response(null, { status: 204 });
  env = {
    DB: db,
    GA_MEASUREMENT_ID: "G-TEST123456",
    GA_API_SECRET: GA_SECRET,
    GA_ENDPOINT: "https://ga.test",
    ALLOWED_ORIGINS: `${ORIGIN},chrome-extension://other`,
    ADMIN_TOKEN: ADMIN,
    EXPORT_ENABLED: "0",
  };
  worker = createWorker({
    now: () => clock,
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Call["body"] });
      return respond(url);
    },
  });
});
afterEach(() => db.close());

function report(overrides: Partial<DailyReport> = {}): DailyReport {
  const op = emptyOperation();
  op.started = 3;
  op.success = 2;
  op.failure = 1;
  op.errors = { NETWORK: 1 };
  op.duration_ms_sum = 2000;
  op.duration_count = 2;
  op.buckets = { lt1s: 1, "1to3s": 1 };
  return {
    ...emptyCounters(),
    schema: 1,
    report_id: crypto.randomUUID(),
    date: TODAY,
    extension_version: "0.5.0",
    active_installs: 1,
    core_installs: 1,
    core_results: { tasks_shown: 4 },
    service_entries: { courses: 200, tasks: 3 },
    service_installs: { courses: 1, tasks: 1 },
    operations: { courses_load: { user: op } },
    ...overrides,
  };
}

async function post(
  body: unknown,
  options: { origin?: string | null; type?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": options.type ?? "text/plain;charset=UTF-8",
  };
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) headers.origin = origin;
  const response = await worker.fetch(
    new Request("https://stats.test/v1/reports", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
  );
  return record(response);
}

async function admin(
  path: string,
  options: { method?: string; token?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? ADMIN : options.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await worker.fetch(
    new Request(`https://stats.test${path}`, {
      method: options.method ?? "GET",
      headers,
    }),
    env,
  );
  return record(response);
}

async function record(response: Response): Promise<Response> {
  texts.push(await response.clone().text());
  return response;
}

async function json<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

async function table(name: string): Promise<Record<string, unknown>[]> {
  return (
    await db
      .prepare(
        `SELECT * FROM ${name} ORDER BY ${name === "totals" || name === "exported" ? "1, 2, 3" : "1"}`,
      )
      .all()
  ).results;
}

async function totals(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (const row of await table("totals"))
    map.set(`${row.date}|${row.metric}|${row.dims}`, row.value as number);
  return map;
}

function expectedTotals(
  r: DailyReport,
  status = "accepted",
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of reportRows(r, r.extension_version))
    map.set(`${r.date}|${row.metric}|${row.dims}`, row.value);
  map.set(`${TODAY}|pipeline_reports|status=${status}`, 1);
  return map;
}

async function nonPipeline(): Promise<number> {
  return [...(await totals()).keys()].filter(
    (key) => !key.includes("|pipeline_reports|"),
  ).length;
}

async function runExport(query = ""): Promise<ExportSummary> {
  return json<ExportSummary>(
    await admin(`/v1/admin/export${query}`, { method: "POST" }),
  );
}

function eventsOf(rows: Row[]) {
  return rowsToGaEvents(rows).map(({ name, params }) => ({ name, params }));
}
function sorted<T>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}
function sentEvents(from = 0) {
  return calls.slice(from).flatMap((call) => call.body.events);
}

describe("ingestion", () => {
  it("accepts a valid report into totals and echoes CORS", async () => {
    const r = report();
    const response = await post(r);
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ status: "accepted" });
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await totals()).toEqual(expectedTotals(r));
  });

  it("answers the CORS preflight only for allowed origins", async () => {
    const preflight = (origin: string) =>
      worker.fetch(
        new Request("https://stats.test/v1/reports", {
          method: "OPTIONS",
          headers: { origin },
        }),
        env,
      );
    const ok = await preflight(ORIGIN);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-methods")).toBe("POST");
    expect(ok.headers.get("access-control-max-age")).toBe("86400");
    expect((await preflight("https://evil.test")).status).toBe(403);
  });

  it("treats a resent report_id as a duplicate, sequentially", async () => {
    const r = report();
    await post(r);
    const before = await totals();
    const again = await post(r);
    expect(await json(again)).toEqual({ status: "duplicate" });
    const after = await totals();
    after.delete(`${TODAY}|pipeline_reports|status=duplicate`);
    expect(after).toEqual(before);
    expect(
      (await totals()).get(`${TODAY}|pipeline_reports|status=duplicate`),
    ).toBe(1);
  });

  it("treats concurrent resends of one report_id as one accepted", async () => {
    const r = report();
    const responses = await Promise.all([post(r), post(r)]);
    const statuses = (
      await Promise.all(responses.map((x) => json<{ status: string }>(x)))
    )
      .map((x) => x.status)
      .sort();
    expect(statuses).toEqual(["accepted", "duplicate"]);
    const map = await totals();
    expect(map.get(`${TODAY}|pipeline_reports|status=accepted`)).toBe(1);
    expect(map.get(`${TODAY}|pipeline_reports|status=duplicate`)).toBe(1);
    expect(map.get(`${TODAY}|active_installs|`)).toBe(1);
  });

  const op = (patch: Record<string, unknown>) => {
    const base = report().operations.courses_load?.user;
    return { courses_load: { user: { ...base, ...patch } } };
  };
  const invalid: [string, () => unknown][] = [
    ["extra key", () => ({ ...report(), extra: 1 })],
    [
      "string count",
      () => ({ ...report(), core_results: { tasks_shown: "3" } }),
    ],
    [
      "service_installs 2",
      () => ({ ...report(), service_installs: { courses: 2 } }),
    ],
    ["unknown service", () => ({ ...report(), service_entries: { bogus: 1 } })],
    [
      "bucket sum mismatch",
      () => ({ ...report(), operations: op({ buckets: { lt1s: 1 } }) }),
    ],
    [
      "URL-like version",
      () => ({ ...report(), extension_version: "https://evil.test/x" }),
    ],
    [
      "free-text key",
      () => ({ ...report(), core_results: { "hello world": 1 } }),
    ],
    [
      "URL-like error key",
      () => ({
        ...report(),
        operations: op({ errors: { "https://x.test": 1 } }),
      }),
    ],
    ["non-UUID report_id", () => ({ ...report(), report_id: "install-1234" })],
    ["bad JSON", () => "{not json"],
    ["array body", () => []],
  ];
  it.each(invalid)(
    "rejects %s without touching totals",
    async (_name, make) => {
      const response = await post(make());
      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({ status: "invalid" });
      expect(await nonPipeline()).toBe(0);
      expect(
        (await totals()).get(`${TODAY}|pipeline_reports|status=invalid`),
      ).toBe(1);
    },
  );

  it("rejects oversize bodies with 413", async () => {
    const response = await post("x".repeat(MAX_REPORT_BYTES + 1));
    expect(response.status).toBe(413);
    expect(await nonPipeline()).toBe(0);
  });

  it("rejects an unsupported content type", async () => {
    const response = await post(report(), {
      type: "application/x-www-form-urlencoded",
    });
    expect(response.status).toBe(415);
    expect(await nonPipeline()).toBe(0);
  });

  it("accepts application/json too", async () => {
    expect((await post(report(), { type: "application/json" })).status).toBe(
      200,
    );
  });

  it.each([
    ["disallowed", "https://evil.test"],
    ["missing", null],
  ])(
    "rejects a %s Origin with 403 and stores nothing",
    async (_name, origin) => {
      const response = await post(report(), { origin });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await totals()).toEqual(new Map());
    },
  );

  it("expires reports older than 7 days and rejects far-future dates", async () => {
    const old = await post(report({ date: addDays(TODAY, -8) }));
    expect(old.status).toBe(422);
    expect(await json(old)).toEqual({ status: "expired" });
    expect(
      (await totals()).get(`${TODAY}|pipeline_reports|status=expired`),
    ).toBe(1);
    expect((await post(report({ date: addDays(TODAY, 2) }))).status).toBe(400);
    expect(await nonPipeline()).toBe(0);
    expect((await post(report({ date: addDays(TODAY, -7) }))).status).toBe(200);
  });

  it("counts a report for yesterday as accepted_late", async () => {
    const r = report({ date: addDays(TODAY, -1) });
    expect((await post(r)).status).toBe(200);
    expect(await totals()).toEqual(expectedTotals(r, "accepted_late"));
  });

  it("rejects other methods and unknown paths", async () => {
    const get = await worker.fetch(
      new Request("https://stats.test/v1/reports", {
        headers: { origin: ORIGIN },
      }),
      env,
    );
    expect(get.status).toBe(405);
    const other = await worker.fetch(
      new Request("https://stats.test/nope"),
      env,
    );
    expect(other.status).toBe(404);
  });

  it("answers 503 retry when the database fails", async () => {
    db.exec("DROP TABLE meta");
    const response = await post(report());
    expect(response.status).toBe(503);
    expect(await json(response)).toEqual({ status: "retry" });
    expect(await nonPipeline()).toBe(0);
  });
});

describe("export", () => {
  it("sends one aggregated event per group with an in-day timestamp", async () => {
    const r = report();
    await post(r);
    const summary = await runExport();
    expect(summary).toMatchObject({
      requests: 1,
      sent: 1,
      failed: 0,
      rejected: 0,
      unknown: 0,
    });
    const [call] = calls;
    if (!call) throw new Error("no GA call");
    expect(call.url).toBe(
      `https://ga.test/mp/collect?measurement_id=G-TEST123456&api_secret=${GA_SECRET}`,
    );
    const rows: Row[] = [
      ...reportRows(r, r.extension_version),
      { metric: "pipeline_reports", dims: "status=accepted", value: 1 },
    ];
    expect(sorted(call.body.events)).toEqual(sorted(eventsOf(rows)));
    const service = call.body.events.find(
      (event) =>
        event.name === "ud_service_agg" &&
        event.params.ud_service === "courses",
    );
    expect(service?.params.ud_service_entries).toBe(200);
    expect(service?.params.ud_service_installs).toBe(1);
    const ts = Number(call.body.timestamp_micros) / 1000;
    expect(ts).toBeGreaterThanOrEqual(seoulDayStart(r.date));
    expect(ts).toBeLessThan(seoulDayStart(r.date) + DAY_MS);
    expect(ts).toBeGreaterThanOrEqual(NOW - 72 * 3_600_000);
    expect(ts).toBeLessThanOrEqual(NOW);
    expect(Object.keys(call.body).sort()).toEqual([
      "client_id",
      "events",
      "non_personalized_ads",
      "timestamp_micros",
    ]);
    expect(call.body.non_personalized_ads).toBe(true);
    expect(call.body.client_id).toMatch(/^\d+\.\d+$/);
    const raw = JSON.stringify(call.body);
    for (const forbidden of [
      "session_id",
      "engagement_time_msec",
      "user_id",
      "user_properties",
      "ip_override",
    ])
      expect(raw).not.toContain(forbidden);
  });

  it("uses a fresh synthetic client_id per request", async () => {
    await post(report());
    await post(report({ date: addDays(TODAY, -1) }));
    expect((await runExport()).requests).toBe(2);
    expect(calls[0]?.body.client_id).not.toBe(calls[1]?.body.client_id);
  });

  it("sends nothing on a second run and only the delta after a new report", async () => {
    await post(report());
    await runExport();
    const sent = calls.length;
    expect((await runExport()).requests).toBe(0);
    expect(calls.length).toBe(sent);
    const next = report({
      active_installs: 0,
      core_installs: 0,
      core_results: { tasks_shown: 2 },
      service_entries: {},
      service_installs: {},
      operations: {},
    });
    await post(next);
    expect((await runExport()).requests).toBe(1);
    expect(sorted(sentEvents(sent))).toEqual(
      sorted([
        {
          name: "ud_core_agg",
          params: { ud_core_result: "tasks_shown", ud_core_results: 2 },
        },
        {
          name: "ud_pipeline_agg",
          params: { ud_pipeline_status: "accepted", ud_pipeline_reports: 1 },
        },
      ]),
    );
  });

  it("reverts on 5xx and resends the same delta next run", async () => {
    await post(report());
    await post(report({ date: addDays(TODAY, -1) }));
    respond = () => new Response("down", { status: 503 });
    const first = await runExport();
    expect(first).toMatchObject({ requests: 1, failed: 1, sent: 0 });
    const sum = await db
      .prepare("SELECT COALESCE(SUM(value), 0) AS s FROM exported")
      .first<{ s: number }>();
    expect(sum?.s).toBe(0);
    const failedBody = calls[0]?.body;
    respond = () => new Response(null, { status: 204 });
    const second = await runExport();
    expect(second).toMatchObject({ requests: 2, sent: 2 });
    expect(sorted(calls[1] ? calls[1].body.events : [])).toEqual(
      sorted(failedBody?.events ?? []),
    );
    const status = await json<StatusBody>(await admin("/v1/admin/status"));
    expect(status.exports).toMatchObject({ failed: 1, sent: 2 });
    expect(status.unexported).toEqual([]);
  });

  it("reverts and stops on a rejected response", async () => {
    await post(report());
    respond = () => new Response("bad", { status: 400 });
    expect(await runExport()).toMatchObject({ requests: 1, rejected: 1 });
    const status = await json<StatusBody>(await admin("/v1/admin/status"));
    expect(status.last_export_status).toBe("rejected");
    expect(status.unexported[0]?.exportable).toBe(true);
  });

  it("marks network errors unknown and never resends them", async () => {
    await post(report());
    respond = () => {
      throw new Error(`socket closed for ${GA_SECRET}`);
    };
    expect(await runExport()).toMatchObject({
      requests: 1,
      unknown: 1,
      sent: 0,
    });
    respond = () => new Response(null, { status: 204 });
    expect((await runExport()).requests).toBe(0);
    expect(calls.length).toBe(1);
    const status = await json<StatusBody>(await admin("/v1/admin/status"));
    expect(status.exports).toMatchObject({ unknown: 1 });
    expect(status.last_export_status).toBe("ok");
  });

  it("marks stale sending rows unknown and leaves fresh ones", async () => {
    const insert = db.prepare(
      "INSERT INTO export_log (id, date, status, events, value_sum, created_at, updated_at) VALUES (?, ?, 'sending', 1, 1, ?, ?)",
    );
    await insert
      .bind("stale", TODAY, NOW - 20 * 60_000, NOW - 20 * 60_000)
      .run();
    await insert.bind("fresh", TODAY, NOW - 5 * 60_000, NOW - 5 * 60_000).run();
    await runExport();
    const rows = await table("export_log");
    expect(rows.find((row) => row.id === "stale")?.status).toBe("unknown");
    expect(rows.find((row) => row.id === "fresh")?.status).toBe("sending");
  });

  it("does not send dates beyond the GA window and flags them in status", async () => {
    const date = addDays(TODAY, -4);
    await post(report({ date }));
    await runExport();
    expect(
      sentEvents().every((event) => event.name === "ud_pipeline_agg"),
    ).toBe(true);
    const status = await json<StatusBody>(await admin("/v1/admin/status"));
    const stale = status.unexported.find((row) => row.date === date);
    expect(stale?.exportable).toBe(false);
    expect(stale?.value_sum).toBeGreaterThan(0);
  });

  it("skips when the lease is held and releases it afterwards", async () => {
    await db
      .prepare("INSERT INTO meta (key, value) VALUES ('export_lease', ?)")
      .bind(String(NOW + 60_000))
      .run();
    expect((await runExport()).skipped).toBe("lease_held");
    await db.prepare("DELETE FROM meta WHERE key = 'export_lease'").run();
    await runExport();
    expect(
      await db
        .prepare("SELECT 1 AS x FROM meta WHERE key = 'export_lease'")
        .first(),
    ).toBeNull();
  });

  it("reports not_configured without GA settings", async () => {
    delete env.GA_API_SECRET;
    expect((await runExport()).skipped).toBe("not_configured");
    expect(calls.length).toBe(0);
  });

  it("validate mode posts to the debug endpoint and changes nothing", async () => {
    await post(report());
    const snapshot = async () =>
      JSON.stringify([
        await table("totals"),
        await table("exported"),
        await table("export_log"),
        await table("meta"),
        await table("report_ids"),
      ]);
    const before = await snapshot();
    respond = () =>
      new Response(
        JSON.stringify({ validationMessages: [{ fieldPath: "events" }] }),
        {
          status: 200,
        },
      );
    const summary = await runExport("?validate=1");
    expect(calls.length).toBe(1);
    expect(calls[0]?.url.startsWith("https://ga.test/debug/mp/collect?")).toBe(
      true,
    );
    expect(summary.validation?.[0]?.validationMessages).toEqual([
      { fieldPath: "events" },
    ]);
    expect(await snapshot()).toBe(before);
  });
});

describe("admin", () => {
  it("requires the bearer token", async () => {
    for (const path of [
      "/v1/admin/status",
      "/v1/admin/totals?from=2026-11-01&to=2026-11-01",
    ]) {
      expect((await admin(path, { token: null })).status).toBe(401);
      expect((await admin(path, { token: "wrong" })).status).toBe(401);
      expect((await admin(path)).status).toBe(200);
    }
    expect(
      (await admin("/v1/admin/export", { method: "POST", token: "wrong" }))
        .status,
    ).toBe(401);
    expect(calls.length).toBe(0);
  });

  it("hides admin routes when ADMIN_TOKEN is missing or empty", async () => {
    for (const value of [undefined, ""]) {
      env.ADMIN_TOKEN = value;
      expect((await admin("/v1/admin/status")).status).toBe(404);
    }
  });

  it("lists totals with exported amounts and validates the range", async () => {
    const r = report();
    await post(r);
    await runExport();
    const body = await json<{
      rows: { date: string; metric: string; value: number; exported: number }[];
    }>(await admin(`/v1/admin/totals?from=${TODAY}&to=${TODAY}`));
    expect(body.rows.length).toBe(expectedTotals(r).size);
    expect(body.rows.every((row) => row.exported === row.value)).toBe(true);
    expect((await admin("/v1/admin/totals?from=2026-11-01")).status).toBe(400);
    expect(
      (await admin("/v1/admin/totals?from=2026-11-02&to=2026-11-01")).status,
    ).toBe(400);
    expect(
      (await admin("/v1/admin/totals?from=2026-01-01&to=2026-11-01")).status,
    ).toBe(400);
    expect(
      (await admin("/v1/admin/totals?from=2026-02-30&to=2026-03-01")).status,
    ).toBe(400);
  });

  it("reports pipeline and last receipt in status", async () => {
    await post(report());
    const status = await json<StatusBody>(await admin("/v1/admin/status"));
    expect(status.pipeline[TODAY]).toEqual({ accepted: 1 });
    expect(status.last_received_at).toBe(new Date(NOW).toISOString());
  });

  it("never exposes secrets in responses or the database", async () => {
    await post(report());
    respond = () => {
      throw new Error(
        `failed https://ga.test/mp/collect?api_secret=${GA_SECRET}`,
      );
    };
    await runExport();
    respond = () => new Response("nope", { status: 400 });
    await post(report({ date: addDays(TODAY, -1) }));
    await runExport();
    await admin("/v1/admin/status");
    await admin(`/v1/admin/totals?from=${TODAY}&to=${TODAY}`);
    for (const text of texts) {
      expect(text).not.toContain(GA_SECRET);
      expect(text).not.toContain(ADMIN);
    }
    const dump = JSON.stringify([
      await table("totals"),
      await table("exported"),
      await table("export_log"),
      await table("meta"),
      await table("report_ids"),
    ]);
    expect(dump).not.toContain(GA_SECRET);
    expect(dump).not.toContain(ADMIN);
  });
});

describe("scheduled", () => {
  it("prunes old report_ids and export_log but keeps recent rows", async () => {
    const day = DAY_MS;
    const id = db.prepare(
      "INSERT INTO report_ids (id, nonce, received_at) VALUES (?, 'n', ?)",
    );
    await id.bind("old", NOW - (REPORT_ID_RETENTION_DAYS + 1) * day).run();
    await id.bind("recent", NOW - (REPORT_ID_RETENTION_DAYS - 1) * day).run();
    const log = db.prepare(
      "INSERT INTO export_log (id, date, status, events, value_sum, created_at, updated_at) VALUES (?, ?, 'sent', 1, 1, ?, ?)",
    );
    await log.bind("old", TODAY, NOW - 91 * day, NOW - 91 * day).run();
    await log.bind("recent", TODAY, NOW - 89 * day, NOW - 89 * day).run();
    await worker.scheduled({}, env);
    expect((await table("report_ids")).map((row) => row.id)).toEqual([
      "recent",
    ]);
    expect((await table("export_log")).map((row) => row.id)).toEqual([
      "recent",
    ]);
    expect(calls.length).toBe(0);
  });

  it("exports from cron only when EXPORT_ENABLED is 1", async () => {
    await post(report());
    await worker.scheduled({}, env);
    expect(calls.length).toBe(0);
    env.EXPORT_ENABLED = "1";
    await worker.scheduled({}, env);
    expect(calls.length).toBe(1);
  });
});
