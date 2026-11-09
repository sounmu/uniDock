# uniDock Design System

## Course resources and shared navigation

Recordings and materials follow the assignment list's count heading, contextual
view-change popover, upper-right refresh and successful-update timestamp.
Recording choices describe the available lecture data, never an invented
unwatched state. Materials retain selection, batch download, progress, detail
and LMS actions; refresh must never revive consumed one-use handles.

Layout: the document remains the only page scroller at 320–420px. Course
resources use the existing assignment heading/popover arrangement. The fixed
five-entry main navigation reuses the course `.subviews` capsule surface and
raised neutral selected state; its existing icons, labels, activity markers,
44px targets and disabled-feature explanation remain.

Priority is the resource list, then its count/freshness, then contextual view
options. The main action remains opening a lecture or downloading materials.
Extra persistent help and duplicated refresh controls move into their relevant
context rather than taking space above the list.

## Assignment list workflow

The course assignment view starts with remaining work, ordered by nearest due
date. The heading gives the visible count. Rows show the due time instead of
repeating the course name. The existing assignment detail and focus-return
behavior remain the next step when opening a row.

`보기 변경` opens a local, non-modal popover next to the list heading. Scope,
period and sort are draft values until the primary action applies them. The
preview count reflects all draft conditions. Escape, outside click and focus
leaving the popover dismiss without applying; Escape returns focus to the
trigger. The original display criteria live inside its contextual help. A
list-end shortcut switches between all assignments and remaining work.

Refresh is a 32px icon at the upper right of the course context, with the same
`--r-md` as `보기 변경`. The last successful query time is shown below the list
heading. Refresh keeps the current rows only while the same course/source query
is pending, preserving filters and avoiding a collapsed list. Every failure
clears the rows. Transient failures retain only the last successful time;
authentication, permission and source invalidation clear it. A failed refresh
never repopulates the LMS cache. Reduced-motion users get the same state text
without a rotating icon.

Use existing glass, spacing, typography, focus and color tokens. The approved
visual target for this change is the light-mode demo; no separate dark layout or
theme switch is introduced. Data examples in tests and captures are synthetic.

## 1. Atmosphere & Identity

A quiet Korean study desk with TickTick-style translucent cards on a neutral gray background. Five permanently labelled bottom tabs provide navigation; crimson remains the brand accent. No colored background blobs, gradients, new fonts or icon packages.

Extension icons use `store/assets/logo-concepts/unidock-icon.svg`, preserving the original glass tile with a transparent lowercase u cutout. This artwork matches the website favicon's `public/brand/unidock-favicon.svg`. Generate extension PNGs with `node scripts/brand-assets.mjs`. The original pearl-white letter remains available in `unidock-glass.svg` for larger brand presentations.

## 2. Color

The panel follows the browser/OS theme through `prefers-color-scheme`; there is no in-panel theme switch. Components use tokens only, never raw hex values.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--ink` | `#1c1b1f` | `#f2f2f4` | Body text |
| `--muted` | `#5c5c62` | `#a9a9b0` | Secondary text |
| `--line` | `rgba(0,0,0,.09)` | `rgba(255,255,255,.1)` | Separators |
| `--line-strong` | `rgba(0,0,0,.14)` | `rgba(255,255,255,.18)` | Secondary borders |
| `--line-input` | `#86868c` | `#8d8d94` | Input and select borders |
| `--page` | `#f1f1f3` | `#161618` | Document background |
| `--surface` | `#fff` | `#222225` | Solid surfaces |
| `--glass` | `rgba(255,255,255,.62)` | `rgba(255,255,255,.07)` | Cards |
| `--glass-strong` | `rgba(255,255,255,.82)` | `rgba(255,255,255,.11)` | Hover surfaces |
| `--glass-brd` | `rgba(255,255,255,.9)` | `rgba(255,255,255,.14)` | Card highlight border |
| `--check` | `#3a3a3f` | `#d9d9de` | Neutral selection checkboxes |
| `--brand` | `#872038` | `#f0a6b6` | Primary fill, links, focus, selected text |
| `--on-brand` | `#fff` | `#4a1220` | Text on `--brand` fills |
| `--brand-wash` | `#f4eaec` | `#3b2329` | Selection, hover, urgent chip |
| `--success` | `#2e6b3c` | `#93d3a2` | Done chip text |
| `--success-wash` | `#e7f0e9` | `#1f3327` | Done chip fill |
| `--danger-line` | `#dcb7bf` | `#6b3a40` | Error notice border |
| `--danger` | `#b42318` | `#ff9a8f` | Destructive action text only |

Text must meet 4.5:1 against the effective painted surface in both themes; input borders and focus outlines must meet 3:1. Dark mode uses neutral charcoal surfaces and light rose brand text, with dark primary-button text via `--on-brand`. Images and the brand icon are not inverted. Selection uses a wash, not an accent border. Status always has text; color only reinforces it.

