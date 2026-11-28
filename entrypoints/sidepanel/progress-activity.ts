import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { subscribeWork, workState } from "../../src/captions/work-client";
import { workBusy, type CaptionWorkState } from "../../src/captions/work-protocol";
import {
  PROGRESS_GET,
  captionPreparing,
  isProgressState,
  progressActive,
  type ProgressItem,
} from "../../src/progress";
import type { ToolSection } from "./ui/Rail";
import { subscribePanelReady } from "../../src/panel-presence";

/** The lecture card's run with the tab its audio comes from. */
interface LectureRun {
  readonly caption: ProgressItem | null;
  readonly source: number | null;
}

/** Caption work as this panel sees it: its lecture card's run, and whether
    audio is being read or uploaded at all, by one lecture or a batch. */
export interface CaptionWork extends LectureRun {
  readonly preparing: boolean;
}

let lecture: LectureRun = { caption: null, source: null };
let lectureKey = JSON.stringify(lecture);
const listeners = new Set<() => void>();

/** The lecture card's run in this panel, from its first click to its transcript. */
export function publishCaptionActivity(item: ProgressItem | null, source: number | null = null): void {
  const next = { caption: item, source: item ? source : null };
  const key = JSON.stringify(next);
  if (key === lectureKey) return;
  lectureKey = key;
  lecture = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Caption preparation as the worker reports it; it goes on with no panel open. */
export function useWorkState(): CaptionWorkState {
  return useSyncExternalStore(subscribeWork, workState);
}

export function useCaptionWork(): CaptionWork {
  const own = useSyncExternalStore(subscribe, () => lecture);
  const preparing = workBusy(useWorkState());
  return useMemo(() => ({ ...own, preparing }), [own, preparing]);
}

/** Whether "make captions for the lecture you are watching" would duplicate
    work already under way: audio is being read or uploaded, which allows one
    lecture at a time, or the lecture in that tab is the one the current run
    is for. */
export function lectureBusy(current: CaptionWork, tabId: number | undefined): boolean {
  const { caption } = current;
  // A run just started here is preparing before the worker has reported it.
  if (current.preparing || (caption !== null && captionPreparing(caption))) return true;
  return (
    caption !== null && progressActive(caption) && tabId !== undefined && current.source === tabId
  );
}

function useWorkerProgress(enabled: boolean): readonly ProgressItem[] {
  const [items, setItems] = useState<readonly ProgressItem[]>([]);
  useEffect(() => {
    if (!enabled || typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;
    let live = true;
    let generation = 0;
    const listener = (message: unknown) => {
      if (isProgressState(message)) {
        generation++;
        setItems(message.items);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    const refresh = () => {
      const current = ++generation;
      void Promise.resolve(chrome.runtime.sendMessage?.(PROGRESS_GET))
        .then((state: unknown) => {
          if (live && current === generation && isProgressState(state)) setItems(state.items);
        })
        .catch(() => {});
    };
    const unsubscribe = subscribePanelReady(refresh);
    refresh();
    return () => {
      live = false;
      unsubscribe();
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
  const local = useSyncExternalStore(subscribe, () => lecture).caption;
  const captions =
    (local && progressActive(local) ? local : null) ??
    worker.find((item) => item.kind === "captions" && progressActive(item));
  const playback = worker.find((item) => item.kind === "playback" && progressActive(item));
  const activity: Activity[] = [];
  if (playback) activity.push({ section: "playback", item: playback });
  if (captions) activity.push({ section: "captions", item: captions });
  return activity;
}
