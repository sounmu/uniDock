/** Minimal, account-scoped recording identity retained by the playback runtime. */
export interface PlaylistItem {
  readonly id: string;
  readonly courseId: string;
}

/** Discovery projection. Scheduling, completion and LMS-credit fields are intentionally absent. */
export interface PlaybackCandidate extends PlaylistItem {
  readonly title?: string;
}
