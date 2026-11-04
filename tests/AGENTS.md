# tests/

## OVERVIEW
Vitest unit/UI suites (flat, ~60 files) plus `e2e/` (Playwright, own AGENTS.md) and `fixtures/` (data only). Earned its file as the largest tree in the repo (62 files, ~20k LOC, ~8 matrix points) and a distinct domain: the test harness and contract pins.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| React mount / click / race helpers | `ui-helpers.tsx` | `mount`, `click(label, index)`, `deferred<T>()` |
| Caption server fakes | `caption-server-helpers.ts` | `fixture(name)` reads `fixtures/caption-api/`, `json()`, `googleRedirect()`, fixed `EXTENSION_ID` |
| Content-script protocol, cache, accounts | `content.test.ts` | 2,008 LOC, the largest unit suite |
| Background, playback runtime | `background.test.ts`, `playback-runtime.test.ts` | ~1,580 LOC each |
| Python CLI parity | `contract.test.ts`, `items-ui.test.tsx`, `recordings.test.ts` | read `fixtures/python-contract.json` |
| Legacy caption parity | `captions-legacy-contract.test.ts` | dynamically imports `fixtures/python-captions.json` |
| Server contract pin | `server-contract-pin.test.mjs`, `analytics-report-contract.test.ts`, `caption-api-contract.test.ts` | check `documentation/api/*` + `fixtures/analytics-report-contract.json` |
| Generated fixtures | `fixtures/` | see table below |

## FIXTURES (`fixtures/`, scored < 8, so it has no AGENTS.md of its own)
| File | Source | Rule |
|------|--------|------|
| `python-contract.json` | `scripts/generate_contract.py` | regenerate with `npm run contract:refresh`; never hand-edit |
| `python-captions.json` | `scripts/generate_caption_contract.py` | holds sha256 provenance of upstream ku-lms-cli files |
| `analytics-report-contract.json` | vendored server artifact (5,292 LOC) | hash-pinned by `documentation/api/server-contract.manifest.json`; a one-byte change fails `server-contract:check` |
| `caption-api/*.json` | hand-written, one file per API response or state | name by scenario: `job-*`, `error-*`, `session*`, `me`, `transcript`, `service-status` |
| `media/*.mp4` | binary ISO-BMFF clips | read via `readFile`/`readdir` (`caption-audio-extract`, e2e `ai-captions-lifecycle`) |
| `courses.json` | used by `core.test.ts` | contains `"token":"fixture-secret"` |

## CONVENTIONS
- One suite per module, named after it: `<module>.test.ts`, or `<feature>-ui.test.tsx` for React. There are no subfolders besides `e2e/` and `fixtures/`.
- jsdom is opted into per file with `// @vitest-environment jsdom` (plus `@vitest-environment-options` when a URL matters). The global environment is node.
- `vitest.config.ts` defines `__UNIDOCK_PLAYBACK__`/`__UNIDOCK_AI_CAPTIONS__` = true, caption server `https://captions.test`, stats `https://stats.test`. Unit tests always see the full feature build.
- Coverage thresholds are 80% across statements, branches, functions, and lines, scoped to `src/**` + `entrypoints/**` (except `entrypoints/sidepanel/main.tsx`). CI runs `npm run test -- --coverage`.
- `chrome` is stubbed per test with `vi.stubGlobal("chrome", ...)` and torn down in `afterEach` with `vi.unstubAllGlobals()` (often plus `vi.restoreAllMocks()`). Races use `deferred()` from `ui-helpers.tsx` (10 suites) or `vi.useFakeTimers` (20 suites).
- UI assertions select by visible Korean text and accessible names (`click(label)` matches exact button/summary text). Lifecycle-sensitive UI tests wrap in React StrictMode.
- `server-contract-pin.test.mjs` is the only `.mjs` suite. It imports `scripts/check-server-contract.mjs` directly and mutates copies in `os.tmpdir()`.

## ANTI-PATTERNS
- Hand-editing `python-contract.json`, `python-captions.json`, or `analytics-report-contract.json`: regenerate them or re-vendor them, then re-pin.
- Replacing placeholder secrets (`at_aaaa…`, `rt_bbbb…`, `fixture-secret`, `user_id=12345678`, `example.invalid`) with real tokens or PII.
- Adding Playwright specs here: Vitest excludes only `tests/e2e/**`, so anything outside `e2e/` runs under Vitest.
- Renaming Korean copy or accessible names in the UI without updating these suites; they are the selectors.
- Assuming a shared setup file: `vitest.config.ts` has no `setupFiles`, so a suite that stubs `chrome` without its own `afterEach` unstub leaks the stub into the rest of that file.
