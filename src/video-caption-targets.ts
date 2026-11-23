import type { CaptionCue } from "./captions/transcript";
import { object, type PlayerCaptionTrack } from "./playback/bridge";
import { videoCaptionsKey, type VideoCaptionTarget } from "./video-captions";

/** Session storage: tab and document ids mean nothing after the browser session. */
export const videoCaptionTargetsKey = "unidock.video-caption-targets.v1";

const sameTarget = (a: VideoCaptionTarget, b: VideoCaptionTarget) =>
  a.tabId === b.tabId && a.documentId === b.documentId;

function parseTargets(value: unknown): VideoCaptionTarget[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (target: unknown): target is VideoCaptionTarget =>
      object(target) &&
      Number.isSafeInteger(target.tabId) &&
      typeof target.documentId === "string",
  );
}

async function send(
  target: VideoCaptionTarget,
  cues: readonly CaptionCue[],
): Promise<boolean> {
  const message: PlayerCaptionTrack = {
    version: 1,
    type: "PLAYBACK_CAPTION_TRACK",
    cues,
  };
  try {
    const response: unknown = await chrome.tabs.sendMessage(
      target.tabId,
      message,
      { documentId: target.documentId },
    );
    return object(response) && response.ok === true;
  } catch {
    // The lecture document navigated away or closed; its subtitles went with it.
    return false;
  }
}

/**
 * The worker's record of documents showing uniDock subtitles. It outlives the
 * side panel and, through session storage, a worker restart, so turning the
 * setting off still reaches every document. Changes run one at a time.
 */
export class VideoCaptionTargets {
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Empty `cues` removes the subtitles. Cues are refused while the setting is
   * off. A document is recorded before it may show cues and forgotten only
   * after it confirms the removal, so a later clear always reaches it.
   */
  deliver(
    target: VideoCaptionTarget,
    cues: readonly CaptionCue[],
  ): Promise<boolean> {
    return this.serial(async () => {
      if (cues.length) {
        const setting = await chrome.storage.local.get(videoCaptionsKey);
        if (setting[videoCaptionsKey] === false) return false;
        await this.update((targets) =>
          targets.some((entry) => sameTarget(entry, target))
            ? targets
            : [...targets, target],
        );
        return send(target, cues);
      }
      const ok = await send(target, cues);
      if (ok)
        await this.update((targets) =>
          targets.filter((entry) => !sameTarget(entry, target)),
        );
      return ok;
    });
  }

  clearAll(): Promise<void> {
    return this.serial(async () => {
      const targets = await this.read();
      if (!targets.length) return;
      await chrome.storage.session.remove(videoCaptionTargetsKey);
      await Promise.all(targets.map((target) => send(target, [])));
    });
  }

  tabRemoved(tabId: number): Promise<void> {
    return this.serial(() =>
      this.update((targets) =>
        targets.filter((target) => target.tabId !== tabId),
      ),
    );
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private async read(): Promise<VideoCaptionTarget[]> {
    const stored = await chrome.storage.session.get(videoCaptionTargetsKey);
    return parseTargets(stored[videoCaptionTargetsKey]);
  }

  private async update(
    change: (targets: VideoCaptionTarget[]) => VideoCaptionTarget[],
  ): Promise<void> {
    const targets = await this.read();
    const next = change(targets);
    if (
      next.length === targets.length &&
      next.every((target, index) => sameTarget(target, targets[index]!))
    )
      return;
    if (next.length)
      await chrome.storage.session.set({ [videoCaptionTargetsKey]: next });
    else await chrome.storage.session.remove(videoCaptionTargetsKey);
  }
}
