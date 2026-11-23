import type { CaptionCue } from "./captions/transcript";
import type { CaptionTrackForward } from "./playback/bridge";

export const videoCaptionsKey = "unidock.video-captions.v1";

export interface VideoCaptionTarget {
  readonly tabId: number;
  readonly documentId: string;
}

/** On unless the user turned it off. Subscribe before reading so a late read cannot undo a change. */
export function watchVideoCaptions(
  receive: (enabled: boolean) => void,
  failed: () => void,
): () => void {
  let current = true;
  let changed = false;
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (!current || area !== "local" || !(videoCaptionsKey in changes)) return;
    changed = true;
    receive(changes[videoCaptionsKey]?.newValue !== false);
  };
  chrome.storage.onChanged.addListener(listener);
  void chrome.storage.local.get(videoCaptionsKey).then(
    (values) => {
      if (current && !changed) receive(values[videoCaptionsKey] !== false);
    },
    () => {
      if (current && !changed) failed();
    },
  );
  return () => {
    current = false;
    chrome.storage.onChanged.removeListener(listener);
  };
}

/** Turning it off clears the videos from the worker, which tracks what they show. */
export async function saveVideoCaptions(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [videoCaptionsKey]: enabled });
}

/**
 * Empty `cues` removes the subtitles. The worker forwards them to the document
 * and resolves true only when the document applied them.
 */
export async function sendVideoCaptions(
  target: VideoCaptionTarget,
  cues: readonly CaptionCue[],
): Promise<boolean> {
  const message: CaptionTrackForward = {
    version: 1,
    type: "PLAYBACK_CAPTION_FORWARD",
    tabId: target.tabId,
    documentId: target.documentId,
    cues,
  };
  try {
    const response: unknown = await chrome.runtime.sendMessage(message);
    return (
      typeof response === "object" &&
      response !== null &&
      "ok" in response &&
      response.ok === true
    );
  } catch {
    // A worker that cannot answer leaves the video as it was.
    return false;
  }
}
