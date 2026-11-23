import { useEffect, useRef, useState } from "react";
import type { CaptionCue } from "../../src/captions/transcript";
import {
  sendVideoCaptions,
  watchVideoCaptions,
  type VideoCaptionTarget,
} from "../../src/video-captions";

// The player's listener may still be starting; a failed delivery is retried
// after 0.5, 1, 2 and 4 seconds, then left alone.
const FIRST_RETRY_MS = 500;
const LAST_RETRY_MS = 4000;

export interface VideoCaptionDelivery {
  readonly target: VideoCaptionTarget;
  readonly cues: readonly CaptionCue[] | null;
}

/**
 * Mirrors the panel's timed transcript onto the lecture video. `cues === null`
 * leaves what the document already shows (the panel let go of the transcript,
 * the video keeps it); an empty list, a new target, a null target or turning
 * the setting off removes it. A target counts as shown only once a delivery
 * succeeds; until then it is pending, and either one is cleared on change.
 */
export function useVideoCaptions(delivery: VideoCaptionDelivery | null): void {
  const target = delivery?.target ?? null;
  const cues = delivery?.cues ?? null;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const shown = useRef<VideoCaptionTarget | null>(null);
  const pending = useRef<VideoCaptionTarget | null>(null);
  useEffect(
    () =>
      __UNIDOCK_PLAYBACK__
        ? watchVideoCaptions(setEnabled, () => setEnabled(true))
        : undefined,
    [],
  );
  useEffect(() => {
    if (!__UNIDOCK_PLAYBACK__ || enabled === null) return;
    // Pending counts too: an unconfirmed delivery may still have reached it.
    const previous = shown.current ?? pending.current;
    const same =
      !!previous &&
      !!target &&
      previous.tabId === target.tabId &&
      previous.documentId === target.documentId;
    const next = enabled && target && cues?.length ? target : null;
    const keep = same && enabled && (cues === null || next !== null);
    if (previous && !keep) {
      shown.current = null;
      pending.current = null;
      void sendVideoCaptions(previous, []);
    }
    if (!next || !cues) return;
    pending.current = next;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (retryMs: number) =>
      void sendVideoCaptions(next, cues).then((ok) => {
        if (!active) return;
        if (ok) {
          shown.current = next;
          pending.current = null;
        } else if (retryMs <= LAST_RETRY_MS)
          timer = setTimeout(() => attempt(retryMs * 2), retryMs);
      });
    attempt(FIRST_RETRY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [target, cues, enabled]);
}
