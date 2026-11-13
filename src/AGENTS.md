# src/ - extension domain and service layer

## OVERVIEW
Framework-free TypeScript behind WXT entrypoints (`entrypoints/`): LMS API client, message protocol, domain projections, and feature modules. No React/TSX here; UI lives in `entrypoints/sidepanel/`.
Subtree root (always documented). 58 files, ~10.5k LOC, 6 child dirs.

## STRUCTURE
```
src/
├── *.ts          # protocol, transport, domain projections, registries, settings
├── api/          # Canvas/LearningX GET client + collectors (covered here)
├── analytics/    # aggregate usage stats -> own AGENTS.md
├── captions/     # caption extraction + AI caption jobs -> own AGENTS.md
├── playback/     # sequential playback (flag-gated) -> own AGENTS.md
├── security/     # URL policy, redaction, logging, rate limit -> own AGENTS.md
└── pdf/          # handoff.ts: redacted prompt copy + open ChatGPT (covered here)
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Panel/content/background message shapes | `protocol.ts`, `protocol-fields.ts` | Most-imported module (~22 importers in tests/entrypoints); `errors`, `request`, `validHandle`, `DOWNLOAD_REQUEST_WINDOW_MS` |
| Panel -> active LMS tab queries | `transport.ts` | `queryActive`, `queryActiveCourses` |
| Course/assignment/deadline projections | `domain.ts`, `domain-items.ts`, `deadline-view.ts` | Raw LMS JSON -> `Course`, `Deadline`, `Todo`... |
| Recordings / documents | `recordings.ts`, `documents.ts` | candidates, labels, MIME/extension checks |
| LMS list fetching | `api/client.ts` | `listCourses`, `listCourseIndex`, `listQuery`; composes `api/*-collection.ts`, `pagination.ts`, `body.ts` |
| LMS account / playback discovery | `api/account.ts`, `api/playback-discovery.ts` | `currentAccount`, `discoverPlayback`; content entrypoint retains lifecycle and epoch checks |
| Opaque item handles | `navigation-catalog.ts`, `navigation-catalog-registry.ts`, `course-selector-registry.ts` | capacity-bounded, TTL'd admissions |
| Panel result caching | `query-result-cache.ts` | |
| Downloads / tab opening | `download-tab.ts`, `open-tab.ts` | `download-tab.ts` uses `TabRateLimiter` + `security/download` |
| LMS popup auto-close | `lms-popup.ts`, `popup-settings.ts` | optional host permission `POPUP_PERMISSION` |
| AI caption server auth/session | `caption-server-settings.ts` | `signIn`, `authorizedFetch`, `signOutEverywhere` |
| Update badge | `update-notice.ts` | |
| Build-time constants | `build-flags.d.ts` | `__UNIDOCK_PLAYBACK__`, `__UNIDOCK_AI_CAPTIONS__`, `__UNIDOCK_CAPTION_SERVER__`, `__UNIDOCK_STATS_SERVER__` (replaced by `wxt.config.ts`) |

## CONVENTIONS
- Flat kebab-case modules; a folder only when a feature spans several files. No `index.ts` barrels: import the exact file (`../security/policy`).
- Dependency direction: root modules and feature dirs import `security/` freely; `security/` reaches back only to `protocol.ts` (`validDate`) and `documents.ts`. Root -> feature imports are rare and deliberate: `download-tab.ts` -> `playback/bridge` (`object` guard), `caption-server-settings.ts` -> `captions/server-http`.
- Boolean feature flags (`__UNIDOCK_PLAYBACK__`, `__UNIDOCK_AI_CAPTIONS__`) gate at call sites in `entrypoints/` (`background.ts`, `lms.content.ts`, `sidepanel/App.tsx`), never inside `src/`, so dead code drops from release builds. Only the string origin `__UNIDOCK_CAPTION_SERVER__` is read inside `src/` (empty => `NO_SERVER`).
- Untrusted input (LMS JSON, page/MAIN-world results, messages) enters as `unknown` and passes `is*`/`parse*` guards; JSON bodies via `api/body.ts` `readJsonBounded`.
- `chrome.*` is touched by a limited set of files (storage, scripting, tabs, alarms); pure modules stay testable under Vitest without chrome mocks.
- Tests are flat in `/tests`, named after the module (`documents.test.ts`, `playback-runtime.test.ts`, `caption-job-client.test.ts`).

## ANTI-PATTERNS
- Never add a generic fetch/proxy: every LMS request URL is built internally and validated by `security/policy.ts` `readUrl` against a fixed path allowlist.
- Never put URLs, IDs, titles, or error objects into logs; use `security/logger.ts` fixed codes only.
- Never let the panel supply endpoints, URLs, or account data across the protocol; it sends opaque handles only.
- Do not reference the `__UNIDOCK_*__` constants from new `src/` modules without updating `build-flags.d.ts` and `wxt.config.ts` together.
