# src/security/ - origin policy, redaction, safe logging

## OVERVIEW
Cross-cutting guard layer: LMS origin/path allowlist, URL builders, display-text redaction, fixed-code logging, per-tab rate limiting.
Earned its file: score ~9.5 (8 files, 20 exports, highest reference centrality in `src/` - 24+ importing files incl. most root modules) + distinct security domain.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Origin declarations | `origins.ts` `KOREA_ORIGINS` | Import-free data shared by build configuration and runtime; LMS, player, portal and caption CDN |
| Allowed LMS origins | `policy.ts` `LMS_ORIGINS`, `LMS_MATCHES` | Derived from `KOREA_ORIGINS.lms`; existing policy exports remain the runtime boundary |
| Is a page URL ours? | `policy.ts` `allowedPage` | origin match AND no username/password in URL |
| Build an LMS API read URL | `policy.ts` `readUrl(value, origin, expectedPath)` | throws `"POLICY"` unless path matches a regex allowlist (assignments, modules, module items, discussion topics, LearningX boards; only `page` query on post lists) |
| Caption CDN media URL | `policy.ts` `CAPTION_MEDIA_HOST`, `CAPTION_MEDIA_ORIGIN_PATTERN`, `allowedCaptionMediaUrl` | used by `captions/media-source.ts`, `captions/referer-rule.ts` |
| Course URL | `policy.ts` `courseUrl` | |
| Player / navigation URLs | `navigation.ts` `PLAYER_ORIGIN`, `playerUrl`, `navigationUrl` | consumed by `recordings.ts`, `open-tab.ts`, `navigation-catalog.ts`, `playback/bridge.ts` |
| Item deep links | `item-link.ts` `itemUrl` | used by `protocol.ts`, `domain-items.ts` |
| File download URL/path | `download.ts` `lmsFileDownloadUrl`, `safeDownloadPath`, `validDownloadPath` | filename sanitizing goes through `redaction.ts` |
| Strip secrets from display text | `redaction.ts` `redactText(text, privateValues?)` | replaces URLs, emails, auth/cookie/token/session/course_id/`KU_LMS_ID` tails, 8+ digit runs with `[REDACTED]`; strips control chars |
| Logging | `logger.ts` `safeLog`, `playbackDiagnostic` | the only sanctioned `console` use in `src/` |
| Per-tab request cap | `rate-limit.ts` `TabRateLimiter` | worker-memory only; used by `download-tab.ts`, `open-tab.ts` |
| LearningX token read | `learningx-token.ts` `learningxToken` | |

## CONVENTIONS
- Pure functions, no `chrome.*`: everything here is unit-testable (`tests/security-review.test.ts`, `rate-limit.test.ts`, `item-link.test.ts`, `caption-media-url.test.ts`).
- Policy failures throw a bare `Error("POLICY")` or return `false`; callers map them to protocol error codes. No partial/"best effort" URLs.
- `TabRateLimiter` is defense in depth behind one-use handles enforced in the content script; eviction only resets the window, never grants extra.
- `logger.ts` holds two closed allowlists (`events`, `playbackEvents`); an unknown code is silently dropped. Its `console` calls carry the only `eslint-disable-next-line no-console` in the module tree.

## ANTI-PATTERNS
- Never widen `readUrl` with a generic path or pass-through query; add one exact regex per new LMS endpoint.
- Never log page data, URLs, titles, IDs, or `Error` objects - add a fixed code to the allowlist in `logger.ts` instead.
- Never treat `redactText` as a logging sanitizer: it is display-text defense in depth; logs accept no free text at all.
- Keep runtime origin declarations in `origins.ts`; `LMS_ORIGINS`, `LMS_MATCHES` and `allowedPage` derive from them. Injected functions remain self-contained, and release checks keep independent expectations.
- Do not persist rate-limit state or tokens to `chrome.storage`.
