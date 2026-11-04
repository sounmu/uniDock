# PROJECT KNOWLEDGE BASE

**Generated:** 2026-11-04
**Commit:** 28fb0e3
**Branch:** feat/v0.5.1-ui-multi-university

## OVERVIEW
uniDock 0.5.1: unofficial Korea University LMS helper (mylms/canvas/kucom.korea.ac.kr) as a Chrome MV3 extension, Chrome >= 114. WXT 0.21 + React 19 side panel over framework-free strict TS in `src/`; reads the LMS through the user's own session, never stores cookies/tokens. UI copy is Korean.

## STRUCTURE
```
unidock/
├── wxt.config.ts     # build flags -> manifest() permissions/CSP + Vite define; manifest is generated here
├── entrypoints/      # thin WXT wiring only (worker, content scripts, popup script) -> entrypoints/AGENTS.md
│   └── sidepanel/    # entire React UI surface -> entrypoints/sidepanel/AGENTS.md
├── src/              # framework-free domain/protocol/transport -> src/AGENTS.md
│   ├── security/     # origin/path allowlist, redaction, fixed-code logger; most-imported dir
│   ├── captions/     # caption extraction + AI caption pipeline (flag-gated)
│   ├── playback/     # sequential playback runtime (flag-gated)
│   └── analytics/    # consented aggregate stats; wire format shared with Go collector
├── tests/            # flat Vitest files named after modules + fixtures/ -> tests/AGENTS.md
│   └── e2e/          # Playwright against built .output/chrome-mv3 -> tests/e2e/AGENTS.md
├── scripts/          # .mjs CLIs: release gate, contract pins, pages sync (no AGENTS.md; see NOTES)
├── documentation/    # Korean prose; api/ = vendored, hash-pinned server contract
├── docs/             # GitHub Pages static site, kept in sync by scripts/pages.mjs
└── release/          # package-release.mjs output (lint-ignored)
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Add/change a permission, host, CSP origin | `wxt.config.ts` `manifest()` | never hand-write a manifest |
| New build-time feature flag | `wxt.config.ts` `buildFlags()` + `src/build-flags.d.ts` | gate at call sites in `entrypoints/` |
| Panel <-> worker <-> content message | `src/protocol.ts`, `src/transport.ts` | `{ version: 1, type }`, sender-validated |
| Any LMS fetch / URL | `src/security/policy.ts` (`readUrl`) | allowlist only; no generic proxy |
| Logging | `src/security/logger.ts` | only `console` user in repo |
| Canvas API, pagination, course lookup | `src/api/` | GET-only; covered by src/AGENTS.md |
| Captions / AI captions | `src/captions/` | needs `UNIDOCK_AI_CAPTIONS=1` + caption server |
| Sequential playback | `src/playback/runtime.ts` | needs `UNIDOCK_PLAYBACK=1` |
| Usage stats contract | `src/analytics/`, `tests/analytics-report-contract.test.ts` | mirrored by `sounmu/unidock-server` |
| UI screens / primitives | `entrypoints/sidepanel/screens`, `ui/` | Korean copy is test-selected |
| Release packaging rules | `scripts/package-release.mjs` | the actual release gate |
| Server contract pin | `scripts/check-server-contract.mjs`, `documentation/api/` | sha256 pin, contract 1.0.0 |

## CODE MAP
Refs not measured (no LSP/ast-grep on this workstation; centrality from import grep).

| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| protocol types/guards | module | `src/protocol.ts` | most-imported | closed message schemas |
| `panelSender` / `backgroundSender` | fn | `src/transport.ts` | - | sender validation |
| `readUrl` | fn | `src/security/policy.ts` | 24+ importers (dir) | LMS URL allowlist |
| `redactText` | fn | `src/security/` | - | ID/URL/email/secret scrubbing |
| `TabRateLimiter` | class | `src/security/` | - | per-tab request limiting |
| `PlaybackRuntime` | class | `src/playback/runtime.ts` | - | serial state lane, lease auth |
| `checkServerContract` | fn | `scripts/check-server-contract.mjs` | test-imported | contract hash pin |
| `buildFlags` | fn | `wxt.config.ts` | - | env -> flags, lazily read |

## CONVENTIONS
- Build variants come from env, never code branches: `UNIDOCK_PLAYBACK`, `UNIDOCK_AI_CAPTIONS` (requires `UNIDOCK_CAPTION_SERVER`, bare https origin), `UNIDOCK_STATS_SERVER`, `UNIDOCK_EXTENSION_KEY`, `UNIDOCK_RELEASE`. They become `__UNIDOCK_*__` Vite constants AND change manifest permissions/CSP.
- `wxt.config.ts` reads flags lazily inside hooks (WXT loads `.env*` after module eval).
- Untrusted input enters as `unknown` and passes `is*`/`parse*` guards.
- Persisted state uses a serial-lane single writer (playback, analytics); MV3 worker timers must be backed by `chrome.alarms`.
- kebab-case files, named exports, no `index.ts` barrels.
- `tsconfig`: strict + `noUncheckedIndexedAccess`; `vitest/globals` types are on.

## ANTI-PATTERNS (THIS PROJECT)
- ESLint errors: `no-console`, `@typescript-eslint/no-explicit-any` (ts/tsx).
- Never log URLs, IDs, titles, tokens or error objects; the logger takes fixed allowlisted codes only.
- No generic fetch/HTTP proxy in the worker; the panel passes only opaque one-use handles, never URLs/endpoints/accounts.
- Content scripts never read extension storage (`TRUSTED_CONTEXTS`); never inject MAIN-world player calls.
- Never hand-edit `documentation/api/*`, `tests/fixtures/python-*.json`, or other pinned/generated contract artifacts; regenerate.
- Never replace fixture placeholders with real tokens/PII.
- Do not move `lms.korea.ac.kr` (or the caption CDN) into required `host_permissions`; optional keeps updates from re-prompting.
- Release builds must carry no traces of unreleased features; no hidden review/demo modes.
- Renaming `entrypoints/lms.content.ts` or the popup content script breaks hardcoded `content-scripts/lms.js` / `lms-popup.js` paths in `src/update-notice.ts` / `src/popup-settings.ts`.
- Changing Korean UI copy or accessible names breaks unit and e2e selectors.

## UNIQUE STYLES
- Docs are Korean prose with English identifiers in backticks.
- Contract tests pin external systems: analytics golden fixtures (Go collector), caption API (`tests/caption-api-contract.test.ts`, `tests/server-contract-pin.test.mjs`).
- Dev builds never send analytics (`import.meta.env.PROD` gate); without `UNIDOCK_STATS_SERVER` the build sends nothing.

## COMMANDS
```bash
npm run dev                 # WXT HMR; may add localhost perms - verify sessions on a production build
npm run build:core          # both features off -> .output/chrome-mv3
npm run build:playback | build:ai-captions
npm run typecheck           # wxt prepare && tsc --noEmit
npm run lint && npm test    # vitest run (excludes tests/e2e/**)
npm run test:e2e            # build:core + playwright; also :playback :ai-captions :full :analytics
npm run check               # pages:check + server-contract:check + lint + typecheck + test + build
npm run contract:check      # python3 generators; contract:refresh rewrites fixtures
npm run release             # notices + UNIDOCK_RELEASE=1 check + npm audit + package-release
```

## NOTES
- Node >= 22.13 (CI on 24). CI order: pages:check, server-contract:check, lint, typecheck, test --coverage (v8, 80%), build, test:e2e, test:e2e:analytics, `UNIDOCK_RELEASE=1` test:e2e:full.
- Release requires PLAYBACK=1 + AI_CAPTIONS=1 with real (non-`*.test`) caption/stats origins; rejects eval/new Function/sourceMappingURL/localhost/GA/PostHog markers; drops manifest `key`.
- `documentation/api` manifest names `captions-public.openapi.yaml`, repo file is `public.openapi.yaml`.
- `documentation/ROADMAP.md` lists 3 features that conflict with src/AGENTS.md prohibitions; update policy before building them.
- `scripts/store-render.tsx`, `brand-assets.mjs` hardcode the macOS Chrome path.
- Extension version is independent of server/API contract versions.
