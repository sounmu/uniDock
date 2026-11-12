# Changelog

## 0.5.8 - 2026-11-12

- Organize the panel into Home, Courses, Schedule, and Settings, with the nearest
  unfinished deadlines and lecture tools available from Home.
- Open playback and captions from lecture details while preserving the source
  screen, focus, scroll position, selections, and ongoing work across navigation.
- Show actual lecture pauses, including LMS pauses on tab switches, and resume
  the retained authorized video in its existing tab without resetting its
  position or selected playlist.
- Preserve direct-player recovery when a panel resume is denied by autoplay
  policy, with fresh access checks and unchanged stop/revocation boundaries.
- Remove the outer shadow from the LMS progress capsule.
- Gate progress-notification tests by supported build features, add native
  visibility/focus diagnostics, and allow 30 minutes for the complete CI job
  without extending individual test timeouts.
- Update bundled release notes, privacy-policy version labels, and release
  documentation.

## 0.5.7 - 2026-11-11

- Replace separate current/next cards with a compact autoplay playlist and
  cleaned course names.
- Group video selection by module, add title search that preserves selection
  order, and keep the selection count and playback actions visible while scrolling.
- Unify refresh icons, use neutral hover and loading colors, increase side
  padding, and show loading placeholders without an extra notice.
- Keep authorized playback running across tab changes and synchronize native
  player pause/resume with the extension.
- Retain measured completion evidence across native resume and accept valid
  playback events from inactive dedicated tabs, preserving explicit stop,
  identity, authorization, and login-recovery checks.
- Simplify the first usage-statistics notice and align local-data deletion with
  the settings action style while retaining confirmation.
- Update playback guidance, bundled release notes, privacy-policy labels, and
  release documentation.

## 0.5.6 - 2026-11-10

- Save materials directly in `uniDock/<course>/`, dropping the per-board folder
  and stripping the term code, parenthesized tags and section suffix from the
  LMS course title.
- Keep each download's completion status correct when boards share a file name.
- Reserve side panel scrollbar space so content and button widths stay stable
  when the list starts or stops scrolling.
- Fetch audio in groups of up to 256 byte ranges, with two groups in flight
  and a 1 MiB audio payload limit per group.
- Preserve audio ordering and cancel sibling requests when extraction fails.
- Update the extension version and privacy-policy version labels.

## 0.5.4 - 2026-11-06

- Track AI caption jobs in the background worker, so progress keeps updating
  while the side panel is closed and several lectures can be followed at once.
- Show a Live Activity-style progress capsule on LMS pages for AI captions and
  automatic playback, announced only on stage changes and closable per stage.
- Mark the playback and caption tabs with a dot while work is in progress and
  show a one-line progress row on other screens that opens the right tab.
- Push progress only on change and skip LMS tabs entirely while nothing is running.
- Update bundled release notes and the privacy-policy version.

## 0.5.3 - 2026-11-05

- Redesign AI caption confirmation, progress, completion, and error cards with
  larger text, clearer steps, separate TXT/JSON downloads, and full-text copying.
- Display every caption line and restore locally cached captions in a dedicated
  reading screen with compact export controls.
- Bound the local AI transcript cache to 20 lectures and 4 MiB, honor server
  expiration, and remove cached transcripts when clearing local data.
- Update the privacy policy and bundled release notes for local caption storage.

## 0.5.2 - 2026-11-04

- Ship the side panel refresh that the 0.5.1 release assets did not include:
  five bottom tabs, translucent cards, and assignment status icons; the LMS link
  moves into settings.
- Document multi-university integration boundaries and the Ewha discovery checklist.
- Update the privacy-policy version.

## 0.5.1 - 2026-11-03

- Replace installation-level analytics with bounded aggregate usage reports and
  preserve explicit opt-out choices.
- Keep daily reach accounting consistent after disabling statistics or clearing
  unsent local data.
- Pin server contract bundle 1.0.0 and reject unsupported transcript schemas.
- Synchronize both logged-out refreshes in the playback login-recovery E2E.
- Update bundled release notes and the privacy-policy version.
- Pin the development-only minimatch dependency to 11.0.1 for
  GHSA-g3hv-75wg-m249.

The extension release version is independent of server and API contract versions.
GitHub release assets do not imply Chrome Web Store submission or production
server deployment.
