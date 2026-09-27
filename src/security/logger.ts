const events = ["REQUEST_FAILED", "PANEL_SETUP_FAILED"] as const;
const playbackEvents = new Set([
  "KU_INITIALIZING",
  "KU_LECTURE_READY",
  "KU_INITIALIZATION_FAILED",
  "WAIT_KU_PRIMARY_VIDEO",
  "KU_PRIMARY_SELECTED",
  "NATIVE_PLAYING",
  "MEDIA_PROGRESS",
  "END_UNVERIFIED",
  "STATE_paused_unverified-end",
  "KU_FRAME_READY",
  "LMS_FRAME_READY",
  "WAIT_NO_VIDEO_ELEMENT",
  "WAIT_VIDEO_METADATA",
  "WAIT_VIDEO_SOURCE",
  "VIDEO_DISCOVERY_TIMEOUT",
  "FRAME_READY",
  "WAIT_VIDEO",
  "WAIT_AMBIGUOUS_VIDEO",
  "VIDEO_SELECTED",
  "VIDEO_SELECTION_CHANGED",
  "AUTHORIZATION_REJECTED",
  "DOCUMENT_HIDDEN",
  "PLAY_REQUEST",
  "AUTOPLAY_DENIED",
  "MUTED_RETRY",
  "PLAY_ACCEPTED",
  "PLAY_REJECTED",
  "STATE_idle",
  "STATE_starting",
  "STATE_playing",
  "STATE_paused",
  "STATE_ended",
  "STATE_stopped",
  "STATE_blocked-login",
  "STATE_blocked-autoplay",
  "STATE_failed_media",
  "STATE_failed_timeout",
  "STATE_failed_play",
  "STATE_failed_rate",
]);
export function playbackDiagnostic(code: string): void {
  if (!playbackEvents.has(code)) return;
  // Fixed allowlisted codes only. Never log page data or dynamic errors.
  // eslint-disable-next-line no-console
  console.info(`[uniDock playback] ${code}`);
}
export function safeLog(event: (typeof events)[number]): void {
  if (!events.includes(event)) return;
  // Only fixed event codes; no payload, error object, URL, title, ID or persistence.
  // eslint-disable-next-line no-console
  console.warn(`[uniDock] ${event}`);
}
