# entrypoints/ - WXT extension entrypoints

## OVERVIEW
Every file or folder here is one WXT entrypoint; WXT turns them into the MV3 manifest and the build output. The domain logic lives in `../src/`, and entry files stay thin wiring around it.

Why this file exists: it is the root of the subtree, and the extension surface (manifest, permissions, contexts) is decided here together with `wxt.config.ts`.

## ENTRYPOINT -> MANIFEST MAP
| Entry | WXT kind | Manifest / output effect |
|-------|----------|--------------------------|
| `background.ts` | `defineBackground` | MV3 service worker. Sets `sidePanel.setPanelBehavior({openPanelOnActionClick})`; when that API is missing, falls back to `action.setPopup("sidepanel.html")` |
| `lms.content.ts` | `defineContentScript({matches: LMS_MATCHES, runAt: "document_idle", allFrames: false})` | Static `content_scripts` entry, built as `content-scripts/lms.js` |
| `player.content.ts` | `defineContentScript({matches: [...LMS_MATCHES, "https://kucom.korea.ac.kr/em/*"], allFrames: true})` | Static entry only when `UNIDOCK_PLAYBACK=1`. The `entrypoints:resolved` hook in `wxt.config.ts` sets `skipped` on the `player` entry otherwise |
| `lms-popup.content.ts` | `registration: "runtime"` | NOT in the manifest. Built as `content-scripts/lms-popup.js`; `src/popup-settings.ts` registers it via `chrome.scripting.registerContentScripts` after the user opts in and grants the optional `lms.korea.ac.kr` host permission |
| `sidepanel/` | HTML entry (`index.html`) | Becomes `sidepanel.html` plus the `side_panel` manifest key. See `sidepanel/AGENTS.md` |
| `updates/` | HTML entry (`index.html`) | Unlisted page `updates.html`, linked from `sidepanel/UpdateNotice.tsx`; shows the manifest version and links `privacy.html` (from `../public/`) |

- Permissions, `host_permissions`, CSP and `connect-src` are NOT declared in entry files. They live in the `manifest()` function of `wxt.config.ts`, which builds them from the `UNIDOCK_*` env flags.
- Flags reach code as compile-time constants (`__UNIDOCK_PLAYBACK__`, `__UNIDOCK_AI_CAPTIONS__`, `__UNIDOCK_STATS_SERVER__`, `__UNIDOCK_CAPTION_SERVER__`) through Vite `define`. Declarations are in `src/build-flags.d.ts`. Disabled branches fold away at build time.
- `LMS_MATCHES` comes from `src/security/policy.ts`. Change origins there, not inline.

## WHERE TO LOOK
| Task | Location |
|------|----------|
| Message routing and sender checks (`panelSender`, `backgroundSender`) | `background.ts` `chrome.runtime.onMessage` (~L541); `src/protocol.ts`, `src/playback/bridge.ts` |
| Install/update handling (badge, reinjecting LMS scripts) | `background.ts` `onInstalled`; `src/update-notice.ts` |
| Playback runtime (alarms-driven) | `createChromePlaybackRuntime` in `background.ts`, `src/playback/` |
| LMS DOM scraping, task/deadline extraction | `lms.content.ts` (~1050 lines, the largest TS hotspot) |
| Native-video control in KUCOM frames | `player.content.ts`, `src/playback/player.ts`, `ku-player.ts` |
| Unit tests | `tests/background.test.ts`, `tests/content.test.ts`, `tests/player-content.test.ts` |

## CONVENTIONS
- Cross-context messages are `{ version: 1, type: ... }` objects. Receivers validate the shape (`isAnalyticsCommand`, `isPlayerControl`, ...) and the sender before acting.
- Async listener work runs as `void promise.catch(() => {})`. A vanished receiver or an unsupported API must never break a state transition.
- Optional Chrome APIs are feature-checked (`chrome.alarms?.onAlarm`, `typeof chrome.scripting?.getRegisteredContentScripts === "function"`) because tests and older runtimes lack them.

## ANTI-PATTERNS
- Never rename `lms.content.ts` or `lms-popup.content.ts` without updating the hardcoded output paths `content-scripts/lms.js` (`src/update-notice.ts`) and `content-scripts/lms-popup.js` (`src/popup-settings.ts`).
- Content scripts never read extension storage. The worker calls `storage.local.setAccessLevel("TRUSTED_CONTEXTS")` on every boot; do not add `chrome.storage` reads to `*.content.ts`.
- `player.content.ts` never injects MAIN-world player calls. It only drives the native video in its own document.
- Development builds never report analytics. The collector origin is passed only when `import.meta.env.PROD`; keep that gate.
- Do not add `matches` to `lms-popup.content.ts`. That would put it in the static manifest and bypass the opt-in.
