import { useCallback, useEffect, useRef, useState } from "react";
import {
  identifyMedia,
  requestCaptionMediaAccess,
} from "../../src/captions/media-source";
import { withCaptionMediaRule } from "../../src/captions/referer-rule";
import { extractAudio } from "../../src/captions/audio-extract";
import { mediaRangeReader } from "../../src/captions/media-fetch";
import {
  cancelJob,
  createJob,
  uploadAudio,
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
  saveActiveJob,
} from "../../src/captions/job-record";
import { isTerminal, type JobPhase } from "../../src/captions/job-state";
import type { Transcript } from "../../src/captions/transcript";
import { safeLog } from "../../src/security/logger";
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
  /** Bytes extracted, then bytes uploaded. */
  progress: number | null;
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
  progress: null,
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

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
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
  const controller = useRef<AbortController | null>(null);
  const jobId = useRef<string | null>(null);
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
    jobTab.current = null;
    phase.current = "idle";
    stopLocal();
    setState(IDLE);
  }, [stopLocal]);

  /** Cancel or source-document loss: stop local work and cancel the server job. */
  const discard = useCallback(() => {
    const id = jobId.current;
    const active = !isTerminal(phase.current);
    untrack.current?.();
    forget();
    if (id) {
      if (active)
        void cancelJob(id).catch(() => safeLog("REQUEST_FAILED"));
      void clearActiveJob(id);
    }
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
              sourceUrl: "https://kucom.korea.ac.kr/",
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
      ]);
      if ((!saved.length && !cached) || stale()) return;
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
                sourceUrl: "https://kucom.korea.ac.kr/",
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
      // Closing the panel stops local capture only; accepted jobs keep running.
      stopLocal();
    };
  }, [discard, follow, run, stopLocal]);

  const generate = useCallback(async () => {
    const access = requestCaptionMediaAccess();
    discard();
    operation.current = startOperation("ai_captions_generate");
    await run(async (ctx) => {
      const { signal, live, set } = ctx;
      set({ ...IDLE, phase: "identifying" });
      if (!(await access)) throw new CaptionFlowError("PERMISSION");
      const media = await identifyMedia();
      if (!live()) return;
      jobTab.current = { tabId: media.tabId, windowId: media.windowId };
      lectureTitle.current = media.title;
      set({ title: media.title || null, durationS: media.durationS || null });
      const key = await captionJobKey(media.contentId);
      // The per-lecture key returns this user's existing job for the lecture,
      // so a repeat request skips extraction and upload entirely.
      const job = await createJob(
        key,
        { durationHintS: media.durationS || undefined },
        signal,
      );
      let id = job.id;
      jobId.current = id;
      if (!live()) return;
      if (job.state === "awaiting_upload") {
        set({ phase: "extracting", progress: 0 });
        const reader = mediaRangeReader(media.mediaUrl, signal);
        const audio = await withCaptionMediaRule(media.mediaUrl, async () =>
          extractAudio(await reader.totalSize(), reader.fetchRange, {
            signal,
            fetchRanges: reader.fetchRanges,
            onProgress: (bytes) => set({ progress: bytes }),
          }),
        );
        if (!live()) return;
        set({ phase: "uploading", progress: 0 });
        const upload = (target: string) =>
          uploadAudio(target, audio, signal, (bytes) => set({ progress: bytes }));
        try {
          await upload(id);
        } catch (error) {
          const code = errorCode(error);
          // UPLOAD_CLOSED: another upload of this job already finished, so the
          // job is simply followed below.
          if (code === "UPLOAD_CONFLICT") {
            // The job holds a different length (e.g. an older extraction).
            // The same key would return the same job, so cancel it to release
            // the key and upload once into a fresh job.
            await cancelJob(id, signal);
            const fresh = await createJob(
              key,
              { durationHintS: media.durationS || undefined },
              signal,
            );
            if (!live()) return;
            if (fresh.id === id || fresh.state !== "awaiting_upload") throw error;
            id = fresh.id;
            jobId.current = id;
            set({ progress: 0 });
            await upload(id);
          } else if (code !== "UPLOAD_CLOSED") throw error;
        }
      }
      if (!live()) return;
      await saveActiveJob({ jobId: id, key });
      set({ phase: "queued" });
      await follow(id, ctx, key);
    });
  }, [discard, follow, run]);

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
    );
  }, [state]);
  useEffect(() => () => publishCaptionActivity(null), []);

  return { state, generate, cancel };
}
