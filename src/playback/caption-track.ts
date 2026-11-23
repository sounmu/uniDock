import type { CaptionCue } from "../captions/transcript";

/** Shown in the player's caption menu; also how a later delivery finds the track again. */
export const CAPTION_TRACK_LABEL = "uniDock 자막";

type CaptionVideo = Pick<HTMLVideoElement, "textTracks" | "addTextTrack">;

// addTextTrack tracks cannot be removed from a media element, so every
// delivery (including one from a reloaded content script) reuses ours.
function ownTrack(video: CaptionVideo): TextTrack | undefined {
  for (let index = 0; index < video.textTracks.length; index++) {
    const track = video.textTracks[index];
    if (track?.kind === "subtitles" && track.label === CAPTION_TRACK_LABEL)
      return track;
  }
  return undefined;
}

// ::cue ignores padding, so pad each line with a non-collapsing en space to
// widen the cue background left and right. VTTCue parses its text as WebVTT
// markup, so transcript text is escaped to show literally.
const PAD = "\u2002";
export function paddedCueText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .split("\n")
    .map((line) => `${PAD}${line}${PAD}`)
    .join("\n");
}

function removeCues(track: TextTrack): void {
  // `cues` is null while a track is disabled.
  if (track.mode === "disabled") track.mode = "hidden";
  const cues = track.cues;
  if (!cues) return;
  for (let index = cues.length - 1; index >= 0; index--) {
    const cue = cues[index];
    if (cue) track.removeCue(cue);
  }
}

export function showCaptionTrack(
  video: CaptionVideo,
  cues: readonly CaptionCue[],
): void {
  const track =
    ownTrack(video) ?? video.addTextTrack("subtitles", CAPTION_TRACK_LABEL, "ko");
  removeCues(track);
  for (const cue of cues)
    track.addCue(new VTTCue(cue.start / 1000, cue.end / 1000, paddedCueText(cue.text)));
  track.mode = "showing";
}

export function hideCaptionTrack(video: CaptionVideo): void {
  const track = ownTrack(video);
  if (!track) return;
  removeCues(track);
  track.mode = "disabled";
}

/**
 * Keeps the delivered cues on the frame's lecture video. Cues may arrive
 * before the video exists, and the page may replace the element; both are
 * followed until the cues are cleared.
 */
export class CaptionTrackController {
  private cues: readonly CaptionCue[] = [];
  private video: CaptionVideo | null = null;
  private observer: MutationObserver | null = null;

  constructor(
    private readonly findVideo: () => HTMLVideoElement | null,
    private readonly root: Node,
  ) {}

  deliver(cues: readonly CaptionCue[]): void {
    this.cues = cues;
    this.sync(true);
  }

  dispose(): void {
    this.deliver([]);
  }

  private sync(replaced: boolean): void {
    const video = this.cues.length ? this.findVideo() : null;
    if (this.video && this.video !== video) hideCaptionTrack(this.video);
    if (video && (replaced || video !== this.video))
      showCaptionTrack(video, this.cues);
    this.video = video;
    if (!this.cues.length) {
      this.observer?.disconnect();
      this.observer = null;
    } else if (!this.observer) {
      this.observer = new MutationObserver(() => {
        if (this.findVideo() !== this.video) this.sync(false);
      });
      this.observer.observe(this.root, { childList: true, subtree: true });
    }
  }
}
