import { useCallback, useEffect, useRef, useState } from "react";
import {
  identifyMedia,
  MediaSourceError,
  requestCaptionMediaAccess,
} from "../../src/captions/media-source";
import { subscribeWork, workCommand, workState } from "../../src/captions/work-client";
import { errorCode, preparingPhase } from "../../src/captions/work-protocol";
import {
  cancelJob,
  type JobProgress,
} from "../../src/captions/job-client";
import {
  CAPTION_JOB_PORT,
  type CaptionJobRequest,
  type CaptionJobUpdate,
} from "../../src/captions/job-monitor";
import {
  captionJobKey,
  clearActiveJob,
  loadActiveJobs,
} from "../../src/captions/job-record";
import { isTerminal, type JobPhase } from "../../src/captions/job-state";
import type { Transcript } from "../../src/captions/transcript";
import type { VideoCaptionTarget } from "../../src/video-captions";
import { safeLog } from "../../src/security/logger";
import { KOREA_ORIGINS } from "../../src/security/origins";
import type { ErrorCode } from "../../src/analytics/report";
import { startOperation, type OperationHandle } from "./analytics";
import { publishCaptionActivity } from "./progress-activity";
import { captionPercent } from "../../src/progress";
import { CAPTION_SESSION_EPOCH_KEY } from "../../src/caption-server-settings";
import {
  CAPTION_TRANSCRIPT_CACHE_KEY,
  hasCachedTranscripts,
  loadCachedTranscript,
  readCaptionCacheEpoch,
} from "../../src/captions/transcript-cache";

export interface AiCaptionResult {
  transcript: Transcript;
  engine: string;
  modelRevision: string;
}

export interface AiCaptionState {
  phase: JobPhase;
  serverProgress: JobProgress | null;
  workerOffline: boolean;
  errorCode: string | null;
  expiresAt: string | null;
  result: AiCaptionResult | null;
  /** Player tab title and media length, shown in the panel only. */
  title: string | null;
  durationS: number | null;
  restoredFromCache: boolean;
}

const IDLE: AiCaptionState = {
  phase: "idle",
  serverProgress: null,
  workerOffline: false,
  errorCode: null,
  expiresAt: null,
  result: null,
  title: null,
  durationS: null,
  restoredFromCache: false,
};
const MAX_RECONNECTS = 5;

interface Run {
  epoch: string | null;
  signal: AbortSignal;
  live: () => boolean;
  set: (patch: Partial<AiCaptionState>) => void;
}

class CaptionFlowError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Server and client codes are open strings; statistics take fixed codes only. */
function statisticsCode(code: string): ErrorCode {
  if (code === "PERMISSION" || code === "TOO_LARGE" || code === "EXPIRED")
    return code;
  if (code === "NETWORK") return "NETWORK";
  if (code.startsWith("UPLOAD")) return "UPLOAD";
  if (/AUTH|LOGIN|SESSION|TOKEN/.test(code)) return "AUTH";
  if (code === "RESPONSE" || code === "FAILED" || code === "NO_SERVER")
    return "SERVER";
  return "OTHER";
}

