import { OPEN_RATE_WINDOW_MS } from "../open-tab";
import { cancelJob } from "./job-client";
import type { CaptionRuleChannel } from "./referer-rule";
import { submitLecture } from "./submit-lecture";
import {
  CaptionWorkError,
  errorCode,
  preparingPhase,
  workBusy,
  type CommandOutcome,
  type LectureMedia,
  type MediaReply,
  type OpenReply,
  type QueueWork,
  type QueueWorkItem,
  type RunCommand,
  type SingleWork,
  type WorkRuns,
} from "./work-protocol";

export const MEDIA_WAIT_MS = 45_000;
export const MEDIA_RETRY_MS = 1_500;
export const RATE_LIMIT_RETRY_MS = 5_000;
// Every later lecture would fail the same way.
const FATAL = new Set(["QUOTA_EXCEEDED", "LOGIN_REQUIRED", "ACCOUNT_NOT_ALLOWED", "NO_SERVER", "PERMISSION"]);
// Opens that fail this way fail the same way for every remaining lecture.
const LOST_SELECTION = new Set(["LOGIN_REQUIRED", "RELOAD_TAB", "STALE_SELECTION"]);
const DONE: CommandOutcome = { status: "success", accepted: null };

export type MediaRequest =
  | { readonly tabId: number }
  | { readonly lectureOf: number; readonly after: string | null };

export type WorkSnapshot = WorkRuns & { readonly unfinished: readonly string[] };

/** What the document needs of the worker. */
export interface WorkerLink {
  media(request: MediaRequest): Promise<MediaReply>;
  open(tabId: number, batch: string, index: number): Promise<OpenReply>;
  accept(jobId: string, key: string): Promise<void>;
  readonly rule: CaptionRuleChannel;
  publish(work: WorkSnapshot): void;
}

interface Run<State> {
  state: State;
  readonly controller: AbortController;
  /** A job the server has no audio of yet: stopping or failing cancels it,
      so it does not keep holding one of today's uses. */
  unfinished: string | null;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Reads and uploads lecture audio inside the offscreen document: one lecture
 * of one tab, or several lectures of a list tab one after another. It holds
 * the runs in memory and reports every change; nothing here depends on a
 * panel page being open.
 */
export class CaptionWorkRunner {
  private single: Run<SingleWork> | null = null;
  private queue: Run<QueueWork> | null = null;
  private readonly releasing = new Set<string>();

  constructor(private readonly link: WorkerLink) {}

  snapshot(): WorkSnapshot {
    const unfinished = new Set(this.releasing);
    for (const run of [this.single, this.queue])
      if (run?.unfinished) unfinished.add(run.unfinished);
    return {
      single: this.single?.state ?? null,
      queue: this.queue?.state ?? null,
      unfinished: [...unfinished],
    };
  }

  /** Whether the worker must stay reachable: work or a cancellation is in flight. */
  busy(): boolean {
    const work = this.snapshot();
    return workBusy(work) || work.unfinished.length > 0;
  }

  async command(command: RunCommand): Promise<CommandOutcome> {
    if (command.type === "CAPTION_WORK_DISMISS") {
      if (this.queue?.state.run === command.run && !this.queue.state.running) {
        this.queue = null;
        this.publish();
      }
      return DONE;
    }
    if (command.type === "CAPTION_WORK_CANCEL")
      return command.kind === "single"
        ? this.cancelSingle(command.run)
        : this.stopQueue(command.run);
    // One lecture's audio at a time, whoever asked.
    if (workBusy(this.snapshot())) return { status: "error", code: "ACTIVE_JOB_EXISTS" };
    const controller = new AbortController();
    if (command.kind === "single") {
      const run: Run<SingleWork> = {
        state: {
          run: command.run,
          tabId: command.tabId,
          documentId: null,
          phase: "identifying",
          jobId: null,
          key: null,
          errorCode: null,
          title: "",
          durationS: 0,
        },
        controller,
        unfinished: null,
      };
      this.single = run;
      this.publish();
      void this.runSingle(run);
      return DONE;
    }
    const run: Run<QueueWork> = {
      state: {
        run: command.run,
        tabId: command.tabId,
        running: true,
        items: command.items.map(({ handle, title }) => ({
          handle,
          title,
          phase: "waiting",
          errorCode: null,
          jobId: null,
          key: null,
        })),
      },
      controller,
      unfinished: null,
    };
    this.queue = run;
    this.publish();
    void this.runQueue(run);
    return DONE;
  }

