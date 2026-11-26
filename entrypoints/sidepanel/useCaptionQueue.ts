import { useEffect, useRef, useState } from "react";
import {
  identifyMedia,
  MediaSourceError,
  requestCaptionMediaAccess,
  type MediaSource,
} from "../../src/captions/media-source";
import { errorCode, submitLecture } from "../../src/captions/submit-lecture";
import { cancelJob } from "../../src/captions/job-client";
import { CAPTION_SESSION_EPOCH_KEY } from "../../src/caption-server-settings";
import { CAPTION_TRANSCRIPT_CACHE_KEY } from "../../src/captions/transcript-cache";
import {
  CAPTION_JOB_PORT,
  type CaptionJobRequest,
  type CaptionJobUpdate,
} from "../../src/captions/job-monitor";
import type { JobPhase } from "../../src/captions/job-state";
import { lectureTabKey, OPEN_RATE_WINDOW_MS } from "../../src/open-tab";
import type { Result } from "../../src/protocol";
import { queryActive, type QueryTarget } from "../../src/transport";
import { publishQueuePreparing } from "./progress-activity";

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
const RATE_LIMIT_RETRY_MS = 5_000;
const MAX_RECONNECTS = 5;
// Every later lecture would fail the same way.
const FATAL = new Set(["QUOTA_EXCEEDED", "LOGIN_REQUIRED", "ACCOUNT_NOT_ALLOWED", "NO_SERVER", "PERMISSION"]);
// The list tab answers this way for every remaining lecture too.
const LOST_SELECTION = new Set(["LOGIN_REQUIRED", "RELOAD_TAB", "STALE_SELECTION"]);
// A run stopped by a sign-in change must not touch the next account's jobs.
const SESSION_CHANGED = "session-changed";

const PREPARING: ReadonlySet<QueuePhase> = new Set([
  "waiting",
  "opening",
  "identifying",
  "extracting",
  "uploading",
]);

class QueueError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function savedLectureTab(source: number): Promise<number | null> {
  const key = lectureTabKey(source);
  const saved: unknown = (await chrome.storage.session.get(key))[key];
  return typeof saved === "number" ? saved : null;
}