export function useAiCaptions() {
  const [state, setState] = useState<AiCaptionState>(IDLE);
  /** The player document of the lecture this flow belongs to. */
  const [player, setPlayer] = useState<VideoCaptionTarget | null>(null);
  const controller = useRef<AbortController | null>(null);
  const jobId = useRef<string | null>(null);
  /** The preparation run this card shows; it lives in the offscreen document. */
  const workRun = useRef<string | null>(null);
  const jobTab = useRef<{ tabId: number; windowId: number } | null>(null);
  const lectureTitle = useRef("");
  const phase = useRef<JobPhase>("idle");
  const generation = useRef(0);
  const mounted = useRef(false);
  // Only a Generate started in this panel has an operation; a restored job does not.
  const operation = useRef<OperationHandle | null>(null);
  const untrack = useRef<(() => void) | null>(null);

  const stopLocal = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
  }, []);

  const forget = useCallback(() => {
    operation.current = null;
    jobId.current = null;
    workRun.current = null;
    jobTab.current = null;
    phase.current = "idle";
    stopLocal();
    setState(IDLE);
    setPlayer(null);
  }, [stopLocal]);

  /**
   * Cancel or source-document loss: stop the run and cancel the server job.
   * Before the server has the audio the offscreen document holds the job and
   * cancels it; an accepted job is this panel's to cancel.
   */
  const discard = useCallback(() => {
    const id = jobId.current;
    const work = workRun.current;
    const active = !isTerminal(phase.current);
    untrack.current?.();
    forget();
    const release = (accepted: string) => {
      void cancelJob(accepted).catch(() => safeLog("REQUEST_FAILED"));
      void clearActiveJob(accepted);
    };
    if (work)
      void workCommand({
        version: 1,
        type: "CAPTION_WORK_CANCEL",
        kind: "single",
        run: work,
      }).then((reply) => {
        // The document handed the job over just before this cancel reached it.
        if (!id && reply.status === "success" && reply.accepted) release(reply.accepted);
      });
    if (!id) return;
    if (active) release(id);
    else void clearActiveJob(id);
  }, [forget]);

  const run = useCallback(async (body: (run: Run) => Promise<void>) => {
    stopLocal();
    const current = generation.current;
    const signal = (controller.current = new AbortController()).signal;
    const live = () => mounted.current && current === generation.current;
    const set = (patch: Partial<AiCaptionState>) => {
      if (!live()) return;
      if (patch.phase) phase.current = patch.phase;
      setState((prev) => ({ ...prev, ...patch }));
      const op = operation.current;
      if (!op || !patch.phase || !isTerminal(patch.phase)) return;
      operation.current = null;
      if (patch.phase === "succeeded") op.success();
      else if (patch.phase === "cancelled") op.cancel();
      else if (patch.errorCode === "TIMEOUT") op.timeout();
      else op.failure(statisticsCode(patch.errorCode ?? "FAILED"));
    };
    try {
      const epoch = await readCaptionCacheEpoch();
      if (!live()) return;
      await body({ signal, live, set, epoch });
    } catch (error) {
      if (!live()) return;
      const code = errorCode(error);
      const id = jobId.current;
      if (code === "EXPIRED" && id) void clearActiveJob(id);
      set({ phase: "failed", errorCode: code });
    }
  }, [stopLocal]);

  /**
   * Follows an accepted job through the worker's CaptionJobMonitor, which
   * polls the server and caches the transcript. The port stays open only while
   * the job is followed; a worker restart drops it and the job is re-tracked.
   */
  const follow = useCallback((id: string, { signal, live, set }: Run, key: string) =>
    new Promise<void>((resolve) => {
      let port: chrome.runtime.Port | null = null;
      let reconnects = 0;
      let showing = false;
      let settled = false;
      const post = (request: CaptionJobRequest) => {
        try {
          port?.postMessage(request);
        } catch {
          // A dropped port is reconnected by its onDisconnect handler.
        }
      };
      const reveal = () =>
        post({ type: "visible", visible: document.visibilityState === "visible" });
      const leave = () => post({ type: "untrack", jobId: id });
      const done = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", done);
        document.removeEventListener("visibilitychange", reveal);
        if (untrack.current === leave) untrack.current = null;
        const closing = port;
        port = null;
        closing?.disconnect();
        resolve();
      };
      const show = async (update: CaptionJobUpdate) => {
        const value = update.result ?? (await loadCachedTranscript(key).catch(() => null));
        if (!value) return set({ phase: "failed", errorCode: "RESPONSE" });
        set({
          phase: "succeeded",
          serverProgress: update.snapshot?.serverProgress ?? null,
          expiresAt: value.expiresAt || null,
          result: {
            transcript: {
              sourceUrl: `${KOREA_ORIGINS.player}/`,
              pageTitle: lectureTitle.current || "AI 자막",
              extractedAt: value.extractedAt,
              itemCount: value.items.length,
              items: value.items,
            },
            engine: value.engine,
            modelRevision: value.modelRevision,
          },
        });
      };
      const receive = (message: unknown) => {
        if (settled || showing) return;
        if (!live()) return done();
        const update = message as CaptionJobUpdate;
        if (update.jobId !== id) return;
        const snapshot = update.snapshot;
        // The worker dropped this job: local data was deleted or the session ended.
        if (!snapshot) return forget();
        if (snapshot.phase === "succeeded") {
          showing = true;
          void show(update).finally(done);
          return;
        }
        if (snapshot.phase === "failed" || snapshot.phase === "cancelled") {
          set({ phase: snapshot.phase, errorCode: snapshot.errorCode });
          return done();
        }
        set({
          phase: snapshot.phase,
          serverProgress: snapshot.serverProgress,
          workerOffline: snapshot.workerOffline,
        });
      };
      const start = () => {
        const current = chrome.runtime.connect({ name: CAPTION_JOB_PORT });
        port = current;
        current.onMessage.addListener(receive);
        current.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          if (port !== current) return;
          port = null;
          if (settled || showing) return;
          if (reconnects++ < MAX_RECONNECTS) return start();
          set({ phase: "failed", errorCode: "UNKNOWN" });
          done();
        });
        reveal();
        post({ type: "track", jobId: id, key });
      };
      if (signal.aborted) return done();
      signal.addEventListener("abort", done, { once: true });
      document.addEventListener("visibilitychange", reveal);
      untrack.current = leave;
      start();
    }), [forget]);

  /**
   * Shows a preparation run of the offscreen document until the server has its
   * audio, then follows the accepted job. The run does not depend on this
   * panel: one that started before the panel opened is shown the same way.
   */
  const prepare = useCallback(async (id: string, ctx: Run) => {
    const { signal, live, set } = ctx;
    const accepted = await new Promise<{ jobId: string; key: string } | null>(
      (resolve, reject) => {
        let unsubscribe = () => {};
        let settled = false;
        const finish = (act: () => void) => {
          if (settled) return;
          settled = true;
          unsubscribe();
          signal.removeEventListener("abort", stop);
          act();
        };
        const stop = () => finish(() => resolve(null));
        const check = () => {
          if (settled) return;
          if (!live()) return stop();
          const single = workState().single;
          // Stopped from another panel page, or its sign-in ended.
          if (single?.run !== id)
            return finish(() => {
              forget();
              resolve(null);
            });
          const { tabId, documentId } = single;
          if (single.title) lectureTitle.current = single.title;
          if (documentId)
            setPlayer((shown) =>
              shown?.tabId === tabId && shown.documentId === documentId
                ? shown
                : { tabId, documentId },
            );
          set({ title: single.title || null, durationS: single.durationS || null });
          if (single.phase === "failed")
            return finish(() => reject(new CaptionFlowError(single.errorCode ?? "UNKNOWN")));
          if (single.phase !== "queued") return set({ phase: single.phase });
          const { jobId: job, key } = single;
          finish(() =>
            job && key ? resolve({ jobId: job, key }) : reject(new CaptionFlowError("RESPONSE")),
          );
        };
        unsubscribe = subscribeWork(check);
        if (signal.aborted) return stop();
        signal.addEventListener("abort", stop, { once: true });
        check();
      },
    );
    if (!accepted || !live()) return;
    jobId.current = accepted.jobId;
    set({ phase: "queued" });
    await follow(accepted.jobId, ctx, accepted.key);
  }, [follow, forget]);

  useEffect(() => {
    mounted.current = true;
    const changedSources = new Set<number>();
    let restoring = true;
    // Only navigation or closing of the source player invalidates this run.
    // Selecting another tab must not cancel extraction, upload or polling.
    const changed = (tabId: number, change: { status?: string; url?: string }) => {
      if (restoring && (change.status === "loading" || change.url !== undefined))
        changedSources.add(tabId);
      if (
        tabId === jobTab.current?.tabId &&
        (change.status === "loading" || change.url !== undefined)
      )
        discard();
    };
    const removed = (tabId: number) => {
      if (restoring) changedSources.add(tabId);
      if (tabId === jobTab.current?.tabId) discard();
    };
    chrome.tabs.onUpdated.addListener(changed);
    chrome.tabs.onRemoved.addListener(removed);
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
        discard();
    };
    chrome.storage.onChanged.addListener(storageChanged);
    // A job the server already accepted survives a closed panel; show it again.
    // A Generate or cancel that starts while storage is read bumps the
    // generation; the late restore must not replace it.
    const restoreGeneration = generation.current;
    const stale = () =>
      !mounted.current ||
      jobId.current !== null ||
      generation.current !== restoreGeneration;
    void (async () => {
      const restoreEpoch = await readCaptionCacheEpoch();
      if (stale()) return;
      const [saved, cached] = await Promise.all([
        loadActiveJobs(),
        hasCachedTranscripts().catch(() => false),
        workCommand({ version: 1, type: "CAPTION_WORK_GET" }),
      ]);
      // Reading or uploading audio went on while no panel was open, or just
      // failed: this lecture's card picks the run up where it is.
      const single = workState().single;
      const pending =
        single && (preparingPhase(single.phase) || single.phase === "failed") ? single : null;
      if ((!saved.length && !cached && !pending) || stale()) return;
      // Show the saved job only on the lecture it was made for.
      let key: string;
      let title: string;
      let durationS: number;
      let source: { tabId: number; windowId: number };
      try {
        const media = await identifyMedia();
        if (stale() || changedSources.has(media.tabId)) return;
        title = media.title;
        durationS = media.durationS;
        source = { tabId: media.tabId, windowId: media.windowId };
        jobTab.current = source;
        setPlayer({ tabId: media.tabId, documentId: media.documentId });
        if (
          pending &&
          pending.tabId === media.tabId &&
          (pending.documentId === null || pending.documentId === media.documentId)
        ) {
          workRun.current = pending.run;
          lectureTitle.current = title;
          void run((ctx) => prepare(pending.run, ctx));
          return;
        }
        key = await captionJobKey(media.contentId);
      } catch {
        return;
      }
      if (stale()) return;
      const transcript = await loadCachedTranscript(key).catch(() => null);
      if (stale()) return;
      lectureTitle.current = title;
      if (transcript) {
        jobTab.current = source;
        void run(async ({ set, epoch }) => {
          if (epoch !== restoreEpoch) return discard();
          set({
            phase: "succeeded",
            title: title || null,
            durationS: durationS || null,
            restoredFromCache: true,
            expiresAt: transcript.expiresAt,
            result: {
              engine: transcript.engine,
              modelRevision: transcript.modelRevision,
              transcript: {
                sourceUrl: `${KOREA_ORIGINS.player}/`,
                pageTitle: title || "AI 자막",
                extractedAt: transcript.extractedAt,
                itemCount: transcript.items.length,
                items: transcript.items,
              },
            },
          });
        });
        return;
      }
      const job = saved.find((j) => j.key === key);
      if (!job) return;
      const id = job.jobId;
      jobId.current = id;
      void run(async (ctx) => {
        if (ctx.epoch !== restoreEpoch) return discard();
        ctx.set({ phase: "queued", title: title || null, durationS: durationS || null });
        await follow(id, ctx, key);
      });
    })().catch((error: unknown) => {
      if (stale()) return;
      phase.current = "failed";
      setState({ ...IDLE, phase: "failed", errorCode: errorCode(error) });
    }).finally(() => {
      restoring = false;
      changedSources.clear();
    });
    return () => {
      mounted.current = false;
      chrome.tabs.onUpdated.removeListener(changed);
      chrome.tabs.onRemoved.removeListener(removed);
      chrome.storage.onChanged.removeListener(storageChanged);
      // Closing the panel only stops showing the work: reading, uploading
      // and accepted jobs all go on without it.
      stopLocal();
    };
  }, [discard, follow, prepare, run, stopLocal]);

  const generate = useCallback(async () => {
    const access = requestCaptionMediaAccess();
    discard();
    operation.current = startOperation("ai_captions_generate");
    await run(async (ctx) => {
      const { live, set } = ctx;
      set({ ...IDLE, phase: "identifying" });
      if (!(await access)) throw new CaptionFlowError("PERMISSION");
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!live()) return;
      if (tab?.id === undefined) throw new MediaSourceError("ACTIVATE_TAB");
      const id = crypto.randomUUID();
      workRun.current = id;
      jobTab.current = { tabId: tab.id, windowId: tab.windowId };
      const started = await workCommand({
        version: 1,
        type: "CAPTION_WORK_START",
        kind: "single",
        run: id,
        tabId: tab.id,
      });
      if (!live()) return;
      if (started.status === "error") throw new CaptionFlowError(started.code);
      await prepare(id, ctx);
    });
  }, [discard, prepare, run]);

  const cancel = useCallback(() => {
    operation.current?.cancel();
    discard();
  }, [discard]);

  useEffect(() => {
    publishCaptionActivity(
      state.phase === "idle"
        ? null
        : {
            kind: "captions",
            id: jobId.current ?? "local",
            phase: state.phase,
            percent: state.phase === "running" ? captionPercent(state.serverProgress) : null,
            workerOffline: state.workerOffline,
          },
      jobTab.current?.tabId ?? null,
    );
  }, [state]);
  useEffect(() => () => publishCaptionActivity(null), []);

  return { state, player, generate, cancel };
}
