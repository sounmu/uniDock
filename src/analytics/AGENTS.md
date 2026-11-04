# src/analytics/ - consented aggregate usage statistics

## OVERVIEW
Panel signals -> background `AnalyticsRuntime` -> sealed daily reports POSTed to the stats collector (`__UNIDOCK_STATS_SERVER__`, prod builds only).
Earned its file: score ~8.3 (only 3 files but 70 exports, `runtime.ts` ~700 LOC hotspot, shared wire contract with an external Go service) + distinct privacy-sensitive domain.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Wire schema, closed code lists | `report.ts` | `SERVICES`, `OPERATIONS`, `TRIGGERS`, `OUTCOMES`, `ERROR_CODES`, `LATENCY_BUCKETS`, `REPORT_SCHEMA`, `MAX_REPORT_BYTES`, `DailyReport` + `is*` validators |
| Day boundaries | `report.ts` `seoulDate`, `seoulDayStart`, `SEOUL_OFFSET_MS` | all days are Asia/Seoul calendar dates |
| Panel -> background messages | `contract.ts` | `AnalyticsSignal`/`isAnalyticsSignal`, `AnalyticsCommand`/`isAnalyticsCommand`, `record`, `collecting` |
| Settings / consent state | `contract.ts` | `ANALYTICS_SETTINGS_KEY`, `ANALYTICS_STATE_KEY`, `AnalyticsNotice`; `LEGACY_ANALYTICS_KEY` = PostHog-era consent removed on migration |
| Runtime (queue, seal, send) | `runtime.ts` `AnalyticsRuntime`, `parseState` | `SEAL_INTERVAL_MS`, `FIRST_SEAL_DELAY_MS`, `MAX_QUEUE`, `MAX_ATTEMPTS`; wakes via `ANALYTICS_ALARM`; sends to `${endpoint}/v1/reports` through injected `deps.fetch` |
| Wiring | `entrypoints/background.ts` | stats origin is `""` outside `import.meta.env.PROD` |
| Tests | `tests/analytics.test.ts`, `analytics-client.test.ts`, `analytics-report-contract.test.ts`, `tests/e2e/analytics-consent.spec.ts` | |

## CONVENTIONS
- `report.ts` is dependency-free and mirrors the Go collector in `unidock-server/stats`; both are checked against shared golden fixtures. Any schema change is a cross-repo change.
- Every report value is a closed code, a bounded integer, or a Seoul date - no free text, URLs, LMS data, or install identifiers.
- `AnalyticsRuntime` is the single writer: all read-modify-write of settings, day flags, pending deltas, and the report queue runs on one serial lane; network I/O runs outside it.
- Collection starts only after the panel has shown the consent notice (`AnalyticsNotice`).
- Malformed persisted parts are dropped, never repaired (`parseState`). The exact report bytes are resent on every retry.
- Delivery accounting is conservative: after an ambiguous send, do not invent a second denominator and do not emit numerators whose denominator may be lost.
- Timers die with the MV3 worker; anything scheduled must also arm `chrome.alarms`.

## ANTI-PATTERNS
- Never put operation IDs, labels, URLs, raw errors, or LMS fields into an `AnalyticsSignal`; only fixed codes plus one bounded duration.
- Never add an install UUID or any per-user identifier (the PostHog-era UUID was deliberately removed).
- Never write analytics storage outside the runtime's serial lane.
- Never extend a code list in `report.ts` without updating the collector and golden fixtures.
- Do not send reports from dev builds.
