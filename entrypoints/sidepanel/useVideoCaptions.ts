import { useEffect, useRef, useState } from "react";
import type { CaptionCue } from "../../src/captions/transcript";
import {
  sendVideoCaptions,
  watchVideoCaptions,
  type VideoCaptionTarget,
} from "../../src/video-captions";

export interface VideoCaptionDelivery {
  readonly target: VideoCaptionTarget;
  readonly cues: readonly CaptionCue[] | null;
}

/**
 * Mirrors the panel's timed transcript onto the lecture video. `cues === null`
 * leaves what the document already shows (the panel let go of the transcript,
 * the video keeps it); an empty list, a new target, a null target or turning
 * the setting off removes it.
 */
export function useVideoCaptions(delivery: VideoCaptionDelivery | null): void {
  const target = delivery?.target ?? null;
  const cues = delivery?.cues ?? null;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const shown = useRef<VideoCaptionTarget | null>(null);
  useEffect(
    () =>
      __UNIDOCK_PLAYBACK__
        ? watchVideoCaptions(setEnabled, () => setEnabled(true))
        : undefined,
    [],
  );
  useEffect(() => {
    if (!__UNIDOCK_PLAYBACK__ || enabled === null) return;
    const previous = shown.current;
    const same =
      !!previous &&
      !!target &&
      previous.tabId === target.tabId &&
      previous.documentId === target.documentId;
    const next = enabled && target && cues?.length ? target : null;
    const keep = same && enabled && (cues === null || next !== null);
    if (previous && !keep) {
      shown.current = null;
      void sendVideoCaptions(previous, []);
    }
    if (next && cues) {
      shown.current = next;
      void sendVideoCaptions(next, cues);
    }
  }, [target, cues, enabled]);
}
