# Changelog

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
