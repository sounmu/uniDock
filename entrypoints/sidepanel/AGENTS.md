# entrypoints/sidepanel/ - React side panel UI

## OVERVIEW
The main uniDock UI (React 19). WXT builds it into `sidepanel.html` and the manifest `side_panel` entry. Boot chain: `index.html` -> `main.tsx` (StrictMode) -> `App.tsx`.

Earned its file with a score of about 16: 40 root files (20 TSX, 16 TS) and two sub-folders, its own design-token stylesheet, and the extension's whole user-facing surface.

## STRUCTURE
- `App.tsx`: shell. `Rail` bottom bar (home, courses, tasks, settings icon); playback and captions open as tool sections from Home, plus the info/settings view, the analytics notice and focus restoration.
- `screens/`: one component per section (`HomeScreen`, `CoursesScreen`, `TasksScreen`, `SettingsScreen`, `MaterialsTab`, `QueryResults`, `PlaybackConfirmation`), plus `RecordingPicker`, the course and week lecture checklist shared by playback and AI captions.
- `ui/`: shared presentation and accessibility primitives (`DetailView`, `ListRow`, `StatusChip`, `Notice`, `ScreenHeader`, `Rail`, `icons`, `a11y`). The most-imported are `ui/DetailView` and `ui/a11y`.
- Root `use*.ts` hooks hold the state and messaging. Root `*.tsx` files are feature panels and settings.

## WHERE TO LOOK
| Task | Location |
|------|----------|
| LMS query lifecycle and stale-result guarding | `useSidepanelQuery.ts`, `query-gate.ts` (`QueryGate`), `query-messages.ts` |
| Sequential playback UI | `PlaybackPanel.tsx`, `usePlaybackPanel.ts`, `screens/PlaybackConfirmation.tsx`; lecture lists and selection in `useRecordingPicker.ts` |
| Caption extraction / AI captions | `CaptionsPanel.tsx`, `AiCaptionsSection.tsx`, `useAiCaptions.ts`, `useCaptionSession.ts`, `useCaptionAccount.ts`, `CaptionServerSettings.tsx` |
| AI captions for several lectures | `CaptionQueue.tsx`, `useCaptionQueue.ts`, `src/captions/submit-lecture.ts`; the selection is admitted at once (`CAPTION_BATCH_ADMIT`, `CaptionBatch` in `src/navigation-catalog.ts`, held by `entrypoints/lms.content.ts`) and each lecture opens in one lecture tab (`CAPTION_BATCH_OPEN`, `src/open-tab.ts`) |
| Bulk material downloads | `screens/MaterialsTab.tsx`, `useDocumentDownloads.ts` |
| Assignment and item lists | `ItemResults.tsx`, `ResultList.tsx`, `PagedList.tsx`, `ItemDetail.tsx` |
| Usage stats opt-out and notice | `analytics.ts`, `useAnalytics.ts`, `AnalyticsSettings.tsx` |
| Local data wipe, LMS popup auto-close, update badge | `LocalDataSettings.tsx`, `PopupSettings.tsx`, `UpdateNotice.tsx` (links `updates.html`) |
| Panel navigation and back stack | `usePanelNavigation.ts` |
| Visual tokens, radius/spacing scale | `style.css` (~1960 lines, documents its token system at the top) |

## CONVENTIONS
- The panel never touches LMS pages directly. Every action is `chrome.runtime.sendMessage({ version: 1, type, ... })` to the worker, which verifies `panelSender(sender)`. Shared types come from `../../src/protocol`, `src/transport`, `src/domain` and `src/analytics/contract`.
- Feature UI is gated by the build constants `__UNIDOCK_PLAYBACK__` and `__UNIDOCK_AI_CAPTIONS__`, never by runtime settings. A disabled feature must disappear entirely, not render as disabled.
- Visible copy is Korean (`lang="ko"`). Add new strings in Korean to match.
- Styling goes through `style.css` tokens. `backdrop-filter` blur is reserved for floating and sticky controls.

## ANTI-PATTERNS
- No `console.*` and no explicit `any`; ESLint fails on both (`no-console`, `@typescript-eslint/no-explicit-any`).
- Do not mark the analytics notice dismissed when it is shown. It stays until dismissed in this panel (`App.tsx`).
- Do not clear unseen update badges as a side effect. `UpdateNotice` preserves them until the user acts.
- Do not read results from an earlier query after a new one starts. Every async result goes through `QueryGate`.
