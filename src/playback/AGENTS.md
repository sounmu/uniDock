# src/playback/ - sequential lecture playback (build-flagged)

## OVERVIEW
Plays user-selected recordings in order: background `PlaybackRuntime` owns the playlist and authorizations; content-side `PlaybackPlayer` drives one native `<video>`.
Earned its file: score ~8.7 (6 files, 48 exports, `runtime.ts` is the largest file in `src/` at ~900 LOC) + distinct domain compiled only when `UNIDOCK_PLAYBACK=1` (`__UNIDOCK_PLAYBACK__`).

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Panel/background/content message contract | `bridge.ts` | `PlaybackCommand`, `isPlaybackCommand`, `PlaybackSnapshot`, `PlayerBinding`, `PlayerControl`, `playbackErrors`, `PLAYBACK_DISCOVER` |
| Orchestration / state machine | `runtime.ts` `PlaybackRuntime` | serialized owner of the ordered playlist and sole player-authorization issuer; `PLAYBACK_ALARM`, `PLAYBACK_PREFLIGHT`, `PLAYBACK_WATCHDOG` |
| Native video control | `player.ts` `PlaybackPlayer` | metadata/play waits clamped 1..30000 ms; terminal per instance |
| KU player start | `ku-player.ts` `initializeKuLecture` | clicks KU's own start control, then tracks primary video |
| Persisted recovery state | `storage.ts` `ChromePlaybackStore`, `parseStoredPlayback`, `PLAYBACK_STORAGE_KEY` | |
| Playlist item shapes | `playlist.ts` | `PlaylistItem`, `PlaybackCandidate` |
| Diagnostics | `../security/logger.ts` `playbackDiagnostic` | allowlisted `KU_*`, `WAIT_*`, `STATE_*` codes only |
| Wiring | `entrypoints/background.ts`, `entrypoints/lms.content.ts`, `entrypoints/sidepanel/App.tsx` | every call site wrapped in `__UNIDOCK_PLAYBACK__` |

## CONVENTIONS
- Runtime has one serial "state lane": state commits and storage writes are ordered there; LMS reads/discovery never enter it. Stop marks state before the first cleanup await and is not queued behind discovery.
- Authorization is lease-based: invalidate before entering the state lane; a superseded event from a still-retained run is acknowledged without applying state; a released/replaced run fails closed.
- Panel sends opaque one-use handles in click order plus an ephemeral proof of the issuing document; `bridge.ts` never accepts endpoints, URLs, or accounts.
- Stored state is a recovery pointer only; any worker interruption requires an explicit user resume. Scheduled v1 state is never migrated or auto-run; legacy alarms are exported only so they can be cleared.
- Completion requires measured `currentTime` progress; native controls provide neither consent nor visibility.
- Tests: `tests/playback-runtime.test.ts`, `playback-player.test.ts`, `playback-playlist.test.ts`, `ku-player.test.ts`, `player-content.test.ts`.

## ANTI-PATTERNS
- Never infer or claim LMS attendance/credit from playback.
- Never store authorization tokens, handles, or URLs in `chrome.storage`.
- Never call page-owned KU player methods or read LMS APIs from `ku-player.ts`/`player.ts`.
- Never auto-resume after a worker restart, rewind, or change playback speed.
- Never play in a hidden frame; an invalidated player must still silence media it owns.
- Do not import `playback/` from always-on code paths without the `__UNIDOCK_PLAYBACK__` guard (exception: the pure `object` guard used by `download-tab.ts`).
