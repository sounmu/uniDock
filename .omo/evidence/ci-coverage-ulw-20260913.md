# Ultrawork Notepad — CI and measured Vitest coverage gate

Started: 2026-09-13T00:00:00+09:00

## Plan (exhaustively detailed)

1. Inspect existing npm scripts, TypeScript/Vitest/Playwright configuration, workflow state, and dirty files.
2. Capture an unmodified coverage baseline for production files.
3. Add the Vitest v8 coverage provider through npm and introduce only required coverage/CI configuration.
4. Temporarily mutate the coverage threshold to 101%, run coverage and capture the expected RED failure; restore the conservative measured threshold.
5. Run every local command mirrored by CI, including real Chromium browser E2E; capture results.
6. Re-read the diff and record LIGHT-tier self-review.

## Success criteria + QA scenarios

1. RED proof: temporarily set the global coverage threshold to 101 and run `npm run test -- --coverage`; PASS means Vitest exits nonzero because the threshold is unmet. Artifact: command output in Findings.
2. CI-equivalent GREEN: run `npm ci`, `npx playwright install --with-deps chromium`, `npm run lint`, `npm run typecheck`, `npm run test -- --coverage`, `npm run build`, and `npm run test:e2e`; PASS means every command exits 0. Artifact: command outputs in Findings.

I’ll stop right away when all local CI commands are green, the impossible-threshold RED is proven, and CI files/configs are present.

## Now

Complete — all CI-equivalent commands are green and evidence is recorded.

## Todo

None.

## Findings

- Skills used: `omo:ultrawork` for evidence-first configuration work; `omo:programming` TypeScript guidance because the repository uses Vitest/TypeScript tooling.
- Tier: LIGHT — a known CI/configuration pattern with no product behavior or new domain design. The requested strict evidence is recorded by RED/GREEN command captures.
- Existing dirty files are user/other-agent work: README, sidepanel TSX/CSS, package files, domain/protocol/security/transport code, tests, plus untracked Playwright config and E2E tests. Scope is limited to package metadata, coverage config, and CI workflow.
- Existing scripts include lint, typecheck, Vitest test, build, and `test:e2e` (build + Playwright). Node engine is `>=22.13.0`; Vitest is 5.0.0 and Playwright is already present.
- No `.github/workflows` directory existed at discovery time.
- Installed `@vitest/coverage-v8` exactly at `5.0.0` with npm; npm updated the lockfile and reported no vulnerabilities.
- Natural RED before the coverage configuration: `npm run test -- --coverage` attempted to execute `tests/e2e/synthetic-lms.spec.ts` in Vitest and failed because Playwright's `test()` was called outside Playwright.
- Initial custom `exclude` replaced Vitest defaults and exposed dependency tests; corrected it with `...configDefaults.exclude` plus `tests/e2e/**`.
- Baseline after production-file include/exclude: statements 87.38% (1039/1189), branches 84.95% (1073/1263), functions 89.85% (186/207), lines 90.72% (939/1035); 252 unit tests passed. The 80% floor leaves at least 4.95 percentage points below the weakest measured metric (branches), so it is conservative but meaningful.
- Required mutation RED captured: with all global thresholds temporarily set to 101%, `npm run test -- --coverage` exited 1 after all 252 tests passed; Vitest reported global coverage below 101% for lines (90.72), functions (89.85), statements (87.38), and branches (84.95). Restored the 80% floor immediately after the proof.
- Local CI sequence outcomes after `npm ci`: `npx playwright install --with-deps chromium` PASS (0); `npm run lint` PASS (0); `npm run typecheck` BLOCKED (2) at `tests/captions.test.ts:433:51`, an unrelated/parallel test change; `npm run build` PASS (0); `npm run test:e2e` PASS (0), exercising the production MV3 through real runtime messaging in Chromium.
- After concurrent test edits continued, the restored 80% coverage invocation was BLOCKED by seven unrelated test assertion failures in `tests/captions.test.ts` and `tests/transport.test.ts`; the coverage gate itself had previously passed at baseline. Source/tests are outside this task's ownership and were left untouched.
- LSP diagnostics could not run: TypeScript LSP was previously declined, and yaml-language-server is not installed. `git diff --check` is clean.
- Final literal local CI sequence: `npm ci` PASS (0); `npx playwright install --with-deps chromium` PASS (0); `npm run lint` PASS (0); `npm run typecheck` PASS (0); `npm run test -- --coverage` PASS (0, 16 files/258 tests; statements 87.21%, branches 84.72%, functions 90.47%, lines 90.86%); `npm run build` PASS (0); `npm run test:e2e` PASS (0, the real Chromium MV3/runtime-messaging scenario).
- Cleanup receipt: Playwright's single worker and Chromium context terminated with the runner; no Playwright/Chromium process remained. Build output is the normal ignored output of the requested build/E2E commands; no temporary server, browser context, port, container, or environment variable remains.
- LIGHT self-review: re-read the CI and Vitest configurations; the workflow contains the requested order, uses Node 24 (the current active LTS as of 2026-09-13; Node 26 does not enter LTS until 2026-10-28), caches npm, and confines permissions to read-only contents. Vitest preserves its default exclusions and adds only Playwright E2E exclusion, while coverage includes TypeScript production sources/entrypoints and excludes declarations plus the bootstrap-only sidepanel module. `prettier --check` and `git diff --check` passed.

## Learnings

- Coverage floor must be determined from the measured current production-file baseline, then set with margin rather than guessed.
