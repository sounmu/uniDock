# uniDock Design System

## 1. Atmosphere & Identity

A quiet Korean study desk: Todoist-like divided task rows, always-labelled top navigation, and Reader-like item tools in a detail view. The user's top-navigation preference supersedes the rail in `.omo/plans/todoist-ui-pdf-bulk-download.md`; its other visual and interaction rules remain. No new fonts, icon packages, shadows, or decorative materials.

## 2. Color

CSS tokens: `--ink:#24242b`, `--muted:#6b6269`, `--line:#e7e3df`, `--line-strong:#d8d0d3`, `--page:#f8f7f5`, `--surface:#fff`, `--brand:#872038`, `--brand-wash:#f4eaec`, `--danger-line:#dcb7bf`, `--danger:#b42318` (destructive action text only). Selection uses a wash, not an accent border. Status always has text.

## 3. Typography

`--font:system-ui,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif`. `--fs-xs:12px`, `--fs-sm:13px`, `--fs-md:15px`, `--fs-lg:17px`, `--fs-xl:20px`; metadata values use `--fs-meta:14px`. `--lh-tight:1.35`, `--lh-body:1.55`. Screen headings 17px/600, detail headings 20px/600, row titles 15px/500 clamped at two lines, course labels 13px on one ellipsized line. Long content wraps anywhere in details.

## 4. Spacing & Layout

`--space-1:4px`, `--space-2:8px`, `--space-3:12px`, `--space-4:16px`, `--space-5:24px`; `--radius-sm:6px`, `--radius-md:10px`; `--control-h:32px`, `--control-h-lg:36px`; `--row-h:48px`, `--icon-size:20px`, `--focus-width:2px`, `--focus-offset:2px`.

The root is a single column: compact navigation header followed by full-width main content. The document owns vertical scrolling; the header is in normal flow so it never covers a focused item or competes with playback's sticky toolbar. Four equal `minmax(0,1fr)` columns keep all primary buttons visible without horizontal scrolling. Each stacks its icon over its label; LMS/info/privacy utilities form one compact wrapping row below. Main retains `min-width:0` and 16px/12px padding. Target widths are 320–420px; no horizontal overflow or reserved sidebar width. Hidden lists stay mounted and restore scroll/focus when returning from details.

## 5. Components

- **Top navigation:** four native buttons with 20px inline SVG and permanent 12px labels: 내 과목, 할 일·일정, 자동 재생, 자막 추출. `aria-current="page"` plus brand wash marks selection. Utility links open LMS/privacy; 정보 opens policy detail. Existing callbacks and keyboard behavior remain.
- **Pending navigation entry:** in release builds (`__UNIDOCK_PLAYBACK__` false) 자동 재생 keeps its grid slot as an `aria-disabled="true"` button (not `disabled`, so it stays focusable) at disabled opacity .5 with a default cursor and no hover wash. Clicking does nothing. A sibling `role="tooltip"` below the button, wired through `aria-describedby`, reads “현재 검토 중인 기능입니다.” on hover and `:focus-visible`: ink background, surface text, 12px type, `--radius-sm`, max 12rem, no pointer events, and its fade is removed under reduced motion.
- **ScreenHeader:** title with one primary action and at most one muted subtitle. Longer policy copy lives in native 안내 details.
- **ListRow:** full-row native button, two-line title, secondary course label and one trailing StatusChip. At least 48px, 12px horizontal padding, separator only. Material checkboxes are separate labelled inputs, never nested inside buttons.
- **StatusChip:** visible neutral or urgent text; no color-only distinctions. Course rows have no chip.
- **DetailView:** ghost 목록 back button, heading, two-column semantic dl, contextual tools. Only its primary is visible while detail is open; list remains hidden/mounted. Keyboard focus moves to detail heading and returns to the selected row.
- **Notice:** white surface, 1px line (danger-line for errors), 10px radius, 12px padding/type; status or alert role.
- **Buttons:** primary brand/white, 36px; secondary surface/line-strong/brand, 32px; ghost transparent/muted, 32px. All 6px radius, 12px/600. Disabled opacity .5, default cursor. All interactive elements have 2px brand focus outline and 2px offset.
- **Information screen:** app header (48px icon at 40px, name, version and unofficial note), then settings groups: muted 12px/600 label above a white card with 1px line and 10px radius. Rows are at least 48px with 12px padding and a separator; each has a 13px/500 title, optional 12px muted subtitle and trailing actions that wrap below on narrow panels. Links are full-row with a trailing external icon and hover wash. Long policy copy sits in native details rows. Destructive actions use `--danger` text on a secondary button.
- **Settings:** native 보기 설정 details contain filters, sorting or date fields. Playback settings and manual confirmation each have a dedicated detail view, with deletion confirmation preserved.
- **Pagination:** 100 rows per page, filter resets page, status/timer updates preserve page.

| Screen | Sole primary action |
| --- | --- |
| Courses / tasks | 새로고침 |
| Course assignments / recordings | 새로고침 |
| Materials | PDF 전체 다운로드 / 선택 다운로드 |
| Playback (playback builds only) | 자동 재생 켜기 / 끄기 |
| Captions | 자막 감지 |
| Item details | Open LMS, open LTI, download PDF, cancel reservation, or download captions; assignment details have none |

### 강의 자료 다운로드

Source-grouped material rows (PDF, PPTX and PPT in one list, no format filter or format label) with 전체 선택, per-file selection, and text progress n/N. During a batch the primary is replaced by secondary 취소; cancellation stops unsent requests, not browser downloads already started. One-use handles are never reused; refresh is required after expiry. States: 대기, 다운로드 중, 요청됨, 완료, 실패, 취소됨, 확인 필요. Missing content_id shows LMS에서 확인 with no checkbox/action for download. Folder and ChatGPT tools follow the batch; the latter copies a prompt and opens chatgpt.com only. The user must attach files themselves; no upload.

## 6. Motion & Interaction

`--motion-fast:150ms`. Only opacity transitions under `prefers-reduced-motion:no-preference`; hover wash changes immediately (avoids non-compositor background animation). No decorative motion. Native details and immediate state feedback preserve reduced-motion behavior.

## 7. Depth & Surface

Borders-only warm paper. Rows have no card box or shadow. Forms and notices have restrained neutral borders. Only keyboard focus uses a colored edge.

## 8. Accessibility Constraints & Accepted Debt

Keyboard users and students working in narrow panels need persistent navigation labels, focus restoration, native labelled controls, semantic metadata, and text-only progress/status. Long Korean labels and unbroken strings must not force horizontal scroll. Error feedback never exposes raw URLs, IDs or credentials.

| Debt | Reason and exit |
| --- | --- |
| Real LMS redirect/login behavior | Orchestrator performs real-session QA. A completed browser download with non-PDF MIME is 확인 필요, never deleted automatically. |
| Download association | Browser events may omit filenames or be ambiguous. Such rows remain 요청됨; download history is authoritative. Matching needs an extension-owned canonical LMS URL and a unique safe relative path. Closing the panel loses in-memory status but does not stop downloads. |
| External LMS/player accessibility | Depends on LMS implementation; test separately on an authorized lecture. |
| Audit tooling | No extra runtime/development packages in this scoped extension change; use production extension Playwright evidence, not web-site Lighthouse scores for chrome-extension URLs. |
