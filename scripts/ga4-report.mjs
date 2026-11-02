// Product report from GA4 Data API sums or from the collector ledger, using the
// same metric math (src/analytics/summary.ts). Prints Markdown.
//
//   npm run ga4:report -- --fixture
//   GA_PROPERTY_ID=123 GA_DATA_TOKEN=$(gcloud auth print-access-token \
//     --scopes=https://www.googleapis.com/auth/analytics.readonly) \
//     npm run ga4:report -- --source ga --from 2026-11-01 --to 2026-11-14
//   STATS_ADMIN_URL=https://stats.example STATS_ADMIN_TOKEN=... \
//     npm run ga4:report -- --source collector --from ... --to ...
//   ... --compare   # ledger vs GA per metric (needs both sets of variables)
import console from "node:console";
import process from "node:process";

const { fetch } = globalThis;
import {
  DATA_API_QUERIES,
  runReportBody,
  runReportRows,
} from "../src/analytics/ga4.ts";
import { addDays, isSeoulDate, seoulDate } from "../src/analytics/report.ts";
import { formatRatio } from "../src/analytics/metrics.ts";
import { summarize } from "../src/analytics/summary.ts";
import { FIXTURE_FROM, FIXTURE_ROWS, FIXTURE_TO } from "./analytics-fixture.ts";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const fixture = args.includes("--fixture");
const compare = args.includes("--compare");
const source = option("--source", "ga");
const trigger = option("--trigger", "user");
const today = seoulDate(Date.now());
const from = fixture ? FIXTURE_FROM : option("--from", addDays(today, -13));
const to = fixture ? FIXTURE_TO : option("--to", addDays(today, -1));
if (!isSeoulDate(from) || !isSeoulDate(to) || from > to) {
  console.error("--from/--to must be YYYY-MM-DD with from <= to");
  process.exit(1);
}
// Moving averages and week-over-week need 13 earlier days.
const fetchFrom = addDays(from, -13);

