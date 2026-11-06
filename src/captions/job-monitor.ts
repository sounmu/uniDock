import { getJob, getTranscript, getWorkerStatus, type JobProgress } from "./job-client";
import {
  CAPTION_ACTIVE_JOB_KEY,
  MAX_ACTIVE_JOBS,
  clearActiveJob,
  loadActiveJobs,
  parseActiveJobs,
} from "./job-record";
import { serverPhase, type JobPhase } from "./job-state";
import { projectServerSegments } from "./transcript";
import {
  loadCachedTranscript,
  readCaptionCacheEpoch,
  saveCachedTranscript,
  type CachedTranscript,
} from "./transcript-cache";
import { CAPTION_SESSION_EPOCH_KEY } from "../caption-server-settings";
import { safeLog } from "../security/logger";

export const CAPTION_JOB_PORT = "unidock-caption-job";
export const CAPTION_JOB_ALARM = "unidock-caption-job";

/** What the worker knows about a followed job; no title, URL or LMS id. */
export interface CaptionJobSnapshot {
  readonly jobId: string;
  readonly key: string;
  readonly phase: JobPhase;
  readonly serverProgress: JobProgress | null;
  readonly workerOffline: boolean;
  readonly errorCode: string | null;
}

export type CaptionJobRequest =
  | { type: "track"; jobId: string; key: string }
  | { type: "untrack"; jobId: string }
  | { type: "visible"; visible: boolean };

export interface CaptionJobUpdate {
  type: "snapshot";
  jobId: string;
  /** null: the worker dropped the job (cancel, deleted data or ended session). */
  snapshot: CaptionJobSnapshot | null;
  /** The transcript, sent once per port with the succeeded snapshot. */
  result?: CachedTranscript;
}

/**
 * Status poll delays per job. A visible subscribed panel gets the fastest
 * updates; a hidden one the earlier panel cadence; with no subscriber the
 * worker polls slower but stays under the 30 s service worker idle limit,
 * since each poll's storage read keeps the worker alive.
 */
export const CAPTION_POLL_MS = {
  visible: 2_000,
  running: 5_000,
  queued: 10_000,
  unwatchedRunning: 15_000,
  unwatchedQueued: 25_000,
} as const;

const JOB_ID = /^[\w-]{1,128}$/;
const JOB_KEY = /^unidock-[0-9a-f]{40}$/;