## 3. Typography

`--font:system-ui,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif`. `--fs-xs:12px`, `--fs-sm:13px`, `--fs-md:15px`, `--fs-lg:17px`, `--fs-xl:20px`; metadata values use `--fs-meta:14px`. `--lh-tight:1.35`, `--lh-body:1.55`. Screen headings 17px/600, detail headings 20px/600, row titles 15px/500 clamped at two lines, course labels 13px on one ellipsized line. Long content wraps anywhere in details.

## 4. Spacing & Layout

`--space-1:4px`, `--space-2:8px`, `--space-3:12px`, `--space-4:16px`, `--space-5:24px`; `--r-xs:4px`, `--r-sm:8px`, `--r-md:12px`, `--r-lg:16px`, `--r-full:999px`; `--control-h:32px`, `--control-h-lg:36px`; `--row-h:48px`, `--icon-size:20px`, `--focus-width:2px`, `--focus-offset:2px`.

Layout: a single full-width content column with a floating five-tab bottom capsule, matching the approved local glass mockup. The document owns vertical scrolling. Navigation has five equal `minmax(0,1fr)` columns, 44px minimum-height buttons, 20px icons and 11px permanent labels. It sits 12px from the viewport edges plus the bottom safe area. Main bottom padding and root scroll-padding reserve `--tabbar-space` (54px bar + 12px gap + 24px breathing room + safe area). Target widths are 320–420px without horizontal overflow. Hidden lists stay mounted and restore scroll/focus when returning from details.

Radius roles: 4px for square checkboxes, 8px for small row actions, 12px for buttons/fields/inline guidance, 16px for cards, and 999px for tabs, segments, chips and switches. Nested rectangular surfaces use outer radius minus inset, rounded to the nearest scale step; capsules contain capsules.

## 5. Components

- **Select:** every dropdown uses the shared native `Select` wrapper. Its chevron sits `--space-3` (12px) from the right edge, with `--control-h` text padding. The decorative arrow ignores pointer events; labels, keyboard operation, options and disabled state remain native.

- **Bottom navigation:** five native buttons: 내 과목, 할 일·일정, 자동 재생, 자막 추출, 설정. `aria-current="page"` plus the same raised neutral capsule as course menus marks selection. The surface, inset, border, radius and shadow are shared through `.subviews`. LMS 열기 lives in 설정 > uniDock 정보 alongside the existing information links. Existing callbacks and keyboard behavior remain.
- **Pending navigation entry:** in release builds (`__UNIDOCK_PLAYBACK__` false) 자동 재생 keeps its grid slot as an `aria-disabled="true"` button (not `disabled`, so it stays focusable) at disabled opacity .5 with a default cursor and no hover wash. Clicking does nothing. A sibling `role="tooltip"` above the button, wired through `aria-describedby`, reads “현재 검토 중인 기능입니다.” on hover and `:focus-visible`: ink background, surface text, 12px type, `--r-sm`, max 12rem, no pointer events, and its fade is removed under reduced motion.
- **ScreenHeader:** title with one primary action and at most one muted subtitle. Longer policy copy lives in native 안내 details.
- **ListRow:** full-row native glass-card button, two-line title, secondary course label and trailing StatusChip. At least 48px with 12px horizontal padding and 8px between cards. Assignment states have a decorative leading status icon: clock, check, exclamation or lock. StatusChip text remains the accessible meaning. Square neutral checkboxes are reserved for actual selection and remain separate labelled inputs, never nested inside buttons.
- **StatusChip:** pill (`--r-full`), 12px text, three tones: neutral (neutral-wash/muted), urgent (brand-wash/brand) and done (success-wash/success). The text alone must carry the meaning: an urgent chip says so in words (D-1, 오늘 HH:MM, n시간 남음), never only by tone. Course rows have no chip.
- **DetailView:** ghost 목록 back button, heading, two-column semantic dl, contextual tools. Only its primary is visible while detail is open; list remains hidden/mounted. Keyboard focus moves to detail heading and returns to the selected row.
- **Notice:** glass surface, 1px highlight border (danger-line for errors), `--r-lg`, 12px padding and 13px type; status or alert role.
- **Buttons:** primary brand/on-brand, 36px; secondary strong glass/ink, 32px; ghost transparent/muted, 32px. All use `--r-md`, 13px/600. Segmented subview toggles use `--r-full`, with a raised selected capsule. Disabled opacity is .5. Interactive elements have a 2px brand focus outline and 2px offset. Actions that disable themselves use `aria-disabled="true"` and ignore clicks to retain focus. External-link glyphs remain `aria-hidden`.
- **Information screen:** settings groups use muted 12px/600 labels above glass cards with `--r-lg`. Rows are at least 48px with 12px padding and internal separators, a 13px/500 title, optional muted subtitle and wrapping actions. The app name, version and unofficial note appear in uniDock 정보. Links are full-row with external icons; long policy copy uses native details. Destructive actions use `--danger` text.
- **Toggle switch:** native `<button role="switch">` with `aria-checked`, labelled by its row title and described by its subtitle. The 40×24px `--r-full` track contains an 18px knob. Off uses surface/line-input; on uses brand/on-brand and a check mark. Position and assistive state convey meaning beyond color. The knob moves without animation. Loading/saving uses `aria-disabled` to retain focus; errors preserve prior state and show an alert. Space and Enter toggle it.
- **AI caption offer:** when detection finds no usable provided captions in an AI build, a settings-style card replaces the error notice: a title row naming the situation with a trailing ghost AI 자막 설정 entry, then one row per stage (login, generate, confirm list, progress with 취소, failure with 다시 시도, result with download). Consent copy is a bulleted list, never a paragraph.
- **Settings:** native 보기 설정 details contain filters, sorting or date fields. Playback settings and manual confirmation each have a dedicated detail view, with deletion confirmation preserved.
- **Pagination:** 100 rows per page, filter resets page, status/timer updates preserve page.
- **Loading:** a query in flight shows up to six glass-card skeleton rows at `--row-h`, with bars in `--line`. Skeletons are `aria-hidden`; the existing text Notice (“목록을 불러오고 있습니다…”) remains the announced status. The surrounding live region carries `aria-busy` while loading.
- **Focus restoration:** returning from a detail or the information screen focuses the originating control if it is still connected; otherwise it focuses the nearest stable equivalent (the row with the same item identity, else the screen heading). List rows are keyed by item identity, never by index.

