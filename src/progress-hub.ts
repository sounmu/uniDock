import type { CaptionJobSnapshot } from "./captions/job-monitor";
import type { PlaybackSnapshot } from "./playback/bridge";
import {
  captionProgressItem,
  panelWork,
  playbackProgressItem,
  progressActive,
  type ProgressItem,
  type ProgressState,
} from "./progress";
import { allowedPage, LMS_MATCHES } from "./security/policy";

const NOTHING: ProgressState = { version: 1, type: "PROGRESS_STATE", items: [] };

/**
 * Worker-side collection of caption jobs and playback. A change goes once to
 * open extension pages and to the top frame of LMS tabs; LMS tabs hear nothing
 * while no work is or just was in progress, and a newly loaded LMS page gets
 * the current state only while something is in progress. A window with an open
 * panel page shows the work in that panel, so its LMS tabs are told there is
 * nothing to show until the panel closes.
 */
export class ProgressHub {
  private captions: ProgressItem[] = [];
  private playback: ProgressItem | null = null;
  private panels: ReadonlySet<number> = new Set();
  private sent = "[]";
  private shown = "[]";
  private tabsInvolved = false;

  state(): ProgressState {
    const items = this.playback ? [this.playback, ...this.captions] : this.captions;
    return { version: 1, type: "PROGRESS_STATE", items };
  }

  setCaptions(snapshots: readonly CaptionJobSnapshot[]): void {
    this.captions = snapshots.slice(-8).map(captionProgressItem);
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
    const view = this.view();
    if (view.items.some(progressActive)) this.toTab(tabId, view);
  }

  /** A tab dragged to another window follows the panel of its new window. */
  tabMoved(tabId: number): void {
    void chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.url && allowedPage(tab.url) && this.panels.has(tab.windowId))
          this.toTab(tabId, NOTHING);
        else this.tabReady(tabId, tab.url, tab.windowId);
      })
      .catch(() => {});
  }

  /**
   * What LMS pages may show. Preparing a job (reading and uploading its audio)
   * happens in a panel page: with no panel page left nothing advances it, so
   * it is not shown as in progress.
   */
  private view(): ProgressState {
    const state = this.state();
    return this.panels.size
      ? state
      : { ...state, items: state.items.filter((item) => !panelWork(item)) };
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
    const view = this.view();
    const text = JSON.stringify(view.items);
    const active = view.items.some(progressActive);
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
        const now = this.view();
        const live = now.items.some(progressActive);
        for (const tab of tabs) {
          if (tab.id === undefined) continue;
          const moved = touched.has(tab.windowId);
          if (this.panels.has(tab.windowId)) {
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
