// Registers the event-scoped custom dimensions/metrics the aggregate events
// need, and checks the property time zone. Dry run unless --apply.
//
//   npm run ga4:setup                       # print the definitions table
//   GA_ADMIN_TOKEN=$(gcloud auth print-access-token \
//     --scopes=https://www.googleapis.com/auth/analytics.edit) \
//   npm run ga4:setup -- --property 123456789 --apply [--set-timezone]
import console from "node:console";
import process from "node:process";
import { URL } from "node:url";

const { fetch } = globalThis;
import { CUSTOM_DIMENSIONS, CUSTOM_METRICS } from "../src/analytics/ga4.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const property = option("--property");
const apply = flag("--apply");

console.log("Custom dimensions (scope EVENT):");
console.table(CUSTOM_DIMENSIONS);
console.log("Custom metrics (scope EVENT, unit STANDARD, aggregated as SUM):");
console.table(CUSTOM_METRICS);
if (!apply) {
  console.log(
    "Dry run. Add --property <id> --apply with GA_ADMIN_TOKEN to create missing definitions.",
  );
  process.exit(0);
}
const token = process.env.GA_ADMIN_TOKEN;
if (!property || !/^\d+$/.test(property) || !token) {
  console.error("--apply needs --property <numeric id> and GA_ADMIN_TOKEN.");
  process.exit(1);
}
const base = `https://analyticsadmin.googleapis.com/v1beta/properties/${property}`;
async function call(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `${method} ${new URL(url).pathname}: HTTP ${response.status} ${data.error?.status ?? ""}`,
    );
  return data;
}
const info = await call("GET", base);
console.log(`Property ${property}: time zone ${info.timeZone}`);
if (info.timeZone !== "Asia/Seoul") {
  if (flag("--set-timezone")) {
    await call("PATCH", `${base}?updateMask=timeZone`, {
      timeZone: "Asia/Seoul",
    });
    console.log(
      "Time zone set to Asia/Seoul (applies to data processed from now on).",
    );
  } else
    console.warn(
      "Time zone is not Asia/Seoul. Re-run with --set-timezone or change it in Admin.",
    );
}
const dimensions = await call("GET", `${base}/customDimensions?pageSize=200`);
const metrics = await call("GET", `${base}/customMetrics?pageSize=200`);
const haveDimensions = new Set(
  (dimensions.customDimensions ?? []).map((d) => d.parameterName),
);
const haveMetrics = new Set(
  (metrics.customMetrics ?? []).map((m) => m.parameterName),
);
for (const definition of CUSTOM_DIMENSIONS) {
  if (haveDimensions.has(definition.parameterName)) continue;
  await call("POST", `${base}/customDimensions`, {
    ...definition,
    scope: "EVENT",
  });
  console.log(`created dimension ${definition.parameterName}`);
}
for (const definition of CUSTOM_METRICS) {
  if (haveMetrics.has(definition.parameterName)) continue;
  await call("POST", `${base}/customMetrics`, {
    ...definition,
    scope: "EVENT",
    measurementUnit: "STANDARD",
  });
  console.log(`created metric ${definition.parameterName}`);
}
console.log(
  "Done. Only events received after registration populate these definitions.",
);