async function fromGa() {
  const property = process.env.GA_PROPERTY_ID;
  const token = process.env.GA_DATA_TOKEN;
  if (!property || !token)
    throw new Error("GA_PROPERTY_ID and GA_DATA_TOKEN are required");
  const rows = [];
  for (const query of DATA_API_QUERIES) {
    const response = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(runReportBody(query, fetchFrom, to)),
      },
    );
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        `runReport ${query.event}: HTTP ${response.status} ${data.error?.status ?? ""}`,
      );
    rows.push(...runReportRows(query, data));
  }
  return rows;
}
async function fromCollector() {
  const base = process.env.STATS_ADMIN_URL;
  const token = process.env.STATS_ADMIN_TOKEN;
  if (!base || !token)
    throw new Error("STATS_ADMIN_URL and STATS_ADMIN_TOKEN are required");
  const response = await fetch(
    `${base.replace(/\/+$/, "")}/v1/admin/totals?from=${fetchFrom}&to=${to}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok)
    throw new Error(`collector totals: HTTP ${response.status}`);
  const data = await response.json();
  return data.rows.map(({ date, metric, dims, value }) => ({
    date,
    metric,
    dims,
    value,
  }));
}

const ms = (value) =>
  value === null
    ? "N/A"
    : value === Infinity
      ? "> 120m"
      : `${Math.round(value)} ms`;
const num = (value) =>
  value === null ? "N/A" : String(Math.round(value * 100) / 100);
function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}
function render(summary) {
  const out = [
    `# uniDock product report ${summary.from} ~ ${summary.to} (Asia/Seoul)`,
    "",
  ];
  out.push("## 1. Overview", "");
  out.push(
    table(
      [
        "date",
        "active installs",
        "core installs",
        "core rate",
        "core results",
        "7d MA",
        "same weekday -7d",
        "change",
      ],
      summary.overview.map((d) => [
        d.date,
        num(d.activeInstalls),
        d.coreInstalls,
        formatRatio(d.coreRate),
        d.coreResults,
        num(d.activeMovingAverage7),
        num(d.previous),
        formatRatio(d.change),
      ]),
    ),
    "",
    `Period: ${summary.period.activeInstallDays} active install-days (not unique users), core rate ${formatRatio(summary.period.coreRate)} (= sum core / sum active), ${summary.period.coreResults} core results.`,
    "",
  );
  out.push(
    "## 2. Features (learning services; settings excluded from shares)",
    "",
  );
  out.push(
    table(
      [
        "date",
        "service",
        "entries",
        "share",
        "installs",
        "reach",
        "entries per install-day",
      ],
      summary.features.daily.flatMap((d) =>
        d.services.map((s) => [
          d.date,
          s.service,
          s.entries,
          formatRatio(s.share),
          s.installs,
          formatRatio(s.reach),
          num(s.intensity),
        ]),
      ),
    ),
    "",
    table(
      [
        "period",
        "entries",
        "share",
        "install-days",
        "reach",
        "entries per install-day",
      ],
      summary.features.period.map((s) => [
        s.service,
        s.entries,
        formatRatio(s.share),
        s.installDays,
        formatRatio(s.reach),
        num(s.intensity),
      ]),
    ),
    "",
    `Settings entries (not in shares): ${summary.features.settingsEntries}`,
    "",
  );
  out.push(`## 3. Operation quality (trigger=${summary.quality.trigger})`, "");
  const opRow = (o) => [
    o.operation,
    o.version ?? "all",
    o.started,
    o.success,
    o.failure,
    o.timeout,
    o.cancel,
    formatRatio(o.successRate),
    formatRatio(o.cancelRate),
    ms(o.meanMs),
    `<= ${ms(o.p95Ms)}`,
    o.samples,
    Object.entries(o.errors)
      .map(([code, n]) => `${code}:${n}`)
      .join(" ") || "-",
  ];
  const opHeaders = [
    "operation",
    "version",
    "started",
    "success",
    "failure",
    "timeout",
    "cancel",
    "success rate",
    "cancel rate",
    "mean (success)",
    "approx p95",
    "samples",
    "errors",
  ];
  out.push(table(opHeaders, summary.quality.operations.map(opRow)), "");
  out.push("By extension version (outcomes and latency only):", "");
  out.push(table(opHeaders, summary.quality.byVersion.map(opRow)), "");
  out.push("## 4. Collector reception (by received date)", "");
  out.push(
    table(
      ["date", "statuses"],
      summary.pipeline.map((d) => [
        d.date,
        Object.entries(d.statuses)
          .map(([s, n]) => `${s}:${n}`)
          .join(" ") || "-",
      ]),
    ),
  );
  return out.join("\n");
}
function totalsByKey(rows) {
  const map = new Map();
  for (const row of rows) {
    if (row.date < from || row.date > to) continue;
    const key = `${row.date} ${row.metric} ${row.dims}`;
    map.set(key, (map.get(key) ?? 0) + row.value);
  }
  return map;
}

try {
  if (compare) {
    const [ledger, ga] = await Promise.all([fromCollector(), fromGa()]);
    const a = totalsByKey(ledger);
    const b = totalsByKey(ga);
    const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
    const diffs = keys
      .map((key) => [key, a.get(key) ?? 0, b.get(key) ?? 0])
      .filter(([, x, y]) => x !== y);
    console.log(
      `# Ledger vs GA4 ${from} ~ ${to}: ${keys.length} keys, ${diffs.length} differ`,
    );
    console.log(
      "Expected gaps: GA processing delay (24-48h), exports with result 'unknown', dates past the 72h export window. See /v1/admin/status.",
    );
    if (diffs.length)
      console.log(table(["date metric dims", "ledger", "GA4"], diffs));
  } else {
    const rows = fixture
      ? FIXTURE_ROWS
      : source === "collector"
        ? await fromCollector()
        : await fromGa();
    console.log(render(summarize(rows, from, to, trigger)));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "report failed");
  process.exitCode = 1;
}
