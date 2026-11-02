import {
  DAY_MS,
  REPORT_ID_RETENTION_DAYS,
  REPORT_MAX_AGE_DAYS,
  addDays,
  dims,
  isDailyReport,
  reportRows,
  seoulDate,
  type PipelineStatus,
  type Row,
} from "../../../src/analytics/report.ts";
import type { D1Database, D1PreparedStatement } from "./d1.ts";

export interface Guard {
  id: string;
  nonce: string;
}
export type IngestStatus =
  "accepted" | "duplicate" | "invalid" | "expired" | "retry";
export interface IngestResult {
  http: number;
  status: IngestStatus;
}

const EXPORT_LOG_RETENTION_DAYS = 90;
const GUARD_SQL =
  "WHERE EXISTS (SELECT 1 FROM report_ids WHERE id = ? AND nonce = ?)";

export function addRows(
  db: D1Database,
  table: "totals" | "exported",
  date: string,
  rows: readonly Row[],
  guard?: Guard,
): D1PreparedStatement {
  const payload = JSON.stringify(
    rows.map(({ metric, dims: key, value }) => ({ metric, dims: key, value })),
  );
  const sql =
    `INSERT INTO ${table} (date, metric, dims, value) ` +
    "SELECT ?, json_extract(j.value, '$.metric'), json_extract(j.value, '$.dims'), json_extract(j.value, '$.value') " +
    `FROM json_each(?) AS j ${guard ? GUARD_SQL : "WHERE true"} ` +
    `ON CONFLICT (date, metric, dims) DO UPDATE SET value = ${table}.value + excluded.value`;
  const stmt = db.prepare(sql);
  return guard
    ? stmt.bind(date, payload, guard.id, guard.nonce)
    : stmt.bind(date, payload);
}

export function pipelineStatement(
  db: D1Database,
  date: string,
  status: PipelineStatus,
  guard?: Guard,
): D1PreparedStatement {
  const sql =
    "INSERT INTO totals (date, metric, dims, value) " +
    `SELECT ?, 'pipeline_reports', ?, 1 ${guard ? GUARD_SQL : "WHERE true"} ` +
    "ON CONFLICT (date, metric, dims) DO UPDATE SET value = totals.value + 1";
  const stmt = db.prepare(sql);
  const key = dims([["status", status]]);
  return guard
    ? stmt.bind(date, key, guard.id, guard.nonce)
    : stmt.bind(date, key);
}

export function metaStatement(
  db: D1Database,
  key: string,
  value: string,
  guard?: Guard,
): D1PreparedStatement {
  const sql =
    "INSERT INTO meta (key, value) " +
    `SELECT ?, ? ${guard ? GUARD_SQL : "WHERE true"} ` +
    "ON CONFLICT (key) DO UPDATE SET value = excluded.value";
  const stmt = db.prepare(sql);
  return guard
    ? stmt.bind(key, value, guard.id, guard.nonce)
    : stmt.bind(key, value);
}

/** Best-effort reception counter; failures never surface to the client. */
export async function bumpPipeline(
  db: D1Database,
  now: number,
  status: PipelineStatus,
): Promise<void> {
  try {
    await pipelineStatement(db, seoulDate(now), status).run();
  } catch {
    // Counting rejected traffic is best effort.
  }
}

async function reject(
  db: D1Database,
  now: number,
  http: number,
  status: "invalid" | "expired",
): Promise<IngestResult> {
  await bumpPipeline(db, now, status);
  return { http, status };
}

export async function ingestReport(
  db: D1Database,
  text: string,
  now: number,
): Promise<IngestResult> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return reject(db, now, 400, "invalid");
  }
  if (!isDailyReport(value)) return reject(db, now, 400, "invalid");
  const received = seoulDate(now);
  if (value.date > addDays(received, 1)) return reject(db, now, 400, "invalid");
  if (value.date < addDays(received, -REPORT_MAX_AGE_DAYS))
    return reject(db, now, 422, "expired");

  const guard: Guard = { id: value.report_id, nonce: crypto.randomUUID() };
  const rows = reportRows(value, value.extension_version);
  const status: PipelineStatus =
    value.date === received ? "accepted" : "accepted_late";
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO report_ids (id, nonce, received_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
        )
        .bind(guard.id, guard.nonce, now),
      addRows(db, "totals", value.date, rows, guard),
      pipelineStatement(db, received, status, guard),
      metaStatement(db, "last_received_at", String(now), guard),
    ]);
    const stored = await db
      .prepare("SELECT nonce FROM report_ids WHERE id = ?")
      .bind(guard.id)
      .first<{ nonce: string }>();
    if (stored?.nonce === guard.nonce) return { http: 200, status: "accepted" };
    await pipelineStatement(db, received, "duplicate").run();
    return { http: 200, status: "duplicate" };
  } catch {
    return { http: 503, status: "retry" };
  }
}

export async function cleanup(db: D1Database, now: number): Promise<void> {
  await db
    .prepare("DELETE FROM report_ids WHERE received_at < ?")
    .bind(now - REPORT_ID_RETENTION_DAYS * DAY_MS)
    .run();
  await db
    .prepare("DELETE FROM export_log WHERE created_at < ?")
    .bind(now - EXPORT_LOG_RETENTION_DAYS * DAY_MS)
    .run();
}
