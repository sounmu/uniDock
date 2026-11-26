import { useEffect, useState, useSyncExternalStore } from "react";
import {
  PROGRESS_GET,
  isProgressState,
  panelWork,
  progressActive,
  type ProgressItem,
} from "../../src/progress";
import type { ToolSection } from "./ui/Rail";

/** This panel's own caption work: the single-lecture run with the tab its
    audio comes from, and whether a several-lecture batch is preparing audio. */
export interface CaptionWork {
  readonly caption: ProgressItem | null;
  readonly source: number | null;
  readonly queuePreparing: boolean;
}

let work: CaptionWork = { caption: null, source: null, queuePreparing: false };
let workKey = JSON.stringify(work);
const listeners = new Set<() => void>();

function publish(next: CaptionWork): void {
  const key = JSON.stringify(next);
  if (key === workKey) return;
  workKey = key;
  work = next;
  for (const listener of listeners) listener();
}

/** This panel's own caption run, including extraction and upload the worker does not see. */
export function publishCaptionActivity(item: ProgressItem | null, source: number | null = null): void {
  publish({ ...work, caption: item, source: item ? source : null });
}

export function publishQueuePreparing(preparing: boolean): void {
  publish({ ...work, queuePreparing: preparing });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useCaptionWork(): CaptionWork {
  return useSyncExternalStore(subscribe, () => work);
}

/** Whether "make captions for the lecture you are watching" would duplicate
    work already under way: this panel is reading or uploading audio, which
    allows one lecture at a time, or the lecture in that tab is the one the
    current run is for. */
export function lectureBusy(current: CaptionWork, tabId: number | undefined): boolean {
  if (current.queuePreparing) return true;
  const { caption } = current;
  if (!caption || !progressActive(caption)) return false;
  return panelWork(caption) || (tabId !== undefined && current.source === tabId);
}

function useWorkerProgress(enabled: boolean): readonly ProgressItem[] {
  const [items, setItems] = useState<readonly ProgressItem[]>([]);
  useEffect(() => {
    if (!enabled || typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;
    let live = true;
    const listener = (message: unknown) => {
      if (isProgressState(message)) setItems(message.items);
    };
    chrome.runtime.onMessage.addListener(listener);
    void Promise.resolve(chrome.runtime.sendMessage?.(PROGRESS_GET))
      .then((state: unknown) => {
        if (live && isProgressState(state)) setItems(state.items);
      })
      .catch(() => {});
    return () => {
      live = false;
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [enabled]);
  return items;
}

export interface Activity {
  readonly section: ToolSection;
  readonly item: ProgressItem;
}

/** In-progress work per rail section: this panel's caption run first, then the worker's view. */
export function useActivity(enabled: boolean): readonly Activity[] {
  const worker = useWorkerProgress(enabled);
  const local = useCaptionWork().caption;
  const captions =
    (local && progressActive(local) ? local : null) ??
    worker.find((item) => item.kind === "captions" && progressActive(item));
  const playback = worker.find((item) => item.kind === "playback" && progressActive(item));
  const activity: Activity[] = [];
  if (playback) activity.push({ section: "playback", item: playback });
  if (captions) activity.push({ section: "captions", item: captions });
  return activity;
}
