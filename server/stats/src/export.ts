import {
  addDays,
  seoulDate,
  type Metric,
  type Row,
} from "../../../src/analytics/report.ts";
import {
  GA_MAX_EVENTS_PER_REQUEST,
  gaTimestampMs,
  rowsToGaEvents,
} from "../../../src/analytics/ga4.ts";
import type { D1Database } from "./d1.ts";
import { addRows, metaStatement } from "./ledger.ts";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;
export interface ExportEnv {
  DB: D1Database;
  GA_MEASUREMENT_ID?: string;
  GA_API_SECRET?: string;
  GA_ENDPOINT?: string;
}
export interface ExportDeps {
  now: number;
  fetch: Fetch;
}
export interface ExportSummary {
  requests: number;
  sent: number;
  failed: number;
  rejected: number;
  unknown: number;
  skippedDates: string[];
  skipped?: "not_configured" | "lease_held";
  validation?: {
    date: string;
    events: number;
    validationMessages: unknown[];
  }[];
}

const DEFAULT_ENDPOINT = "https://www.google-analytics.com";
const LEASE_MS = 5 * 60_000;
const STUCK_MS = 15 * 60_000;
const SEND_TIMEOUT_MS = 10_000;
const EXPORT_LOOKBACK_DAYS = 3;

interface Delta {
  metric: Metric;
  dims: string;
  delta: number;
}

async function deltaRows(db: D1Database, date: string): Promise<Row[]> {
  const { results } = await db
    .prepare(
      "SELECT t.metric AS metric, t.dims AS dims, t.value - COALESCE(e.value, 0) AS delta " +
        "FROM totals t LEFT JOIN exported e ON e.date = t.date AND e.metric = t.metric AND e.dims = t.dims " +
        "WHERE t.date = ? AND t.value - COALESCE(e.value, 0) > 0 ORDER BY t.metric, t.dims",
    )
    .bind(date)
    .all<Delta>();
  return results.map((row) => ({
    metric: row.metric,
    dims: row.dims,
    value: row.delta,
  }));
}

function clientId(now: number): string {
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return `${random & 0x7fffffff}.${Math.floor(now / 1000)}`;
}

type SendKind = "sent" | "failed" | "rejected" | "unknown";
interface SendResult {
  kind: SendKind;
  messages?: unknown[];
}

async function send(
  url: string,
  body: string,
  fetchFn: Fetch,
  validate: boolean,
): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    return { kind: "unknown" };
  }
  let messages: unknown[] | undefined;
  if (validate) {
    try {
      const parsed: unknown = await response.json();
      const list =
        parsed && typeof parsed === "object"
          ? (parsed as { validationMessages?: unknown }).validationMessages
          : undefined;
      messages = Array.isArray(list) ? list : [];
    } catch {
      messages = [];
    }
  }
  if (response.status >= 200 && response.status < 300)
    return { kind: "sent", messages };
  if (response.status === 429 || response.status >= 500)
    return { kind: "failed", messages };
  return { kind: "rejected", messages };
}

async function acquireLease(db: D1Database, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('export_lease', ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value " +
        "WHERE CAST(meta.value AS INTEGER) <= ?",
    )
    .bind(String(now + LEASE_MS), now)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function runExport(
  env: ExportEnv,
  deps: ExportDeps,
  options: { validate?: boolean } = {},
): Promise<ExportSummary> {
  const summary: ExportSummary = {
    requests: 0,
    sent: 0,
    failed: 0,
    rejected: 0,
    unknown: 0,
    skippedDates: [],
  };
  if (!env.GA_MEASUREMENT_ID || !env.GA_API_SECRET)
    return { ...summary, skipped: "not_configured" };
  const validate = options.validate === true;
  const { DB: db } = env;
  const { now, fetch: fetchFn } = deps;
  const endpoint = (env.GA_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const url =
    `${endpoint}${validate ? "/debug" : ""}/mp/collect` +
    `?measurement_id=${encodeURIComponent(env.GA_MEASUREMENT_ID)}` +
    `&api_secret=${encodeURIComponent(env.GA_API_SECRET)}`;
  if (validate) summary.validation = [];

  if (!validate) {
    if (!(await acquireLease(db, now)))
      return { ...summary, skipped: "lease_held" };
    await db
      .prepare(
        "UPDATE export_log SET status = 'unknown', updated_at = ? WHERE status = 'sending' AND updated_at < ?",
      )
      .bind(now, now - STUCK_MS)
      .run();
  }

  try {
    const today = seoulDate(now);
    let stop = false;
    for (let offset = -EXPORT_LOOKBACK_DAYS; offset <= 0 && !stop; offset++) {
      const date = addDays(today, offset);
      const ts = gaTimestampMs(date, now);
      if (ts === null) {
        summary.skippedDates.push(date);
        continue;
      }
      const events = rowsToGaEvents(await deltaRows(db, date));
      for (let at = 0; at < events.length; at += GA_MAX_EVENTS_PER_REQUEST) {
        const chunk = events.slice(at, at + GA_MAX_EVENTS_PER_REQUEST);
        const rows = chunk.flatMap((event) => event.rows);
        const valueSum = rows.reduce((total, row) => total + row.value, 0);
        const logId = crypto.randomUUID();
        if (!validate)
          await db.batch([
            addRows(db, "exported", date, rows),
            db
              .prepare(
                "INSERT INTO export_log (id, date, status, events, value_sum, created_at, updated_at) VALUES (?, ?, 'sending', ?, ?, ?, ?)",
              )
              .bind(logId, date, chunk.length, valueSum, now, now),
          ]);
        const body = JSON.stringify({
          client_id: clientId(now),
          timestamp_micros: String(ts * 1000),
          non_personalized_ads: true,
          events: chunk.map(({ name, params }) => ({ name, params })),
        });
        summary.requests++;
        const result = await send(url, body, fetchFn, validate);
        summary[result.kind === "sent" ? "sent" : result.kind]++;
        if (validate) {
          summary.validation?.push({
            date,
            events: chunk.length,
            validationMessages: result.messages ?? [],
          });
          if (result.kind === "failed" || result.kind === "rejected")
            stop = true;
        } else if (result.kind === "failed" || result.kind === "rejected") {
          const revert = rows.map((row) => ({ ...row, value: -row.value }));
          await db.batch([
            addRows(db, "exported", date, revert),
            db
              .prepare(
                "UPDATE export_log SET status = ?, updated_at = ? WHERE id = ?",
              )
              .bind(result.kind, now, logId),
          ]);
          stop = true;
        } else {
          await db
            .prepare(
              "UPDATE export_log SET status = ?, updated_at = ? WHERE id = ?",
            )
            .bind(result.kind, now, logId)
            .run();
        }
        if (stop) break;
      }
    }
    if (!validate) {
      const status =
        summary.failed > 0
          ? "failed"
          : summary.rejected > 0
            ? "rejected"
            : summary.unknown > 0
              ? "unknown"
              : "ok";
      await db.batch([
        metaStatement(db, "last_export_at", String(now)),
        metaStatement(db, "last_export_status", status),
      ]);
    }
  } finally {
    if (!validate)
      await db.prepare("DELETE FROM meta WHERE key = 'export_lease'").run();
  }
  return summary;
}
