import { useEffect, useRef, useState } from "react";
import { requestCaptionMediaAccess } from "../../src/captions/media-source";
import {
  CAPTION_JOB_PORT,
  type CaptionJobRequest,
  type CaptionJobUpdate,
} from "../../src/captions/job-monitor";
import type { JobPhase } from "../../src/captions/job-state";
import { workCommand } from "../../src/captions/work-client";
import { MAX_WORK_TITLE, errorCode } from "../../src/captions/work-protocol";
import { queryActive, type QueryTarget } from "../../src/transport";
import { useWorkState } from "./progress-activity";

export type QueuePhase = "waiting" | "opening" | JobPhase;

export interface QueueItem {
  readonly handle: string;
  readonly title: string;
  readonly phase: QueuePhase;
  readonly errorCode: string | null;
  readonly jobId: string | null;
}

/** What the worker's job monitor last said of a job the server accepted. */
interface Followed {
  readonly phase: JobPhase;
  readonly errorCode: string | null;
}

const MAX_RECONNECTS = 5;
/** The abort reason of a stop; closing the panel aborts with none and cancels nothing. */
const STOPPED = "stopped";
const ENDED: readonly JobPhase[] = ["succeeded", "failed", "cancelled"];

/**
 * Several lectures, one after another. The offscreen document opens each
 * lecture, reads its audio and uploads it, so the batch goes on after this
 * panel closes; a reopened panel shows it where it is. This hook starts and
 * stops the batch and follows the jobs the server accepted.
 */