| Screen | Sole primary action |
| --- | --- |
| Courses / tasks | 새로고침 |
| Course assignments | 보기 변경 |
| Course recordings | 강의 열기 |
| Materials | 자료 전체 다운로드 / 선택 다운로드 |
| Playback (playback builds only) | 자동 재생 켜기 / 끄기 |
| Captions | 자막 감지; when no provided captions exist, the AI offer card's 자막 생성/로그인 action, with 자막 감지 demoted to secondary |
| Item details | Open LMS, open LTI, download PDF, cancel reservation, or download captions; assignment details have none |

### 강의 자료 다운로드

Source-grouped material rows (PDF, PPTX and PPT in one list, no format filter or format label) with 전체 선택, per-file selection, and text progress n/N. During a batch the primary is replaced by secondary 취소; cancellation stops unsent requests, not browser downloads already started. One-use handles are never reused; refresh is required after expiry. States: 대기, 다운로드 중, 요청됨, 완료, 실패, 취소됨, 확인 필요. Missing content_id shows LMS에서 확인 with no checkbox/action for download. Folder and ChatGPT tools follow the batch; the latter copies a prompt and opens chatgpt.com only. The user must attach files themselves; no upload.

## 6. Motion & Interaction

`--motion-fast:150ms`. Only opacity transitions under `prefers-reduced-motion:no-preference`; skeleton rows may pulse opacity (1.2s, .6–1) under the same condition and are static otherwise; hover wash changes immediately (avoids non-compositor background animation). No decorative motion. Native details and immediate state feedback preserve reduced-motion behavior.

## 7. Depth & Surface

Translucent glass cards have a 1px highlight border and a soft shadow: `0 6px 20px rgba(0,0,0,.06)` with an inset white highlight in light mode; dark mode uses `.35` shadow opacity and a translucent highlight. Only the bottom tab bar and sticky playback toolbar use backdrop blur (`blur(18px) saturate(160%)`). Individual cards never blur their backdrop. The page background is flat neutral gray or charcoal.

## 8. Accessibility Constraints & Accepted Debt

Keyboard users and students working in narrow panels need persistent navigation labels, focus restoration, native labelled controls, semantic metadata, and text-only progress/status. Long Korean labels and unbroken strings must not force horizontal scroll. Error feedback never exposes raw URLs, IDs or credentials.

| Debt | Reason and exit |
| --- | --- |
| Real LMS redirect/login behavior | Orchestrator performs real-session QA. A completed browser download with non-PDF MIME is 확인 필요, never deleted automatically. |
| Download association | Browser events may omit filenames or be ambiguous. Such rows remain 요청됨; download history is authoritative. Matching needs an extension-owned canonical LMS URL and a unique safe relative path. Closing the panel loses in-memory status but does not stop downloads. |
| External LMS/player accessibility | Depends on LMS implementation; test separately on an authorized lecture. |
| Audit tooling | No extra runtime/development packages in this scoped extension change; use production extension Playwright evidence, not web-site Lighthouse scores for chrome-extension URLs. |
