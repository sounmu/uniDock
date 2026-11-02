// Synthetic ledger rows for offline report checks (`npm run ga4:report -- --fixture`)
// and tests. Values follow the worked examples in documentation/ANALYTICS.md.
import type { DatedRow } from "../src/analytics/summary.ts";

const op = "operation=document_download|trigger=user|version=0.5.0";
export const FIXTURE_FROM = "2026-11-01";
export const FIXTURE_TO = "2026-11-02";
export const FIXTURE_ROWS: DatedRow[] = [
  { date: "2026-11-01", metric: "active_installs", dims: "", value: 10 },
  { date: "2026-11-01", metric: "core_installs", dims: "", value: 4 },
  {
    date: "2026-11-01",
    metric: "core_results",
    dims: "core_result=document_downloaded",
    value: 9,
  },
  {
    date: "2026-11-01",
    metric: "service_entries",
    dims: "service=courses",
    value: 7,
  },
  {
    date: "2026-11-01",
    metric: "service_entries",
    dims: "service=tasks",
    value: 3,
  },
  {
    date: "2026-11-01",
    metric: "service_entries",
    dims: "service=settings",
    value: 5,
  },
  {
    date: "2026-11-01",
    metric: "service_installs",
    dims: "service=courses",
    value: 6,
  },
  {
    date: "2026-11-01",
    metric: "service_installs",
    dims: "service=tasks",
    value: 5,
  },
  { date: "2026-11-02", metric: "active_installs", dims: "", value: 10 },
  { date: "2026-11-02", metric: "core_installs", dims: "", value: 6 },
  {
    date: "2026-11-02",
    metric: "service_entries",
    dims: "service=courses",
    value: 2,
  },
  {
    date: "2026-11-02",
    metric: "service_entries",
    dims: "service=tasks",
    value: 8,
  },
  {
    date: "2026-11-02",
    metric: "service_installs",
    dims: "service=courses",
    value: 2,
  },
  {
    date: "2026-11-02",
    metric: "service_installs",
    dims: "service=tasks",
    value: 7,
  },
  { date: "2026-11-02", metric: "op_started", dims: op, value: 12 },
  { date: "2026-11-02", metric: "op_success", dims: op, value: 8 },
  { date: "2026-11-02", metric: "op_failure", dims: op, value: 1 },
  { date: "2026-11-02", metric: "op_timeout", dims: op, value: 1 },
  { date: "2026-11-02", metric: "op_cancel", dims: op, value: 2 },
  { date: "2026-11-02", metric: "op_duration_ms_sum", dims: op, value: 34_000 },
  { date: "2026-11-02", metric: "op_duration_count", dims: op, value: 8 },
  {
    date: "2026-11-02",
    metric: "op_errors",
    dims: `${op}|error_code=INTERRUPTED`,
    value: 1,
  },
  {
    date: "2026-11-02",
    metric: "op_errors",
    dims: `${op}|error_code=TIMEOUT`,
    value: 1,
  },
  {
    date: "2026-11-02",
    metric: "op_latency",
    dims: `${op}|bucket=1to3s`,
    value: 7,
  },
  {
    date: "2026-11-02",
    metric: "op_latency",
    dims: `${op}|bucket=10to30s`,
    value: 1,
  },
  {
    date: "2026-11-02",
    metric: "op_success",
    dims: "operation=playback_refresh|trigger=auto|version=0.5.0",
    value: 3,
  },
  {
    date: "2026-11-01",
    metric: "pipeline_reports",
    dims: "status=accepted",
    value: 20,
  },
  {
    date: "2026-11-02",
    metric: "pipeline_reports",
    dims: "status=duplicate",
    value: 1,
  },
];
