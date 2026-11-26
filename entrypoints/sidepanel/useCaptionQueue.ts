import { useEffect, useRef, useState } from "react";
import {
  identifyMedia,
  MediaSourceError,
  requestCaptionMediaAccess,
  type MediaSource,
} from "../../src/captions/media-source";
import { errorCode, submitLecture } from "../../src/captions/submit-lecture";
import {
  CAPTION_JOB_PORT,
  type CaptionJobRequest,
  type CaptionJobUpdate,
} from "../../src/captions/job-monitor";
import type { JobPhase } from "../../src/captions/job-state";
import { LECTURE_TAB_KEY } from "../../src/open-tab";
import { queryActive, type QueryTarget } from "../../src/transport";

export type QueuePhase = "waiting" | "opening" | JobPhase;

export interface QueueItem {
  readonly handle: string;
  readonly title: string;
  readonly phase: QueuePhase;
  /** Bytes extracted, then bytes uploaded. */
  readonly progress: number | null;
  readonly errorCode: string | null;
  readonly jobId: string | null;
}

const MEDIA_WAIT_MS = 45_000;
const MEDIA_RETRY_MS = 1_500;
const MAX_RECONNECTS = 5;
// Every later lecture would fail the same way.
const FATAL = new Set(["QUOTA_EXCEEDED", "LOGIN_REQUIRED", "ACCOUNT_NOT_ALLOWED", "NO_SERVER", "PERMISSION"]);

function pause(ms: number, signal: AbortSignal): Promise<void> {
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

/** The player in the lecture tab once it shows a document other than the
    previous lecture's; the KU player loads a moment after the page. */
async function lectureMedia(previous: string | null, signal: AbortSignal): Promise<MediaSource> {
  const deadline = Date.now() + MEDIA_WAIT_MS;
  for (;;) {
    const saved: unknown = (await chrome.storage.session.get(LECTURE_TAB_KEY))[LECTURE_TAB_KEY];
    if (typeof saved === "number") {
      const media = await identifyMedia(saved).catch(() => null);
      if (media && media.documentId !== previous) return media;
    }
    if (signal.aborted) throw new MediaSourceError("UNSUPPORTED_MEDIA");
    if (Date.now() >= deadline) throw new MediaSourceError("UNSUPPORTED_MEDIA");
    await pause(MEDIA_RETRY_MS, signal);
  }
}

export function useCaptionQueue() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const port = useRef<chrome.runtime.Port | null>(null);
  const tracked = useRef(new Map<string, string>());
  const reconnects = useRef(0);
  const mounted = useRef(true);

  const patch = (match: (item: QueueItem) => boolean, change: Partial<QueueItem>) =>
    setItems((list) => list.map((item) => (match(item) ? { ...item, ...change } : item)));

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
      const ended = !snapshot || ["succeeded", "failed", "cancelled"].includes(snapshot.phase);
      if (ended) {
        tracked.current.delete(update.jobId);
        post({ type: "untrack", jobId: update.jobId });
      }
      patch((item) => item.jobId === update.jobId, snapshot
        ? { phase: snapshot.phase, errorCode: snapshot.errorCode }
        : { phase: "cancelled", errorCode: null });
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

  function track(jobId: string, key: string) {
    tracked.current.set(jobId, key);
    if (port.current) post({ type: "track", jobId, key });
    else connect();
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

  /** Call from the click handler: the media permission prompt needs the gesture. */
  async function start(
    selection: { handles: readonly string[]; target: QueryTarget },
    titleOf: (handle: string) => string,
  ) {
    if (controller.current) return;
    const access = requestCaptionMediaAccess();
    const abort = new AbortController();
    controller.current = abort;
    const { signal } = abort;
    setItems(selection.handles.map((handle) => ({
      handle,
      title: titleOf(handle),
      phase: "waiting",
      progress: null,
      errorCode: null,
      jobId: null,
    })));
    setRunning(true);
    try {
      if (!(await access)) {
        patch(() => true, { phase: "failed", errorCode: "PERMISSION" });
        return;
      }
      let previous: string | null = null;
      for (const handle of selection.handles) {
        if (signal.aborted) break;
        const mine = (item: QueueItem) => item.handle === handle;
        patch(mine, { phase: "opening" });
        try {
          const opened = await queryActive(
            { version: 1, type: "RECORDING_OPEN", handle, reuse: true },
            { target: selection.target, signal },
          );
          if (opened.status !== "success") {
            patch(mine, { phase: "failed", errorCode: opened.code });
            continue;
          }
          patch(mine, { phase: "identifying" });
          const media = await lectureMedia(previous, signal);
          previous = media.documentId;
          const submitted = await submitLecture(media, {
            signal,
            live: () => !signal.aborted,
            onJob: (jobId) => patch(mine, { jobId }),
            onPhase: (phase) => patch(mine, { phase, progress: 0 }),
            onProgress: (bytes) => patch(mine, { progress: bytes }),
          });
          if (!submitted) break;
          patch(mine, { phase: "queued", progress: null, jobId: submitted.jobId });
          track(submitted.jobId, submitted.key);
        } catch (error) {
          if (signal.aborted) break;
          const code = errorCode(error);
          patch(mine, { phase: "failed", progress: null, errorCode: code });
          if (FATAL.has(code)) {
            patch((item) => item.phase === "waiting", { phase: "failed", errorCode: code });
            break;
          }
        }
      }
    } finally {
      if (controller.current === abort) controller.current = null;
      if (mounted.current) {
        setRunning(false);
        patch(
          (item) => ["waiting", "opening", "identifying", "extracting", "uploading"].includes(item.phase),
          { phase: "cancelled", progress: null },
        );
      }
    }
  }

  return {
    items,
    running,
    start,
    clear: () => {
      if (!controller.current) setItems([]);
    },
    /** Stops opening and uploading; jobs already queued keep running. */
    stop: () => controller.current?.abort(),
  };
}
