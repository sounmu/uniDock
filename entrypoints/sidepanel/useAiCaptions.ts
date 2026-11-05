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
  getJob,
  getTranscript,
  getWorkerStatus,
  uploadAudio,
  type JobProgress,
} from "../../src/captions/job-client";
import {
  captionJobKey,
  clearActiveJob,
  loadActiveJob,
  saveActiveJob,
} from "../../src/captions/job-record";
import { isTerminal, serverPhase, type JobPhase } from "../../src/captions/job-state";
import { projectServerSegments, type Transcript } from "../../src/captions/transcript";
import { safeLog } from "../../src/security/logger";
import type { ErrorCode } from "../../src/analytics/report";
import { startOperation, type OperationHandle } from "./analytics";
import {
  CAPTION_TRANSCRIPT_CACHE_KEY,
  hasCachedTranscripts,
  loadCachedTranscript,
  saveCachedTranscript,
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
const POLL_QUEUED_MS = 10_000;
const POLL_RUNNING_MS = 5_000;
const POLL_VISIBLE_MS = 2_000;

interface Run {
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

  const stopLocal = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
  }, []);

  /** Cancel or source-document loss: stop local work and cancel the server job. */
  const discard = useCallback(() => {
    const id = jobId.current;
    const active = !isTerminal(phase.current);
    operation.current = null;
    jobId.current = null;
    jobTab.current = null;
    phase.current = "idle";
    stopLocal();
    if (id) {
      if (active)
        void cancelJob(id).catch(() => safeLog("REQUEST_FAILED"));
      void clearActiveJob();
    }
    setState(IDLE);
  }, [stopLocal]);

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
      await body({ signal, live, set });
    } catch (error) {
      if (!live()) return;
      const code = errorCode(error);
      if (code === "EXPIRED") void clearActiveJob();
      set({ phase: "failed", errorCode: code });
    }
  }, [stopLocal]);

  const poll = useCallback(async (id: string, { signal, live, set }: Run, key: string) => {
    while (live() && !signal.aborted) {
      const status = await getJob(id, signal);
      if (!live()) return;
      const next = serverPhase(status.state);
      if (!next) return set({ phase: "failed", errorCode: "RESPONSE" });
      const workerOffline =
        next === "queued" &&
        (await getWorkerStatus(signal).catch(() => "online" as const)) === "offline";
      if (!live()) return;
      set({
        phase: next === "succeeded" ? phase.current : next,
        serverProgress: status.progress ?? null,
        workerOffline,
      });
      if (next === "succeeded") {
        if (!status.transcriptId)
          return set({ phase: "failed", errorCode: "RESPONSE" });
        const server = await getTranscript(status.transcriptId, signal);
        if (!live()) return;
        const items = projectServerSegments(server.segments);
        const extractedAt = new Date().toISOString();
        await saveCachedTranscript(key, {
          items,
          engine: server.engine,
          modelRevision: server.modelRevision,
          expiresAt: server.expiresAt,
          extractedAt,
        }).catch(() => safeLog("REQUEST_FAILED"));
        if (!live()) return;
        set({
          phase: "succeeded",
          expiresAt: server.expiresAt || null,
          result: {
            transcript: {
              sourceUrl: "https://kucom.korea.ac.kr/",
              pageTitle: lectureTitle.current || "AI 자막",
              extractedAt,
              itemCount: items.length,
              items,
            },
            engine: server.engine,
            modelRevision: server.modelRevision,
          },
        });
        return;
      }
      if (next === "failed" || next === "cancelled") {
        void clearActiveJob();
        return set({
          phase: next,
          errorCode: next === "failed" ? status.errorCode || "FAILED" : null,
        });
      }
      const delay =
        document.visibilityState === "visible" && !workerOffline
          ? POLL_VISIBLE_MS
          : next === "running" ? POLL_RUNNING_MS : POLL_QUEUED_MS;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          document.removeEventListener("visibilitychange", reveal);
          resolve();
        };
        const reveal = () => {
          if (document.visibilityState === "visible") finish();
        };
        const timer = setTimeout(finish, delay);
        signal.addEventListener("abort", finish, { once: true });
        document.addEventListener("visibilitychange", reveal);
        if (signal.aborted) finish();
      });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Only navigation or closing of the source player invalidates this run.
    // Selecting another tab must not cancel extraction, upload or polling.
    const changed = (tabId: number, change: { status?: string; url?: string }) => {
      if (
        tabId === jobTab.current?.tabId &&
        (change.status === "loading" || change.url !== undefined)
      )
        discard();
    };
    const removed = (tabId: number) => {
      if (tabId === jobTab.current?.tabId) discard();
    };
    chrome.tabs.onUpdated.addListener(changed);
    chrome.tabs.onRemoved.addListener(removed);
    const storageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      const cache = changes[CAPTION_TRANSCRIPT_CACHE_KEY];
      if (area === "local" && cache?.oldValue && cache.newValue === undefined)
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
      const [saved, cached] = await Promise.all([
        loadActiveJob(),
        hasCachedTranscripts().catch(() => false),
      ]);
      if ((!saved && !cached) || stale()) return;
      // Show the saved job only on the lecture it was made for.
      let key: string;
      let title: string;
      let durationS: number;
      let source: { tabId: number; windowId: number };
      try {
        const media = await identifyMedia();
        title = media.title;
        durationS = media.durationS;
        source = { tabId: media.tabId, windowId: media.windowId };
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
        void run(async ({ set }) => {
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
      if (!saved || key !== saved.key) return;
      const id = saved.jobId;
      jobId.current = id;
      void run(async (ctx) => {
        ctx.set({ phase: "queued", title: title || null, durationS: durationS || null });
        await poll(id, ctx, key);
      });
    })();
    return () => {
      mounted.current = false;
      chrome.tabs.onUpdated.removeListener(changed);
      chrome.tabs.onRemoved.removeListener(removed);
      chrome.storage.onChanged.removeListener(storageChanged);
      // Closing the panel stops local capture only; accepted jobs keep running.
      stopLocal();
    };
  }, [discard, poll, run, stopLocal]);

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
      await poll(id, ctx, key);
    });
  }, [discard, poll, run]);

  const cancel = useCallback(() => {
    operation.current?.cancel();
    discard();
  }, [discard]);

  return { state, generate, cancel };
}
