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
import { captionServerOrigin } from "../../src/caption-server-settings";
import { safeLog } from "../../src/security/logger";

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
}

const IDLE: AiCaptionState = {
  phase: "idle",
  progress: null,
  serverProgress: null,
  workerOffline: false,
  errorCode: null,
  expiresAt: null,
  result: null,
};
const POLL_QUEUED_MS = 10_000;
const POLL_RUNNING_MS = 5_000;

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

export function useAiCaptions() {
  const [state, setState] = useState<AiCaptionState>(IDLE);
  const controller = useRef<AbortController | null>(null);
  const jobId = useRef<string | null>(null);
  const jobTab = useRef<{ tabId: number; windowId: number } | null>(null);
  const phase = useRef<JobPhase>("idle");
  const generation = useRef(0);
  const mounted = useRef(false);

  const stopLocal = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
  }, []);

  /** User cancel or tab change: stop local work and cancel the server job. */
  const discard = useCallback(() => {
    const id = jobId.current;
    const active = !isTerminal(phase.current);
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

  const poll = useCallback(async (id: string, { signal, live, set }: Run) => {
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
        set({
          phase: "succeeded",
          expiresAt: server.expiresAt || null,
          result: {
            transcript: {
              sourceUrl: "https://kucom.korea.ac.kr/",
              pageTitle: "AI 자막",
              extractedAt: new Date().toISOString(),
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
      await new Promise((resolve) =>
        setTimeout(resolve, next === "running" ? POLL_RUNNING_MS : POLL_QUEUED_MS),
      );
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Only the player tab this job started from matters: its navigation or
    // closing, or switching away from it in its own window. Other tabs and
    // windows, and jobs restored on reopen (no tab), are left alone.
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
    const switched = ({ tabId, windowId }: { tabId: number; windowId: number }) => {
      const tab = jobTab.current;
      if (tab && windowId === tab.windowId && tabId !== tab.tabId) discard();
    };
    chrome.tabs.onActivated.addListener(switched);
    chrome.tabs.onUpdated.addListener(changed);
    chrome.tabs.onRemoved.addListener(removed);
    // A job the server already accepted survives a closed panel; show it again.
    // A Generate or cancel that starts while storage is read bumps the
    // generation; the late restore must not replace it.
    const restoreGeneration = generation.current;
    const stale = () =>
      !mounted.current ||
      jobId.current !== null ||
      generation.current !== restoreGeneration;
    void (async () => {
      const saved = await loadActiveJob();
      if (!saved || stale()) return;
      // Show the saved job only on the lecture it was made for.
      let key: string;
      try {
        key = await captionJobKey((await identifyMedia()).contentId);
      } catch {
        return;
      }
      if (key !== saved.key || stale()) return;
      const id = saved.jobId;
      jobId.current = id;
      void run(async (ctx) => {
        ctx.set({ phase: "queued" });
        await poll(id, ctx);
      });
    })();
    return () => {
      mounted.current = false;
      chrome.tabs.onActivated.removeListener(switched);
      chrome.tabs.onUpdated.removeListener(changed);
      chrome.tabs.onRemoved.removeListener(removed);
      // Closing the panel stops local capture only; accepted jobs keep running.
      stopLocal();
    };
  }, [discard, poll, run, stopLocal]);

  const generate = useCallback(async () => {
    const access = requestCaptionMediaAccess();
    discard();
    await run(async (ctx) => {
      const { signal, live, set } = ctx;
      set({ ...IDLE, phase: "identifying" });
      if (!(await access)) throw new CaptionFlowError("PERMISSION");
      const media = await identifyMedia();
      if (!live()) return;
      jobTab.current = { tabId: media.tabId, windowId: media.windowId };
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
      await poll(id, ctx);
    });
  }, [discard, poll, run]);

  return { state, generate, cancel: discard, serverOrigin: captionServerOrigin() };
}
