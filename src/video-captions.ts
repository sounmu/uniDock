import type { CaptionCue } from "./captions/transcript";
import type { PlayerCaptionTrack } from "./playback/bridge";

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

// Documents this panel put subtitles on. The setting lives on another screen,
// so turning it off must reach them even after the captions view unmounted.
const showing = new Map<string, VideoCaptionTarget>();
const targetKey = (target: VideoCaptionTarget) =>
  `${target.tabId}:${target.documentId}`;

export async function saveVideoCaptions(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [videoCaptionsKey]: enabled });
  if (!enabled)
    await Promise.all(
      [...showing.values()].map((target) => sendVideoCaptions(target, [])),
    );
}

/** Empty `cues` removes the subtitles. A document without the player script simply has no receiver. */
export async function sendVideoCaptions(
  target: VideoCaptionTarget,
  cues: readonly CaptionCue[],
): Promise<void> {
  if (cues.length) showing.set(targetKey(target), target);
  else showing.delete(targetKey(target));
  const message: PlayerCaptionTrack = {
    version: 1,
    type: "PLAYBACK_CAPTION_TRACK",
    cues,
  };
  try {
    await chrome.tabs.sendMessage(target.tabId, message, {
      documentId: target.documentId,
    });
  } catch {
    // The lecture document navigated away or closed; its subtitles went with it.
  }
}
