import http from "node:http";
import console from "node:console";
import process from "node:process";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import { createWorker } from "../server/stats/src/worker.ts";
import { createSqliteD1 } from "../server/stats/test/sqlite-d1.ts";

const { Request } = globalThis;
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const port = Number(option("--port", "8787"));
const dbPath = option("--db", ":memory:");
const origin = `http://127.0.0.1:${port}`;

const db = createSqliteD1(dbPath);
db.exec(
  fs.readFileSync(
    new URL("../server/stats/schema.sql", import.meta.url),
    "utf8",
  ),
);

const env = {
  DB: db,
  GA_MEASUREMENT_ID: "G-DEVMOCK",
  GA_API_SECRET: "dev-mock-secret",
  GA_ENDPOINT: `${origin}/mock-ga`,
  ALLOWED_ORIGINS:
    process.env.DEV_ALLOWED_ORIGINS ?? `chrome-extension://dev,${origin}`,
  ADMIN_TOKEN: process.env.DEV_ADMIN_TOKEN ?? "dev-admin",
  EXPORT_ENABLED: "0",
};
const worker = createWorker();

const mockPayloads = [];
let debugRequests = 0;

function handleMock(url, body, res) {
  const json = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (req_isPayloads(url)) return json(200, mockPayloads);
  const debug = url.pathname === "/mock-ga/debug/mp/collect";
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return json(400, { error: "bad_json" });
  }
  if (debug) {
    debugRequests++;
    console.log(
      `mock-ga validate events=${payload.events?.length ?? 0} requests=${debugRequests}`,
    );
    return json(200, { validationMessages: [] });
  }
  mockPayloads.push(payload);
  console.log(
    `mock-ga collect events=${payload.events?.length ?? 0} requests=${mockPayloads.length}`,
  );
  res.writeHead(204);
  res.end();
}
const req_isPayloads = (url) => url.pathname === "/mock-ga/payloads";

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url ?? "/", origin);
  if (
    url.pathname === "/mock-ga/mp/collect" ||
    url.pathname === "/mock-ga/debug/mp/collect" ||
    url.pathname === "/mock-ga/payloads"
  )
    return handleMock(url, raw.toString("utf8"), res);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? raw : undefined,
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`stats dev server on ${origin} (db: ${dbPath})`);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close();
    db.close();
    process.exit(0);
  });