export function useCaptionQueue() {
  const queue = useWorkState().queue;
  // The list before the document has it: asking for media access and
  // admitting the selection happen here, while the panel is open.
  const [local, setLocal] = useState<{ items: QueueItem[]; running: boolean } | null>(null);
  const [followed, setFollowed] = useState<Record<string, Followed>>({});
  const controller = useRef<AbortController | null>(null);
  const port = useRef<chrome.runtime.Port | null>(null);
  const tracked = useRef(new Map<string, string>());
  const finished = useRef(new Set<string>());
  const reconnects = useRef(0);
  const mounted = useRef(true);

  function post(request: CaptionJobRequest) {
    try {
      port.current?.postMessage(request);
    } catch {
      // A dropped port is reconnected by its onDisconnect handler.
    }
  }

  function connect() {
    const current = chrome.runtime.connect({ name: CAPTION_JOB_PORT });
    port.current = current;
    current.onMessage.addListener((message: unknown) => {
      const update = message as CaptionJobUpdate;
      if (!tracked.current.has(update.jobId)) return;
      const snapshot = update.snapshot;
      // An ended job stays with the worker, so another panel that opens it
      // later finds its result: only this list stops waiting for it.
      if (!snapshot || ENDED.includes(snapshot.phase)) {
        tracked.current.delete(update.jobId);
        finished.current.add(update.jobId);
      }
      setFollowed((jobs) => ({
        ...jobs,
        [update.jobId]: snapshot
          ? { phase: snapshot.phase, errorCode: snapshot.errorCode }
          : { phase: "cancelled", errorCode: null },
      }));
    });
    current.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port.current !== current) return;
      port.current = null;
      if (mounted.current && tracked.current.size && reconnects.current++ < MAX_RECONNECTS)
        connect();
    });
    post({ type: "visible", visible: document.visibilityState === "visible" });
    for (const [jobId, key] of tracked.current) post({ type: "track", jobId, key });
  }

  useEffect(() => {
    mounted.current = true;
    const reveal = () => post({ type: "visible", visible: document.visibilityState === "visible" });
    document.addEventListener("visibilitychange", reveal);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      document.removeEventListener("visibilitychange", reveal);
      const closing = port.current;
      port.current = null;
      closing?.disconnect();
    };
  }, []);

  const running = queue?.running ?? false;
  // A list running in the worker, started from another panel page, replaces
  // an attempt of this panel that already ended.
  useEffect(() => {
    if (running) setLocal((shown) => (shown?.running ? shown : null));
  }, [running]);

  const run = queue?.run;
  useEffect(() => {
    const jobs = tracked.current;
    const done = finished.current;
    // Another list: its jobs are no longer shown here. The worker goes on
    // following them, so they are not untracked.
    return () => {
      jobs.clear();
      done.clear();
      setFollowed({});
    };
  }, [run]);

  useEffect(() => {
    for (const item of queue?.items ?? []) {
      const { jobId, key } = item;
      if (item.phase !== "queued" || !jobId || !key) continue;
      if (tracked.current.has(jobId) || finished.current.has(jobId)) continue;
      tracked.current.set(jobId, key);
      if (port.current) post({ type: "track", jobId, key });
      else connect();
    }
  });

  /** Call from the click handler: the media permission prompt needs the gesture. */
  async function start(
    selection: { handles: readonly string[]; target: QueryTarget },
    titleOf: (handle: string) => string,
  ) {
    if (controller.current || queue?.running) return;
    const access = requestCaptionMediaAccess();
    const abort = new AbortController();
    controller.current = abort;
    const { signal } = abort;
    const items: QueueItem[] = selection.handles.map((handle) => ({
      handle,
      title: titleOf(handle),
      phase: "waiting",
      errorCode: null,
      jobId: null,
    }));
    const end = (phase: QueuePhase, code: string | null) => {
      if (mounted.current)
        setLocal({
          items: items.map((item) => ({ ...item, phase, errorCode: code })),
          running: false,
        });
    };
    setLocal({ items, running: true });
    try {
      if (!(await access)) return end("failed", "PERMISSION");
      // Spend the list's short-lived handles now, and only once the media can
      // be read; the list tab keeps the lectures as long as uploads take.
      const admitted = await queryActive(
        { version: 1, type: "CAPTION_BATCH_ADMIT", handles: [...selection.handles] },
        { target: selection.target, signal },
      ).catch((error: unknown) => ({ status: "error" as const, code: errorCode(error) }));
      if (signal.aborted) return end("cancelled", null);
      if (!("batch" in admitted))
        return end("failed", admitted.status === "error" ? admitted.code : "STALE_SELECTION");
      const started = await workCommand({
        version: 1,
        type: "CAPTION_WORK_START",
        kind: "queue",
        run: admitted.batch,
        tabId: selection.target.id,
        items: items.map(({ handle, title }) => ({
          handle,
          title: title.slice(0, MAX_WORK_TITLE),
        })),
      });
      if (started.status === "error") return end("failed", started.code);
      // Stopped while the worker was starting the list: the stop reached no
      // run then, so the batch is cancelled now that the worker holds it.
      if (signal.reason === STOPPED)
        await workCommand({
          version: 1,
          type: "CAPTION_WORK_CANCEL",
          kind: "queue",
          run: admitted.batch,
        });
      if (mounted.current) setLocal(null);
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  }

  const shown = running && !local?.running ? null : local;
  const items: readonly QueueItem[] =
    shown?.items ??
    (queue?.items ?? []).map((item) => {
      const job = item.phase === "queued" && item.jobId ? followed[item.jobId] : undefined;
      return {
        handle: item.handle,
        title: item.title,
        phase: job?.phase ?? item.phase,
        errorCode: job ? job.errorCode : item.errorCode,
        jobId: item.jobId,
      };
    });

  return {
    items,
    running: shown?.running ?? running,
    start,
    clear: () => {
      if (controller.current || running) return;
      setLocal(null);
      if (queue) void workCommand({ version: 1, type: "CAPTION_WORK_DISMISS", run: queue.run });
    },
    /** Stops opening and uploading; jobs already queued keep running. */
    stop: () => {
      controller.current?.abort(STOPPED);
      if (queue?.running)
        void workCommand({
          version: 1,
          type: "CAPTION_WORK_CANCEL",
          kind: "queue",
          run: queue.run,
        });
    },
  };
}