  /** The sign-in changed: the jobs belong to the earlier account and stay untouched. */
  sessionEnded(): void {
    for (const run of [this.single, this.queue]) run?.controller.abort();
    this.single = null;
    this.queue = null;
    this.publish();
  }

  private publish(): void {
    this.link.publish(this.snapshot());
  }

  private async release(run: Run<unknown>): Promise<void> {
    const id = run.unfinished;
    run.unfinished = null;
    if (id) this.releasing.add(id);
    this.publish();
    if (!id) return;
    await cancelJob(id).catch(() => {});
    this.releasing.delete(id);
    this.publish();
  }

  private async cancelSingle(id: string): Promise<CommandOutcome> {
    const run = this.single;
    if (run?.state.run !== id) return DONE;
    this.single = null;
    run.controller.abort();
    const accepted = run.state.phase === "queued" ? run.state.jobId : null;
    await this.release(run);
    return { status: "success", accepted };
  }

  private async stopQueue(id: string): Promise<CommandOutcome> {
    const run = this.queue;
    if (run?.state.run !== id || !run.state.running) return DONE;
    run.controller.abort();
    this.endQueue(run);
    await this.release(run);
    return DONE;
  }

  private setSingle(run: Run<SingleWork>, change: Partial<SingleWork>): void {
    if (this.single !== run) return;
    run.state = { ...run.state, ...change };
    this.publish();
  }

  private setItems(
    run: Run<QueueWork>,
    match: (item: QueueWorkItem, index: number) => boolean,
    change: Partial<QueueWorkItem>,
  ): void {
    if (this.queue !== run) return;
    run.state = {
      ...run.state,
      items: run.state.items.map((item, index) =>
        match(item, index) ? { ...item, ...change } : item,
      ),
    };
    this.publish();
  }

  private endQueue(run: Run<QueueWork>): void {
    if (this.queue !== run) return;
    run.state = {
      ...run.state,
      running: false,
      items: run.state.items.map((item) =>
        item.phase === "waiting" || item.phase === "opening" || preparingPhase(item.phase)
          ? { ...item, phase: "cancelled" }
          : item,
      ),
    };
    this.publish();
  }

  private submit(run: Run<unknown>, media: LectureMedia, hooks: {
    live: () => boolean;
    onJob: (jobId: string) => void;
    onPhase: (phase: "extracting" | "uploading") => void;
  }) {
    let job: string | null = null;
    return submitLecture(media, {
      signal: run.controller.signal,
      live: hooks.live,
      rule: this.link.rule,
      onJob: (jobId) => {
        job = jobId;
        // A job the server already had audio for is not this run's to cancel.
        if (run.unfinished) run.unfinished = jobId;
        hooks.onJob(jobId);
      },
      onPhase: (phase) => {
        if (phase === "extracting") run.unfinished = job;
        hooks.onPhase(phase);
      },
      accept: async (jobId, key) => {
        run.unfinished = null;
        await this.link.accept(jobId, key);
      },
    });
  }

