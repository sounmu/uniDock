# uniDock Design System

## 1. Atmosphere & Identity

A compact, quiet study desk for a Korean university side panel. The existing burgundy controls and warm paper surfaces distinguish actions from sourced LMS facts. Keep the current visual language; a dense calendar cell carries a count rather than a truncated title.

## 2. Color

| Role | Value | Usage |
| --- | --- | --- |
| Page | `#f8f7f5` | Panel background |
| Surface | `#fff` | Cards and notices |
| Ink | `#24242b` | Primary text |
| Muted ink | `#625960`, `#71666c` | Secondary text |
| Burgundy | `#872038` | Primary actions, links, keyboard focus |
| Burgundy wash | `#f4eaec` | Selected and secondary controls |
| Warm divider | `#e7e3df` | Card borders and separators |
| Field divider | `#d8d0d3` | Inputs |
| Error divider | `#dcb7bf` | Error notice |

Color does not carry status by itself: labels such as “확인 필요”, “재생 종료”, and “LMS 확인 필요” are always visible.

## 3. Typography

System UI stack `system-ui, -apple-system, BlinkMacSystemFont, sans-serif` supports Korean without a remote font. Existing hierarchy: page title 32px/1.35, course title 20px/1.5, section heading 16px, list body 14px/1.5, explanatory text 12–13px/1.7. Preserve this hierarchy when adding calendar and playback controls; long Korean titles wrap with `overflow-wrap: anywhere`.

## 4. Spacing & Layout

Existing side-panel content uses a 560px maximum width, 20px inline padding and 24px block padding, with a 12–14px card radius. Compact clusters use 4–10px gaps; notices and cards use 14–22px padding. The document is the single vertical scroll owner. At 320px the calendar stays seven columns but cells show dates and counts only; controls wrap before horizontal overflow. At wider widths details remain below the selected month, not in a fixed secondary pane.

## 5. Components

### Navigation and toolbar

- Structure: semantic `<nav>` with native buttons, then heading and refresh control.
- States: `aria-pressed` identifies selected view; disabled and loading text announce work; keyboard focus uses the existing burgundy outline.
- Layout: wrapping cluster; the document owns scrolling.

### Notice and result card

- Structure: white card with title, metadata, explanation and local actions.
- States: idle, loading, empty, error, unconfirmed and complete all have distinct text.
- Accessibility: text remains in DOM and keyboard actions use native elements.

### Calendar day

- Structure: native button with day number, event count and type text where space permits.
- States: selected date uses tonal burgundy wash plus `aria-pressed`; today and uncertain dates are named in text. Focus retains visible outline.
- Layout: seven intrinsic grid columns; day details follow grid in DOM order.

### Playback control

- Structure: course opt-in, time window and lead-time fields, then a queue with current and next, reason and separate LMS-credit state.
- States: off, needing metadata, scheduled, starting, blocked, playing, paused, ended, failed, stopped. No state is indicated only by color.
- Accessibility: native labeled inputs and buttons; live status is announced without moving keyboard focus.

## 6. Motion & Interaction

Existing buttons transition opacity for 150ms only under `prefers-reduced-motion: no-preference`. New controls follow the same pattern; schedule and calendar state changes are immediate, never animated across dates. Focus is visible and never silently redirected on refresh.

## 7. Depth & Surface

Borders-only: the existing warm dividers separate white cards from the warm page. Field radii are 8px and card radii 12–14px. Do not introduce shadows or decorative elevation into the constrained side panel.

## 8. Accessibility Constraints & Accepted Debt

Target keyboard-complete operation, semantic labels, readable Korean wrapping and no horizontal scrolling at 320px or 200% zoom. Event status is text, not only color. Real LMS player accessibility remains dependent on its own implementation; the extension's pause, resume and stop controls remain independently reachable.

| Item | Location | Reason | Exit |
| --- | --- | --- | --- |
| Real LMS player visual/accessibility behavior | External KU/LTI page | No authorized real-course playback yet | Check a user-selected verification lecture |
