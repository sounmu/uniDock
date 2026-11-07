import type { CaptionJobSnapshot } from "./captions/job-monitor";
import type { PlaybackSnapshot } from "./playback/bridge";
import {
  captionProgressItem,
  playbackProgressItem,
  progressActive,
  type ProgressItem,
  type ProgressState,
} from "./progress";
import { allowedPage, LMS_MATCHES } from "./security/policy";

/**
 * Worker-side collection of caption jobs and playback. A change goes once to
 * open extension pages and to the top frame of LMS tabs; LMS tabs hear nothing
 * while no work is or just was in progress, and a newly loaded LMS page gets
 * the current state only while something is in progress.
 */
export class ProgressHub {
  private captions: ProgressItem[] = [];
  private playback: ProgressItem | null = null;
  private sent = "[]";
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

  tabReady(tabId: number, url: string | undefined): void {
    const state = this.state();
    if (!url || !allowedPage(url) || !state.items.some(progressActive)) return;
    this.toTab(tabId, state);
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
    const active = state.items.some(progressActive);
    if (!active && !this.tabsInvolved) return;
    this.tabsInvolved = active;
    void chrome.tabs
      .query({ url: [...LMS_MATCHES] })
      .then((tabs) => {
        for (const tab of tabs) if (tab.id !== undefined) this.toTab(tab.id, state);
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
