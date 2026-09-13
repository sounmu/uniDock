# Heavy Integrated Gate Review

- recommendation: APPROVE
- blockers: []
- originalIntent: Deliver six coordinated fixes: strict external boolean parsing; LMS-origin-bound item links without changing origin-agnostic closed-protocol parsing; discovery-inclusive transport/caption deadlines that stop subsequent work after expiry while honestly allowing already-dispatched Chrome promises to settle; a real production MV3 Chromium E2E with a synthetic LMS and screenshots; limited behavior-preserving extraction of oversized sidepanel/API responsibilities; and CI coverage floors with accurate README documentation.
- desiredOutcome: The extension rejects malformed boundary values and cross-LMS links, preserves documented undefined/null behavior and closed protocol compatibility, applies total deadlines from before target discovery, exercises the built extension through real Chrome runtime messaging, keeps extracted behavior stable and modules bounded, and enforces reproducible CI coverage at a measured conservative floor.
- userOutcomeReview: PASS. The current worktree produces the requested observable behavior. The full project gate, measured coverage gate, and production Chromium E2E were reproduced; the E2E artifact visibly contains the queried synthetic assignment and functional deadline controls.

## Criterion Review

1. **FIX-1 — PASS.** `src/domain-items.ts` parses each external boolean through one strict boundary helper. `undefined` retains the field-specific default, `null` maps to false, actual booleans are preserved, and string/number/array/object impostors throw `INVALID_RESPONSE`. `tests/items.test.ts` covers all affected assignment, upcoming, and todo fields plus the published default/null semantics and `submitted_at` fallback.
2. **FIX-2 — PASS.** `src/security/item-link.ts` accepts only allowlisted item paths and, when an origin is supplied, requires exact origin equality. `src/api/client.ts` supplies the active API origin to projections; `src/transport.ts` supplies the active tab origin to `parseResult`. Omitting the optional origin retains origin-agnostic closed-protocol parsing, demonstrated by existing `parseResult(result)` tests. Cross-origin projection and transport cases are directly rejected by `tests/item-link.test.ts` and `tests/transport.test.ts`.
3. **FIX-3 — PASS.** `src/transport.ts` creates its 23-second deadline before tab discovery and checks it after every awaited Chrome operation and before every subsequent dispatch. `src/captions/service.ts` does the same with its 15-second deadline; it passes the absolute deadline into the only injected mode that starts network work. `src/captions/extract.ts` caps its fetch controller by remaining total time and refuses a second fetch after expiration. Focused fake-timer regressions prove late discovery/lookup/verification resolution cannot dispatch follow-on work. The implementation does not claim to cancel already-dispatched `chrome.tabs` or `chrome.scripting` promises; it merely races the caller-visible result and gates later work.
4. **FIX-4 — PASS.** `tests/e2e/synthetic-lms.spec.ts` launches the production `.output/chrome-mv3` in persistent real Chromium, serves a synthetic LMS through browser routing, discovers the MV3 service worker, loads the actual sidepanel, queries through real `chrome.tabs` runtime messaging/content script/API fetch, renders courses and assignment/deadline results, exercises deadline controls, and writes/attaches three PNGs plus a trace. Fresh `npm run test:e2e` passed 1/1. The inspected `sidepanel-deadlines.png` visibly shows the synthetic item and Korean deadline UI without the previously reported particle orphan.
5. **FIX-5 — PASS.** The extraction is responsibility-based and limited: `ItemResults.tsx` owns item/deadline presentation, `useSidepanelQuery.ts` owns sidepanel query lifecycle, and `recording-collection.ts` owns the pre-existing bounded concurrent recording collection. Call sites remain thin. Pure LOC is 242 (`App.tsx`), 123 (`ResultList.tsx`), 184 (`ItemResults.tsx`), 201 (`useSidepanelQuery.ts`), 200 (`client.ts`), and 97 (`recording-collection.ts`). Relevant UI/recording evidence and the complete suite are green.
6. **FIX-6 — PASS.** `.github/workflows/ci.yml` installs dependencies and Chromium, then runs lint, typecheck, measured Vitest coverage, build, and the production E2E with read-only repository permissions. `vitest.config.ts` excludes Playwright tests from Vitest and enforces 80% globally across production TS/TSX. Fresh coverage: 87.24% statements, 84.72% branches, 90.56% functions, 90.89% lines. README command, permissions, filtering behavior, manifest, and release descriptions match the current project rather than pinning stale test counts.

## Direct Remove-AI-Slops / Programming Pass

- No skipped, `.only`, deletion-only, removal-verification, tautological, or implementation-mirroring tests were introduced. The new tests assert externally observable boundary, dispatch, UI, and browser behavior.
- No test weakening was found; the test diff adds adversarial malformed inputs, cross-origin cases, deadline sequencing, and browser-level behavior. Small edits in baseline UI tests accommodate the behavior-preserving extraction rather than relaxing assertions.
- The new extraction units each have a distinct production consumer and responsibility; none is a pass-through or speculative abstraction. No dead imports, debug output, broad new normalization layer, or duplicated boundary parser was found.
- The strict boolean helper is appropriately located at the external projection boundary. The optional origin parameter is the minimal compatibility mechanism needed to keep standalone closed-protocol parsing origin-agnostic.
- Existing assertions/non-null uses and broad boundary catches remain maintenance notes under the programming skill, but none violates a stated success criterion or is introduced as scope drift by these fixes.

## Reproduced Evidence

- `git diff --check`: PASS.
- `npm run check`: PASS — ESLint, WXT/TypeScript typecheck, 16 files / 258 tests, production MV3 build.
- `npm run test -- --coverage`: PASS — statements 87.24%, branches 84.72%, functions 90.56%, lines 90.89%; all floors are 80%.
- `npm run test:e2e`: PASS — 1 real Chromium production-extension scenario.
- Screenshot inspected: `.wxt/e2e/test-results/synthetic-lms-loads-the-pr-297d8-ough-real-runtime-messaging/sidepanel-deadlines.png`.
- Additional artifacts consulted: `.omo/evidence/limited-refactor-extraction-gate-review.md`, `.omo/evidence/ci-coverage-ulw-20260913.md`, Playwright PNG attachments/trace, current source/diff/config/tests.

## Evidence Gaps / Notes

- No active ulw-loop plan exists (`ULW_LOOP_PLAN_MISSING`), so this report uses the required `.omo/evidence/<goal>-gate-review.md` fallback.
- No standalone integrated executor report, code-review report, or manual QA matrix was present. The two scoped evidence reports and their referenced artifacts were inspected, and every integrated criterion was independently reproduced or directly audited here; therefore this is a NOTE, not a criterion-linked blocker.
- LSP diagnostics are not available in the supplied evidence. The project-native strict `tsc --noEmit` gate passed, so no stated criterion is left unverified.
- The initial user-owned dirty deadline/filter UI files were treated as baseline. Review of those files was limited to integration/regression impact; no authorship claim is made for them.
