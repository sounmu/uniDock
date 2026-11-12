import { useEffect, useState, useSyncExternalStore } from "react";
import {
  PROGRESS_GET,
  isProgressState,
  progressActive,
  type ProgressItem,
} from "../../src/progress";
import type { ToolSection } from "./ui/Rail";

let localCaption: ProgressItem | null = null;
let localKey = "null";
const listeners = new Set<() => void>();

/** This panel's own caption run, including extraction and upload the worker does not see. */
export function publishCaptionActivity(item: ProgressItem | null): void {
  const key = JSON.stringify(item);
  if (key === localKey) return;
  localKey = key;
  localCaption = item;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

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
  const local = useSyncExternalStore(subscribe, () => localCaption);
  const captions =
    (local && progressActive(local) ? local : null) ??
    worker.find((item) => item.kind === "captions" && progressActive(item));
  const playback = worker.find((item) => item.kind === "playback" && progressActive(item));
  const activity: Activity[] = [];
  if (playback) activity.push({ section: "playback", item: playback });
  if (captions) activity.push({ section: "captions", item: captions });
  return activity;
}