/** The player document the lecture tab shows right now, if any. */
async function lectureDocument(source: number): Promise<string | null> {
  const tab = await savedLectureTab(source);
  if (tab === null) return null;
  return (await identifyMedia(tab).catch(() => null))?.documentId ?? null;
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

/** The player in the lecture tab once `confirm` says its document belongs to
    the lecture just opened; the KU player loads a moment after the page, and
    the previous lecture's document is never asked about. A player that is
    found but not confirmed in time is a mismatch, so its audio is not read;
    a tab that moved on to a page without a player is not. */
async function lectureMedia(
  source: number,
  previous: string | null,
  confirm: (player: string) => Promise<Result>,
  signal: AbortSignal,
): Promise<MediaSource> {
  const deadline = Date.now() + MEDIA_WAIT_MS;
  let unverified = false;
  for (;;) {
    const saved = await savedLectureTab(source);
    const media = saved === null ? null : await identifyMedia(saved).catch(() => null);
    // A stop or a local-data wipe during either read must not reach the
    // submission, which writes to storage before it looks at the signal.
    if (signal.aborted) throw new MediaSourceError("UNSUPPORTED_MEDIA");
    let limited = false;
    if (media && media.documentId !== previous) {
      unverified = true;
      const verdict = await confirm(media.documentId);
      if (signal.aborted) throw new MediaSourceError("UNSUPPORTED_MEDIA");
      if ("verified" in verdict) return media;
      if (verdict.status === "error" && LOST_SELECTION.has(verdict.code))
        throw new QueueError(verdict.code);
      limited = verdict.status === "error" && verdict.code === "RATE_LIMITED";
    }
    if (Date.now() >= deadline) {
      if (limited) throw new QueueError("RATE_LIMITED");
      throw unverified || media
        ? new QueueError("LECTURE_MISMATCH")
        : new MediaSourceError("UNSUPPORTED_MEDIA");
    }
    await pause(limited ? RATE_LIMIT_RETRY_MS : MEDIA_RETRY_MS, signal);
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
    const storageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      const cache = changes[CAPTION_TRANSCRIPT_CACHE_KEY];
      const epoch = changes[CAPTION_SESSION_EPOCH_KEY];
      if (
        (area === "local" && cache?.oldValue !== undefined && cache.newValue === undefined) ||
        (area === "session" && epoch && epoch.oldValue !== epoch.newValue)
      )
        controller.current?.abort(SESSION_CHANGED);
    };
    chrome.storage.onChanged.addListener(storageChanged);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      document.removeEventListener("visibilitychange", reveal);
      chrome.storage.onChanged.removeListener(storageChanged);
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
      // Spend the list's short-lived handles now, and only once the media can
      // be read; the list tab keeps the lectures as long as uploads take.
      const admitted = await queryActive(
        { version: 1, type: "CAPTION_BATCH_ADMIT", handles: [...selection.handles] },
        { target: selection.target, signal },
      ).catch((error: unknown) => ({ status: "error" as const, code: errorCode(error) }));
      if (!("batch" in admitted)) {
        if (!signal.aborted)
          patch(() => true, {
            phase: "failed",
            errorCode: admitted.status === "error" ? admitted.code : "STALE_SELECTION",
          });
        return;
      }
      for (const [index, handle] of selection.handles.entries()) {
        if (signal.aborted) break;
        const mine = (item: QueueItem) => item.handle === handle;
        patch(mine, { phase: "opening" });
        // A job whose audio is not uploaded yet; stopping or failing cancels it
        // so it does not keep holding one of today's uses.
        let unfinished: string | null = null;
        const release = (): Promise<void> =>
          unfinished && signal.reason !== SESSION_CHANGED
            ? cancelJob(unfinished).catch(() => {})
            : Promise.resolve();
        try {
          // The tab may still show the last lecture until the new page commits,
          // and the user may switch it during a retry wait, so read it per attempt.
          let previous: string | null = null;
          const open = async () => {
            previous = await lectureDocument(selection.target.id);
            return queryActive(
              { version: 1, type: "CAPTION_BATCH_OPEN", batch: admitted.batch, index },
              { target: selection.target, signal },
            );
          };
          let opened = await open();
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
            if (signal.aborted) break;
            opened = await open();
          }
          if (signal.aborted) break;
          if (opened.status !== "success") {
            patch(mine, { phase: "failed", errorCode: opened.code });
            if (!LOST_SELECTION.has(opened.code)) continue;
            patch((item) => item.phase === "waiting", { phase: "failed", errorCode: opened.code });
            break;
          }
          patch(mine, { phase: "identifying" });
          // The list tab knows the address it opened; the panel passes only
          // the id of the player document it read the media from.
          const media = await lectureMedia(
            selection.target.id,
            previous,
            (player) =>
              queryActive(
                { version: 1, type: "CAPTION_BATCH_VERIFY", batch: admitted.batch, index, document: player },
                { target: selection.target, signal },
              ).catch((): Result => ({ status: "error", code: "LECTURE_MISMATCH" })),
            signal,
          );
          let job: string | null = null;
          const submitted = await submitLecture(media, {
            signal,
            live: () => !signal.aborted,
            onJob: (jobId) => {
              job = jobId;
              if (unfinished) unfinished = jobId;
              patch(mine, { jobId });
            },
            onPhase: (phase) => {
              if (phase === "extracting") unfinished = job;
              patch(mine, { phase, progress: 0 });
            },
            onProgress: (bytes) => patch(mine, { progress: bytes }),
          });
          if (!submitted) {
            await release();
            break;
          }
          unfinished = null;
          patch(mine, { phase: "queued", progress: null, jobId: submitted.jobId });
          track(submitted.jobId, submitted.key);
        } catch (error) {
          if (signal.aborted) {
            await release();
            break;
          }
          // The next lecture, or a restart after a stop, may need the use this
          // job holds, and may get the same job back for the same lecture.
          await release();
          const code = errorCode(error);
          patch(mine, { phase: "failed", progress: null, errorCode: code });
          if (FATAL.has(code) || LOST_SELECTION.has(code)) {
            patch((item) => item.phase === "waiting", { phase: "failed", errorCode: code });
            break;
          }
        }
      }
    } finally {
      if (controller.current === abort) controller.current = null;
      if (mounted.current) {
        setRunning(false);
        patch((item) => PREPARING.has(item.phase), { phase: "cancelled", progress: null });
      }
    }
  }

  // While lectures still wait to be read and uploaded, the batch owns this
  // panel's one audio slot; the current-lecture card stays out of the way.
  const preparing = items.some((item) => PREPARING.has(item.phase));
  useEffect(() => publishQueuePreparing(preparing), [preparing]);
  useEffect(() => () => publishQueuePreparing(false), []);

  return {
    items,
    running,
    start,
    clear: () => {
      if (!controller.current) setItems([]);
    },
    /** Stops opening and uploading; jobs already queued keep running. */
    stop: () => controller.current?.abort("stopped"),
  };
}
