# src/captions/ - caption extraction and AI caption jobs

## OVERVIEW
Two pipelines: (1) read existing captions/VTT/media scripts from LMS + KU player frames; (2) AI captions - extract MP4 audio in the panel and upload it to the caption server; the worker then polls the job, caches the transcript and pushes changes to subscribed panels.
Earned its file: score ~10.5 (15 files, 86 exports, densest module in `src/`, 20+ dedicated tests) + distinct domain (AI path gated by `__UNIDOCK_AI_CAPTIONS__`).

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Detect captions for a lecture | `service.ts` `detectCaptions` | orchestrates `extract.ts` + `transcript.ts`; re-verifies contributing documents still exist |
| In-frame extraction | `extract.ts` `collectCaptionSources` | serialized by `chrome.scripting` into each permitted frame; DOM pass first, KU VTT pass only if DOM is empty |
| VTT / media-script / server segment parsing | `transcript.ts` | `parseVtt`, `parseMediaScript`, `projectServerSegments`, `formatTime` |
| Caption text cleanup | `normalize.ts` | `normalizeCaptions`, `safeCaptionText` (uses `security/redaction`) |
| Export / download a transcript | `download.ts` | `exportTranscript`, `downloadCaption`, `captionFileTitle` |
| Locate the KU media file | `media-source.ts` | `requestCaptionMediaAccess`, `readPlayerMedia`, `identifyMedia`, `MediaSourceError` |
| Referer for CDN fetch | `referer-rule.ts` `withCaptionMediaRule`, `installCaptionRuleCleanup` | session DNR rule scoped to one media URL; port `CAPTION_RULE_PORT` + keepalive |
| Ranged media reads | `media-fetch.ts` `mediaRangeReader`, `multipart-ranges.ts` | HTTP Range + multipart/byteranges parsing |
| MP4 audio extraction | `mp4-audio.ts` (`audioLayout`, `topLevelBox`), `audio-extract.ts` (`extractAudio`, `AudioExtractError`) | only module using the `mp4box` dependency |
| Caption server HTTP | `server-http.ts` | `serverFetch`, `readJson`, `CaptionServerError`, `SERVER_CODES`; base from `__UNIDOCK_CAPTION_SERVER__` |
| Job API | `job-client.ts` | `createJob`, `uploadAudio` (`UPLOAD_CHUNK_BYTES`), `getJob`, `cancelJob`, `getTranscript`, `deleteTranscript`, `getAccount` |
| Job lifecycle rules | `job-state.ts` | `JobPhase`, `canTransition`, `isTerminal`, `serverPhase` |
| Follow accepted jobs (worker) | `job-monitor.ts` `CaptionJobMonitor` | several jobs at once (one per lecture key); panel port `CAPTION_JOB_PORT` open only while following; each port gets only its tracked jobs' changed snapshots; per-job poll cadence `CAPTION_POLL_MS`; alarm `CAPTION_JOB_ALARM` exists only while a job is followed |
| Resume in-flight jobs | `job-record.ts` | `loadActiveJobs`/`saveActiveJob`/`clearActiveJob(jobId)`: a list of at most `MAX_ACTIVE_JOBS`, edited under a Web Lock; a legacy single record reads as a list of one; `captionJobKey` |
| Server auth/session | `../caption-server-settings.ts` | lives in root; `authorizedFetch` is what `job-client.ts` calls |

## CONVENTIONS
- `extract.ts` and the reader in `media-source.ts` are self-contained functions injected via `chrome.scripting`: no imports, no closures, read only own data descriptors.
- MAIN-world/page results are hostile: accept only bounded strings for display fields (`service.ts`).
- `requestCaptionMediaAccess` must run first in the click handler, before any `await`, to keep the user gesture for the optional CDN host grant.
- Job idempotency key = HMAC(KU content id, per-install salt `CAPTION_INSTALL_SALT_KEY`); the server never sees the LMS id.
- Errors are typed classes with closed code unions (`AudioExtractError`, `Mp4Error`, `MediaSourceError`, `CaptionServerError`); `job-client.ts` re-exports `CaptionServerErrorCode` as `JobErrorCode`.
- Server wire shapes are pinned by `tests/caption-api-contract.test.ts` and `tests/server-contract-pin.test.mjs`; change both sides together.

## ANTI-PATTERNS
- Never invoke KU player methods or property accessors (KU `Base.extend` models keep defaults on prototypes); read fields directly.
- Never synthesize caption timing from media-script text.
- Never leave a referer session rule installed: remove on success, failure, and cancel; background sweeps orphans on worker start.
- Never send the LMS content id, course id, or tab title to the caption server.
- Do not import `server-http.ts`/`job-client.ts` from code reachable without the `__UNIDOCK_AI_CAPTIONS__` gate in `entrypoints/`.