export function captionJobRequest(message: unknown): CaptionJobRequest | null {
  if (typeof message !== "object" || message === null) return null;
  const m = message as Record<string, unknown>;
  const size = Object.keys(m).length;
  if (m.type === "visible" && size === 2 && typeof m.visible === "boolean")
    return { type: "visible", visible: m.visible };
  if (typeof m.jobId !== "string" || !JOB_ID.test(m.jobId)) return null;
  if (m.type === "untrack" && size === 2) return { type: "untrack", jobId: m.jobId };
  if (m.type === "track" && size === 3 && typeof m.key === "string" && JOB_KEY.test(m.key))
    return { type: "track", jobId: m.jobId, key: m.key };
  return null;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

interface Watcher {
  visible: boolean;
  readonly jobs: Set<string>;
  readonly delivered: Set<string>;
}

interface Run {
  readonly controller: AbortController;
  wake: () => void;
}

interface Job {
  readonly jobId: string;
  readonly key: string;
  snapshot: CaptionJobSnapshot;
  sent: string;
  result: CachedTranscript | null;
  run: Run | null;
}

export interface CaptionJobAlarm {
  set(): void;
  clear(): void;
}

const chromeAlarm: CaptionJobAlarm = {
  set: () => {
    void chrome.alarms?.create?.(CAPTION_JOB_ALARM, { periodInMinutes: 0.5 })?.catch?.(() => {});
  },
  clear: () => {
    void chrome.alarms?.clear?.(CAPTION_JOB_ALARM)?.catch?.(() => {});
  },
};

/**
 * Worker side of AI captions: follows each accepted job after its panel's
 * upload, caches its transcript and pushes its changes to the panels that
 * subscribed to it. Jobs keep being followed while no panel is open, so a
 * reopened panel finds the transcript cached. One periodic alarm, set only
 * while a job is followed, resumes them after the worker restarts.
 */
export class CaptionJobMonitor {
  private readonly watchers = new Map<chrome.runtime.Port, Watcher>();
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly alarm: CaptionJobAlarm = chromeAlarm,
    private readonly onChange: (jobs: CaptionJobSnapshot[]) => void = () => {},
  ) {}

  private changed(): void {
    this.onChange([...this.jobs.values()].map((job) => job.snapshot));
  }

  connect(port: chrome.runtime.Port): void {
    const watcher: Watcher = { visible: false, jobs: new Set(), delivered: new Set() };
    this.watchers.set(port, watcher);
    port.onMessage.addListener((message: unknown) => {
      const request = captionJobRequest(message);
      if (!request) return;
      if (request.type === "visible") {
        watcher.visible = request.visible;
        if (request.visible)
          for (const id of watcher.jobs) this.jobs.get(id)?.run?.wake();
      } else if (request.type === "untrack") this.drop(request.jobId);
      else this.track(request.jobId, request.key, port);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      this.watchers.delete(port);
    });
  }

  track(jobId: string, key: string, from?: chrome.runtime.Port): void {
    const watcher = from && this.watchers.get(from);
    watcher?.jobs.add(jobId);
    const job = this.jobs.get(jobId);
    if (job && (job.run || (job.snapshot.phase === "succeeded" && job.result))) {
      if (from && watcher) this.send(from, watcher, job);
      job.run?.wake();
      return;
    }
    // One job per lecture, as in the stored record: a new job replaces the old one.
    for (const other of this.jobs.values())
      if (other.key === key && other.jobId !== jobId) this.drop(other.jobId);
    this.start(jobId, key);
  }

  async resume(): Promise<void> {
    const saved = await loadActiveJobs().catch(() => []);
    for (const { jobId, key } of saved) {
      if (this.jobs.get(jobId)?.run) continue;
      const cached = await loadCachedTranscript(key).catch(() => null);
      if (!cached && !this.jobs.get(jobId)?.run) this.track(jobId, key);
    }
    this.updateAlarm();
  }

  storageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
    const epoch = changes[CAPTION_SESSION_EPOCH_KEY];
    const record = changes[CAPTION_ACTIVE_JOB_KEY];
    if (area === "session" && epoch && epoch.oldValue !== epoch.newValue) {
      for (const id of [...this.jobs.keys()]) this.drop(id);
      return;
    }
    if (area !== "local" || !record) return;
    // A running job whose record disappeared was cancelled or deleted elsewhere.
    const kept = new Set(parseActiveJobs(record.newValue).map((j) => j.jobId));
    for (const job of [...this.jobs.values()])
      if (job.run && !kept.has(job.jobId)) this.drop(job.jobId);
  }

  private start(jobId: string, key: string): void {
    while (this.jobs.size >= MAX_ACTIVE_JOBS) {
      const values = [...this.jobs.values()];
      const evicted = values.find((j) => !j.run) ?? values[0];
      if (!evicted) break;
      this.drop(evicted.jobId);
    }
    const run: Run = { controller: new AbortController(), wake: () => {} };
    const job: Job = {
      jobId,
      key,
      snapshot: {
        jobId,
        key,
        phase: "queued",
        serverProgress: null,
        workerOffline: false,
        errorCode: null,
      },
      sent: "",
      result: null,
      run,
    };
    this.jobs.set(jobId, job);
    this.publish(job);
    this.updateAlarm();
    void this.follow(job, run);
  }

  private updateAlarm(): void {
    if ([...this.jobs.values()].some((j) => j.run)) this.alarm.set();
    else this.alarm.clear();
  }

  private send(port: chrome.runtime.Port, watcher: Watcher, job: Job | null, jobId = job?.jobId): void {
    if (!jobId) return;
    const update: CaptionJobUpdate = { type: "snapshot", jobId, snapshot: job?.snapshot ?? null };
    if (job?.snapshot.phase === "succeeded" && job.result && !watcher.delivered.has(jobId)) {
      update.result = job.result;
      watcher.delivered.add(jobId);
    }
    try {
      port.postMessage(update);
    } catch {
      // A closing panel's port disappears; its onDisconnect removes it.
    }
  }

  private publish(job: Job): void {
    const text = JSON.stringify(job.snapshot);
    if (text === job.sent) return;
    job.sent = text;
    for (const [port, watcher] of this.watchers)
      if (watcher.jobs.has(job.jobId)) this.send(port, watcher, job);
    this.changed();
  }

  private drop(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.delete(jobId);
    if (job.run) {
      job.run.controller.abort();
      job.run.wake();
      job.run = null;
    }
    for (const [port, watcher] of this.watchers) {
      if (!watcher.jobs.delete(jobId)) continue;
      watcher.delivered.delete(jobId);
      this.send(port, watcher, null, jobId);
    }
    this.updateAlarm();
    this.changed();
  }

  private finish(job: Job, run: Run, patch: Partial<CaptionJobSnapshot>): void {
    if (job.run !== run) return;
    job.run = null;
    job.snapshot = { ...job.snapshot, ...patch };
    this.publish(job);
    this.updateAlarm();
  }

  private delay(job: Job, phase: JobPhase, workerOffline: boolean): number {
    const watchers = [...this.watchers.values()].filter((w) => w.jobs.has(job.jobId));
    const running = phase === "running";
    if (watchers.some((w) => w.visible) && !workerOffline) return CAPTION_POLL_MS.visible;
    if (watchers.length) return running ? CAPTION_POLL_MS.running : CAPTION_POLL_MS.queued;
    return running ? CAPTION_POLL_MS.unwatchedRunning : CAPTION_POLL_MS.unwatchedQueued;
  }

  private sleep(run: Run, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        run.wake = () => {};
        resolve();
      };
      const timer = setTimeout(finish, ms);
      run.wake = finish;
      if (run.controller.signal.aborted) finish();
    });
  }

  private async follow(job: Job, run: Run): Promise<void> {
    const { signal } = run.controller;
    const live = () => job.run === run && !signal.aborted;
    try {
      const epoch = await readCaptionCacheEpoch();
      const current = async () => {
        const latest = await readCaptionCacheEpoch();
        if (!live()) return false;
        if (latest === epoch) return true;
        this.drop(job.jobId);
        return false;
      };
      while (live()) {
        const status = await getJob(job.jobId, signal);
        if (!live()) return;
        const next = serverPhase(status.state);
        if (!next) return this.finish(job, run, { phase: "failed", errorCode: "RESPONSE" });
        const workerOffline =
          next === "queued" &&
          (await getWorkerStatus(signal).catch(() => "online" as const)) === "offline";
        if (!live()) return;
        const serverProgress = status.progress ?? null;
        if (next === "succeeded") {
          if (!status.transcriptId)
            return this.finish(job, run, { phase: "failed", errorCode: "RESPONSE" });
          if (!(await current())) return;
          const server = await getTranscript(status.transcriptId, signal);
          if (!(await current())) return;
          const value: CachedTranscript = {
            items: projectServerSegments(server.segments),
            engine: server.engine,
            modelRevision: server.modelRevision,
            expiresAt: server.expiresAt,
            extractedAt: new Date().toISOString(),
          };
          await saveCachedTranscript(job.key, value, epoch).catch(() =>
            safeLog("REQUEST_FAILED"),
          );
          if (!(await current())) return;
          job.result = value;
          return this.finish(job, run, { phase: "succeeded", serverProgress, workerOffline });
        }
        if (next === "failed" || next === "cancelled") {
          this.finish(job, run, {
            phase: next,
            serverProgress,
            errorCode: next === "failed" ? status.errorCode || "FAILED" : null,
          });
          await clearActiveJob(job.jobId).catch(() => safeLog("REQUEST_FAILED"));
          return;
        }
        job.snapshot = { ...job.snapshot, phase: next, serverProgress, workerOffline };
        this.publish(job);
        await this.sleep(run, this.delay(job, next, workerOffline));
      }
    } catch (error) {
      if (!live()) return;
      const code = errorCode(error);
      this.finish(job, run, { phase: "failed", errorCode: code });
      if (code === "EXPIRED")
        await clearActiveJob(job.jobId).catch(() => safeLog("REQUEST_FAILED"));
    }
  }
}
