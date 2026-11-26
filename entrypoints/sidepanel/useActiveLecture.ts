import { useEffect, useState } from "react";
import { isLecturePage } from "../../src/captions/media-source";

export interface ActiveLecture {
  readonly title: string;
}

/** The lecture page open in the active tab, or null when that tab has none.
    Read from the tab's URL and title only, never by injecting into the page,
    and re-checked when the user switches tabs or windows or the tab changes. */
export function useActiveLecture(enabled: boolean): ActiveLecture | null {
  const [lecture, setLecture] = useState<ActiveLecture | null>(null);
  useEffect(() => {
    const tabs = chrome.tabs;
    if (!enabled || !tabs?.query) return;
    let live = true;
    let probeId = 0;
    const probe = () => {
      const id = ++probeId;
      void tabs.query({ active: true, currentWindow: true }).then(
        ([tab]) => {
          if (!live || id !== probeId) return;
          setLecture(tab && isLecturePage(tab.url) ? { title: tab.title ?? "" } : null);
        },
        () => live && id === probeId && setLecture(null),
      );
    };
    const updated = (
      _tabId: number,
      change: { status?: string; title?: string },
      tab: chrome.tabs.Tab,
    ) => {
      if (tab.active && (change.status === "complete" || change.title !== undefined)) probe();
    };
    const visible = () => {
      if (document.visibilityState === "visible") probe();
    };
    probe();
    tabs.onActivated.addListener(probe);
    tabs.onUpdated.addListener(updated);
    chrome.windows?.onFocusChanged?.addListener(probe);
    document.addEventListener("visibilitychange", visible);
    return () => {
      live = false;
      tabs.onActivated.removeListener(probe);
      tabs.onUpdated.removeListener(updated);
      chrome.windows?.onFocusChanged?.removeListener(probe);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled]);
  return lecture;
}