  private async runSingle(run: Run<SingleWork>): Promise<void> {
    const live = () => this.single === run && !run.controller.signal.aborted;
    try {
      const reply = await this.link.media({ tabId: run.state.tabId });
      if (!live()) return;
      if (reply.status !== "success")
        throw new CaptionWorkError(reply.status === "error" ? reply.code : "UNSUPPORTED_MEDIA");
      const { media } = reply;
      this.setSingle(run, {
        documentId: media.documentId,
        key: media.key,
        title: media.title,
        durationS: media.durationS,
      });
      const submitted = await this.submit(run, media, {
        live,
        onJob: (jobId) => this.setSingle(run, { jobId }),
        onPhase: (phase) => this.setSingle(run, { phase }),
      });
      if (!submitted || !live()) return;
      this.setSingle(run, { phase: "queued", jobId: submitted.jobId });
    } catch (error) {
      // A cancelled run is released by whoever cancelled it.
      if (!live()) return;
      this.setSingle(run, { phase: "failed", errorCode: errorCode(error) });
      await this.release(run);
    }
  }

  /** The player in the lecture tab once it shows a document other than the
      previous lecture's; the KU player loads a moment after the page. */
  private async lectureMedia(
    tabId: number,
    previous: string | null,
    signal: AbortSignal,
  ): Promise<LectureMedia> {
    const deadline = Date.now() + MEDIA_WAIT_MS;
    for (;;) {
      const reply = await this.link.media({ lectureOf: tabId, after: previous });
      if (reply.status === "success") return reply.media;
      if (signal.aborted || Date.now() >= deadline)
        throw new CaptionWorkError("UNSUPPORTED_MEDIA");
      await pause(MEDIA_RETRY_MS, signal);
    }
  }

  private async runQueue(run: Run<QueueWork>): Promise<void> {
    const { signal } = run.controller;
    const { tabId, run: batch } = run.state;
    const live = () => this.queue === run && !signal.aborted;
    const waiting = (item: QueueWorkItem) => item.phase === "waiting";
    try {
      for (let index = 0; index < run.state.items.length; index++) {
        if (!live()) return;
        const mine = (_item: QueueWorkItem, at: number) => at === index;
        this.setItems(run, mine, { phase: "opening" });
        try {
          let opened = await this.link.open(tabId, batch, index);
          // The tab opener's limiter refuses before opening and the list tab
          // keeps the lecture, so waiting out one window admits it unless
          // something else keeps opening tabs from this list tab.
          const retryUntil = Date.now() + OPEN_RATE_WINDOW_MS;
          while (
            opened.status !== "success" &&
            opened.code === "RATE_LIMITED" &&
            Date.now() < retryUntil
          ) {
            await pause(RATE_LIMIT_RETRY_MS, signal);
            if (!live()) return;
            opened = await this.link.open(tabId, batch, index);
          }
          if (!live()) return;
          if (opened.status !== "success") {
            const { code } = opened;
            this.setItems(run, mine, { phase: "failed", errorCode: code });
            if (!LOST_SELECTION.has(code)) continue;
            this.setItems(run, waiting, { phase: "failed", errorCode: code });
            return;
          }
          this.setItems(run, mine, { phase: "identifying" });
          const media = await this.lectureMedia(tabId, opened.previous, signal);
          if (!live()) return;
          this.setItems(run, mine, { key: media.key });
          const submitted = await this.submit(run, media, {
            live,
            onJob: (jobId) => this.setItems(run, mine, { jobId }),
            onPhase: (phase) => this.setItems(run, mine, { phase }),
          });
          if (!submitted || !live()) return;
          this.setItems(run, mine, { phase: "queued", jobId: submitted.jobId });
        } catch (error) {
          if (!live()) return;
          const code = errorCode(error);
          this.setItems(run, mine, { phase: "failed", errorCode: code });
          // The next lecture, or a restart after a stop, may need the use this
          // job holds, and may get the same job back for the same lecture.
          await this.release(run);
          if (!live()) return;
          if (FATAL.has(code)) {
            this.setItems(run, waiting, { phase: "failed", errorCode: code });
            return;
          }
        }
      }
    } finally {
      this.endQueue(run);
    }
  }
}
