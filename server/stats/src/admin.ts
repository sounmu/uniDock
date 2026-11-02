import {
  DAY_MS,
  addDays,
  isSeoulDate,
  parseDims,
  seoulDate,
  seoulDayStart,
} from "../../../src/analytics/report.ts";
import { gaTimestampMs } from "../../../src/analytics/ga4.ts";
import { runExport, type ExportEnv, type Fetch } from "./export.ts";

export interface AdminEnv extends ExportEnv {
  ADMIN_TOKEN?: string;
}

const STATUS_PIPELINE_DAYS = 14;
const STATUS_EXPORT_DAYS = 30;
const UNEXPORTED_DAYS = 60;
const MAX_TOTALS_DAYS = 92;

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function authorized(request: Request, token: string): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [a, b] = await Promise.all([digest(given), digest(token)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function meta(env: AdminEnv, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

function isoOrNull(value: string | null): string | null {
  return value !== null && Number.isFinite(Number(value))
    ? new Date(Number(value)).toISOString()
    : null;
}

async function status(env: AdminEnv, now: number): Promise<Response> {
  const today = seoulDate(now);
  const pipelineRows = await env.DB.prepare(
    "SELECT date, dims, value FROM totals WHERE metric = 'pipeline_reports' AND date >= ? ORDER BY date",
  )
    .bind(addDays(today, -(STATUS_PIPELINE_DAYS - 1)))
    .all<{ date: string; dims: string; value: number }>();
  const pipeline: Record<string, Record<string, number>> = {};
  for (const row of pipelineRows.results) {
    const key = parseDims(row.dims).status ?? "";
    (pipeline[row.date] ??= {})[key] = row.value;
  }
  const exportRows = await env.DB.prepare(
    "SELECT status, COUNT(*) AS count FROM export_log WHERE created_at >= ? GROUP BY status",
  )
    .bind(now - STATUS_EXPORT_DAYS * DAY_MS)
    .all<{ status: string; count: number }>();
  const exports: Record<string, number> = {};
  for (const row of exportRows.results) exports[row.status] = row.count;
  const unexportedRows = await env.DB.prepare(
    "SELECT t.date AS date, COUNT(*) AS row_count, SUM(t.value - COALESCE(e.value, 0)) AS value_sum " +
      "FROM totals t LEFT JOIN exported e ON e.date = t.date AND e.metric = t.metric AND e.dims = t.dims " +
      "WHERE t.date >= ? AND t.value - COALESCE(e.value, 0) > 0 GROUP BY t.date ORDER BY t.date",
  )
    .bind(addDays(today, -UNEXPORTED_DAYS))
    .all<{ date: string; row_count: number; value_sum: number }>();
  return jsonResponse({
    now: new Date(now).toISOString(),
    last_received_at: isoOrNull(await meta(env, "last_received_at")),
    last_export_at: isoOrNull(await meta(env, "last_export_at")),
    last_export_status: await meta(env, "last_export_status"),
    pipeline,
    exports,
    unexported: unexportedRows.results.map((row) => ({
      date: row.date,
      rows: row.row_count,
      value_sum: row.value_sum,
      exportable: gaTimestampMs(row.date, now) !== null,
    })),
  });
}

async function totals(env: AdminEnv, url: URL): Promise<Response> {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!isSeoulDate(from) || !isSeoulDate(to) || from > to)
    return jsonResponse({ error: "bad_range" }, 400);
  const days = (seoulDayStart(to) - seoulDayStart(from)) / DAY_MS + 1;
  if (days > MAX_TOTALS_DAYS) return jsonResponse({ error: "bad_range" }, 400);
  const { results } = await env.DB.prepare(
    "SELECT t.date AS date, t.metric AS metric, t.dims AS dims, t.value AS value, COALESCE(e.value, 0) AS exported " +
      "FROM totals t LEFT JOIN exported e ON e.date = t.date AND e.metric = t.metric AND e.dims = t.dims " +
      "WHERE t.date >= ? AND t.date <= ? ORDER BY t.date, t.metric, t.dims",
  )
    .bind(from, to)
    .all();
  return jsonResponse({ rows: results });
}

export async function handleAdmin(
  request: Request,
  env: AdminEnv,
  deps: { now: number; fetch: Fetch },
  url: URL,
): Promise<Response> {
  if (!env.ADMIN_TOKEN) return jsonResponse({ error: "not_found" }, 404);
  if (!(await authorized(request, env.ADMIN_TOKEN)))
    return jsonResponse({ error: "unauthorized" }, 401);
  const route = `${request.method} ${url.pathname}`;
  try {
    if (route === "GET /v1/admin/status") return await status(env, deps.now);
    if (route === "GET /v1/admin/totals") return await totals(env, url);
    if (route === "POST /v1/admin/export")
      return jsonResponse(
        await runExport(env, deps, {
          validate: url.searchParams.get("validate") === "1",
        }),
      );
  } catch {
    return jsonResponse({ error: "retry" }, 503);
  }
  const known = [
    "/v1/admin/status",
    "/v1/admin/totals",
    "/v1/admin/export",
  ].includes(url.pathname);
  return jsonResponse(
    { error: known ? "method_not_allowed" : "not_found" },
    known ? 405 : 404,
  );
}
