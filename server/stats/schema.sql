-- uniDock aggregate-statistics collector. Aggregates only: no install ids,
-- no request bodies, no IPs. Apply with:
--   npx wrangler@4 d1 execute unidock-stats --file schema.sql --remote

-- Global per-date totals (the source-of-truth ledger).
CREATE TABLE IF NOT EXISTS totals (
  date TEXT NOT NULL,
  metric TEXT NOT NULL,
  dims TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (date, metric, dims)
) WITHOUT ROWID;

-- Portion of totals already handed to GA4 (at-most-once).
CREATE TABLE IF NOT EXISTS exported (
  date TEXT NOT NULL,
  metric TEXT NOT NULL,
  dims TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (date, metric, dims)
) WITHOUT ROWID;

-- Short-lived one-use report ids for duplicate suppression (pruned by cron).
CREATE TABLE IF NOT EXISTS report_ids (
  id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  received_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS report_ids_received_at ON report_ids (received_at);

-- Aggregate export attempts (no payloads).
CREATE TABLE IF NOT EXISTS export_log (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  status TEXT NOT NULL,
  events INTEGER NOT NULL,
  value_sum INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS export_log_created_at ON export_log (created_at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
