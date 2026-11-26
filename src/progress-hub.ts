import type { CaptionJobSnapshot } from "./captions/job-monitor";
import type { WorkRuns } from "./captions/work-protocol";
import type { PlaybackSnapshot } from "./playback/bridge";
import {
  captionProgressItem,
  playbackProgressItem,
  progressActive,
  workProgressItems,
  type ProgressItem,
  type ProgressState,
} from "./progress";
import { allowedPage, LMS_MATCHES } from "./security/policy";

const NOTHING: ProgressState = { version: 1, type: "PROGRESS_STATE", items: [] };
const MAX_CAPTION_ITEMS = 8;

/** The newest items up to the cap; finished ones make room first, so a
    running job is never pushed out by one that is over. */
function capped(items: readonly ProgressItem[]): ProgressItem[] {
  let over = items.length - MAX_CAPTION_ITEMS;
  const kept = items.filter((item) => {
    if (over <= 0 || progressActive(item)) return true;
    over--;
    return false;
  });
  return kept.slice(-MAX_CAPTION_ITEMS);
}

/**
 * Worker-side collection of caption work and playback. Caption work is the
 * preparation the offscreen document does (reading and uploading audio, which
 * goes on with no panel open) and the jobs the server accepted. A change goes once to
 * open extension pages and to the top frame of LMS tabs; LMS tabs hear nothing
 * while no work is or just was in progress, and a newly loaded LMS page gets
 * the current state only while something is in progress. A window with an open
 * panel page shows the work in that panel, so its LMS tabs are told there is
 * nothing to show until the panel closes.
 */
export class ProgressHub {
  private captions: ProgressItem[] = [];
  private work: ProgressItem[] = [];
  private playback: ProgressItem | null = null;
  private panels: ReadonlySet<number> = new Set();
  /** The window each dragged tab was last attached to: a tab list read
      before the drag still names the old one. */
  private readonly attached = new Map<number, number>();
  private sent = "[]";
  private shown = "[]";
  private tabsInvolved = false;

  state(): ProgressState {
    // An accepted job is reported by the monitor before the document's next
    // report drops it from the preparation, so it is listed once, as followed.
    const followed = new Set(this.captions.map((item) => item.id));
    const captions = capped([
      ...this.captions,
      ...this.work.filter((item) => !followed.has(item.id)),
    ]);
    const items = this.playback ? [this.playback, ...captions] : captions;
    return { version: 1, type: "PROGRESS_STATE", items };
  }

  setCaptions(snapshots: readonly CaptionJobSnapshot[]): void {
    this.captions = capped(snapshots.map(captionProgressItem));
    this.changed();
  }

  setWork(runs: WorkRuns): void {
    this.work = workProgressItems(runs);
    this.changed();
  }

  setPlayback(snapshot: PlaybackSnapshot | null): void {
    this.playback = snapshot ? playbackProgressItem(snapshot) : null;
    this.changed();
  }

  setPanels(windows: ReadonlySet<number>): void {
    const touched = new Set(
      [...windows, ...this.panels].filter((id) => windows.has(id) !== this.panels.has(id)),
    );
    this.panels = windows;
    this.refresh(touched);
  }

  tabReady(tabId: number, url: string | undefined, windowId: number): void {
    if (!url || !allowedPage(url) || this.panels.has(windowId)) return;
    const state = this.state();
    if (state.items.some(progressActive)) this.toTab(tabId, state);
  }

  /** A tab dragged to another window follows the panel of its new window. */
  tabMoved(tabId: number, windowId: number): void {
    this.attached.set(tabId, windowId);
    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.url && allowedPage(tab.url) && this.panels.has(tab.windowId))
          this.toTab(tabId, NOTHING);
        else this.tabReady(tabId, tab.url, tab.windowId);
      })
      .catch(() => {});
  }

  private changed(): void {
    const state = this.state();
    const text = JSON.stringify(state.items);
    if (text === this.sent) return;
    this.sent = text;
    try {
      void chrome.runtime.sendMessage(state).catch(() => {});
    } catch {
      // No extension page is open to receive it.
    }
    this.refresh();
  }

  /** `touched`: windows whose panel just opened or closed. */
  private refresh(touched: ReadonlySet<number> = new Set()): void {
    const state = this.state();
    const text = JSON.stringify(state.items);
    const active = state.items.some(progressActive);
    const all = text !== this.shown && (active || this.tabsInvolved);
    if (all) {
      this.shown = text;
      this.tabsInvolved = active;
    }
    if (!all && !touched.size) return;
    void chrome.tabs
      .query({ url: [...LMS_MATCHES] })
      .then((tabs) => {
        // Panels and work may have changed while the tabs were listed, so each
        // tab gets what holds now; a late answer can never undo a newer one.
        const now = this.state();
        const live = now.items.some(progressActive);
        for (const tab of tabs) {
          if (tab.id === undefined) continue;
          const windowId = this.attached.get(tab.id) ?? tab.windowId;
          const moved = touched.has(windowId);
          if (this.panels.has(windowId)) {
            // Sent even with no work known: after a worker restart the page
            // may still show what the previous worker sent.
            if (moved) this.toTab(tab.id, NOTHING);
          } else if (all || (moved && live)) this.toTab(tab.id, now);
        }
      })
      .catch(() => {});
  }

  private toTab(tabId: number, state: ProgressState): void {
    try {
      void chrome.tabs.sendMessage(tabId, state, { frameId: 0 }).catch(() => {});
    } catch {
      // A tab closing meanwhile has no receiver.
    }
  }
}
