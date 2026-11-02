import { MAX_REPORT_BYTES } from "../../../src/analytics/report.ts";
import { handleAdmin, jsonResponse, type AdminEnv } from "./admin.ts";
import { runExport, type Fetch } from "./export.ts";
import { bumpPipeline, cleanup, ingestReport } from "./ledger.ts";

export interface Env extends AdminEnv {
  ALLOWED_ORIGINS?: string;
  EXPORT_ENABLED?: string;
}
export interface WorkerDeps {
  now?: () => number;
  fetch?: Fetch;
}

const CONTENT_TYPES = ["text/plain", "application/json"];

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function corsHeaders(origin: string): Record<string, string> {
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

async function readBody(request: Request): Promise<string | null> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > MAX_REPORT_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REPORT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function handleReport(
  request: Request,
  env: Env,
  now: number,
): Promise<Response> {
  const origin = allowedOrigin(request, env);
  if (origin === null) return jsonResponse({ status: "forbidden" }, 403);
  const cors = corsHeaders(origin);
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        "cache-control": "no-store",
      },
    });
  if (request.method !== "POST")
    return jsonResponse({ status: "method_not_allowed" }, 405, cors);
  const type = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (!type || !CONTENT_TYPES.includes(type)) {
    await bumpPipeline(env.DB, now, "invalid");
    return jsonResponse({ status: "invalid" }, 415, cors);
  }
  const text = await readBody(request);
  if (text === null) {
    await bumpPipeline(env.DB, now, "invalid");
    return jsonResponse({ status: "invalid" }, 413, cors);
  }
  const result = await ingestReport(env.DB, text, now);
  return jsonResponse({ status: result.status }, result.http, cors);
}

export function createWorker(deps: WorkerDeps = {}) {
  const clock = deps.now ?? (() => Date.now());
  const fetchFn: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const now = clock();
      if (url.pathname === "/v1/reports")
        return handleReport(request, env, now);
      if (url.pathname.startsWith("/v1/admin/"))
        return handleAdmin(request, env, { now, fetch: fetchFn }, url);
      return jsonResponse({ status: "not_found" }, 404);
    },
    async scheduled(_controller: unknown, env: Env): Promise<void> {
      const now = clock();
      try {
        await cleanup(env.DB, now);
      } catch {
        // Retried by the next cron tick.
      }
      if (env.EXPORT_ENABLED !== "1") return;
      try {
        await runExport(env, { now, fetch: fetchFn });
      } catch {
        // The lease expires and the next cron tick retries.
      }
    },
  };
}

export default createWorker();
