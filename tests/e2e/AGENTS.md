# tests/e2e/

## OVERVIEW
Playwright specs that drive the real built MV3 extension in Chromium against synthetic HTTPS LMS/CDN/caption/stats servers. Distinct domain: different runner, needs a prior build, and runs serially (25 files, 8.4k LOC, ~9 matrix points).

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Fake LMS / CDN server | `synthetic-server.ts` | `syntheticServer(...)` (13 specs), `textPdf(text)`; configurable pagination + course selectors |
| Feature-build gates | `build-shape.ts` | `playbackBuild()`, `aiCaptionsBuild()` read `.output/chrome-mv3/manifest.json`; missing/invalid manifest = feature off |
| Playback lifecycle | `playlist-playback.spec.ts` | 2,308 LOC, largest spec |
| AI caption upload/poll/cancel | `ai-captions-lifecycle.spec.ts` | 713 LOC; uses `../fixtures/media/tail.mp4` |
| Broad smoke | `synthetic-lms.spec.ts` | uses both build-shape gates |
| Analytics consent | `analytics-consent.spec.ts` | run through `npm run test:e2e:analytics` only (see below) |

## COMMANDS
```bash
npm run test:e2e              # build:core (PLAYBACK=0, AI=0) then all specs
npm run test:e2e:playback     # playback build; un-skips playback specs
npm run test:e2e:ai-captions  # AI build with UNIDOCK_CAPTION_SERVER=https://captions.test
npm run test:e2e:full         # everything on; CI runs it with UNIDOCK_RELEASE=1
npm run test:e2e:analytics    # scripts/test-analytics-e2e.mjs: core build + stats.test, then rebuilds normally
```
`playwright.config.ts`: `workers: 1`, `fullyParallel: false`, timeout 45s, expect 10s, artifacts in `.wxt/e2e/` (`preserveOutput: "always"`).

## CONVENTIONS
- Each spec launches `chromium.launchPersistentContext` on a fresh `mkdtemp(tmpdir(), "unidock-…")` profile with `--load-extension` of `.output/chrome-mv3` (override with `UNIDOCK_E2E_EXTENSION_PATH`), and removes it in `finally`.
- Network determinism comes from `--host-resolver-rules=MAP <lms host> 127.0.0.1:<port>, MAP * ~NOTFOUND` + `ignoreHTTPSErrors: true`. No real Korea Univ. host is ever reached.
- Feature-dependent specs open with `test.skip(!playbackBuild(), PLAYBACK_SKIP_REASON)` (or the AI variant), and the reason string names the npm script to run. A core build skips them silently; that is expected, not a pass.
- Subscribe before triggering: `waitForEvent` / request promises are created before the click or navigation, and bounded timeouts replace sleeps.
- Locators are role/label based with Korean accessible names. Many specs carry Given/When/Then comments.
- Kebab-case `*.spec.ts`. Shared helpers are plain kebab-case `.ts` without `.spec`.

## ANTI-PATTERNS
- `page.waitForTimeout` / fixed sleeps for synchronization.
- Hitting live LMS, CDN, caption, or stats hosts, or widening `host-resolver-rules` beyond the synthetic server.
- Running a spec against a stale `.output/`: every script rebuilds first, while bare `npx playwright test` does not.
- Reusing a browser profile across tests, or skipping the `finally` cleanup.
- `eslint-disable no-explicit-any` beyond the two existing page-fixture specs (`ku-initialization-lifecycle`, player fixture), which document why.
