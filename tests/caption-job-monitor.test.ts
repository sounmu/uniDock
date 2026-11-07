import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";

const getJob = vi.hoisted(() => vi.fn());
const getTranscript = vi.hoisted(() => vi.fn());
const getWorkerStatus = vi.hoisted(() => vi.fn());
const loadActiveJobs = vi.hoisted(() => vi.fn());
const clearActiveJob = vi.hoisted(() => vi.fn());
const loadCachedTranscript = vi.hoisted(() => vi.fn());
const saveCachedTranscript = vi.hoisted(() => vi.fn());
const readCaptionCacheEpoch = vi.hoisted(() => vi.fn());
vi.mock("../src/captions/job-client", () => ({ getJob, getTranscript, getWorkerStatus }));
vi.mock("../src/captions/job-record", async (orig) => ({
  ...(await orig<object>()),
  loadActiveJobs,
  clearActiveJob,
}));
vi.mock("../src/captions/transcript-cache", () => ({
  loadCachedTranscript,
  saveCachedTranscript,
  readCaptionCacheEpoch,
}));

import {
  CAPTION_POLL_MS,
  CaptionJobMonitor,
  captionJobRequest,
  type CaptionJobUpdate,
} from "../src/captions/job-monitor";

const KEY = `unidock-${"a".repeat(40)}`;
const job = (state: string, extra: Record<string, unknown> = {}) => ({
  id: "job_1",
  state,
  cancelRequested: false,
  ...extra,
});
const transcript = {
  engine: "whisper",
  modelRevision: "r1",
  expiresAt: "2027-01-01T00:00:00Z",
  segments: [{ start_ms: 0, end_ms: 1000, text: "안녕" }],
};

function panelPort() {
  const received: CaptionJobUpdate[] = [];
  let onMessage: (message: unknown) => void = () => {};
  const port = {
    onMessage: { addListener: (fn: typeof onMessage) => (onMessage = fn) },
    onDisconnect: { addListener: () => {} },
    postMessage: (update: CaptionJobUpdate) => received.push(update),
  };
  return { port: port as unknown as chrome.runtime.Port, received, send: (m: unknown) => onMessage(m) };
}

let alarm: { set: Mock<() => void>; clear: Mock<() => void> };
let monitor: CaptionJobMonitor;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("chrome", { runtime: { lastError: undefined } });
  alarm = { set: vi.fn<() => void>(), clear: vi.fn<() => void>() };
  monitor = new CaptionJobMonitor(alarm);
  getWorkerStatus.mockResolvedValue("online");
  getTranscript.mockResolvedValue(transcript);
  clearActiveJob.mockResolvedValue(undefined);
  loadCachedTranscript.mockResolvedValue(null);
  saveCachedTranscript.mockResolvedValue(undefined);
  readCaptionCacheEpoch.mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("pushes only changed snapshots and the transcript once per port", async () => {
  const progress = { stage: "transcribing", done: 1, total: 4 };
  getJob
    .mockResolvedValueOnce(job("running", { progress }))
    .mockResolvedValueOnce(job("running", { progress }))
    .mockResolvedValueOnce(job("succeeded", { transcriptId: "t_1" }));
  const first = panelPort();
  monitor.connect(first.port);
  first.send({ type: "track", jobId: "job_1", key: KEY });
  await vi.advanceTimersByTimeAsync(CAPTION_POLL_MS.running * 2);
  expect(getJob).toHaveBeenCalledTimes(3);
  expect(first.received.map((u) => u.snapshot?.phase)).toEqual(["queued", "running", "succeeded"]);
  expect(first.received[2]?.result?.items[0]?.text).toBe("안녕");
  expect(saveCachedTranscript).toHaveBeenCalledWith(KEY, expect.objectContaining({ engine: "whisper" }), null);
  const second = panelPort();
  monitor.connect(second.port);
  second.send({ type: "track", jobId: "job_1", key: KEY });
  expect(second.received.at(-1)?.result?.items).toHaveLength(1);
  expect(first.received).toHaveLength(3);
  expect(getJob).toHaveBeenCalledTimes(3);
  expect(alarm.clear).toHaveBeenCalled();
});

it("polls slower with no panel open and wakes at once for a visible panel", async () => {
  getJob.mockResolvedValue(job("running"));
  monitor.track("job_1", KEY);
  await vi.advanceTimersByTimeAsync(0);
  expect(alarm.set).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(CAPTION_POLL_MS.unwatchedRunning - 1);
  expect(getJob).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(getJob).toHaveBeenCalledTimes(2);
  const panel = panelPort();
  monitor.connect(panel.port);
  panel.send({ type: "visible", visible: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(getJob).toHaveBeenCalledTimes(2);
  panel.send({ type: "track", jobId: "job_1", key: KEY });
  await vi.advanceTimersByTimeAsync(0);
  expect(getJob).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(CAPTION_POLL_MS.visible);
  expect(getJob).toHaveBeenCalledTimes(4);
});

it("forgets a failed job and stops its alarm", async () => {
  getJob.mockResolvedValueOnce(job("failed", { errorCode: "AUDIO_INVALID" }));
  const panel = panelPort();
  monitor.connect(panel.port);
  panel.send({ type: "track", jobId: "job_1", key: KEY });
  await vi.advanceTimersByTimeAsync(0);
  expect(panel.received.at(-1)?.snapshot).toMatchObject({ phase: "failed", errorCode: "AUDIO_INVALID" });
  expect(clearActiveJob).toHaveBeenCalledWith("job_1");
  expect(alarm.clear).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps following a job through a transient network error", async () => {
  getJob
    .mockResolvedValueOnce(job("running"))
    .mockRejectedValueOnce(Object.assign(new Error("offline"), { code: "NETWORK" }))
    .mockResolvedValueOnce(job("succeeded", { transcriptId: "t_1" }));
  monitor.track("job_1", KEY);
  await vi.advanceTimersByTimeAsync(CAPTION_POLL_MS.unwatchedRunning);
  expect(getJob).toHaveBeenCalledTimes(2);
  expect(alarm.clear).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(CAPTION_POLL_MS.unwatchedRunning);
  expect(getJob).toHaveBeenCalledTimes(3);
  expect(saveCachedTranscript).toHaveBeenCalledOnce();
  expect(clearActiveJob).not.toHaveBeenCalled();
  expect(alarm.clear).toHaveBeenCalled();
});

it("resumes a saved unfinished job but not one whose transcript is cached", async () => {
  loadActiveJobs.mockResolvedValue([{ jobId: "job_1", key: KEY }]);
  loadCachedTranscript.mockResolvedValueOnce({ items: [] });
  await monitor.resume();
  expect(getJob).not.toHaveBeenCalled();
  expect(alarm.clear).toHaveBeenCalled();
  getJob.mockReturnValue(new Promise(() => {}));
  await monitor.resume();
  await vi.advanceTimersByTimeAsync(0);
  expect(getJob).toHaveBeenCalledWith("job_1", expect.any(AbortSignal));
});

it("drops the followed job when local data deletion removes its record", async () => {
  getJob.mockResolvedValue(job("queued"));
  const panel = panelPort();
  monitor.connect(panel.port);
  panel.send({ type: "track", jobId: "job_1", key: KEY });
  await vi.advanceTimersByTimeAsync(0);
  monitor.storageChanged(
    { "unidock.caption-active-job.v1": { oldValue: [{ jobId: "job_1", key: KEY }] } },
    "local",
  );
  expect(panel.received.at(-1)).toEqual({ type: "snapshot", jobId: "job_1", snapshot: null });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(CAPTION_POLL_MS.unwatchedQueued);
  expect(getJob).toHaveBeenCalledTimes(1);
});

it("follows several jobs at once and sends each panel only its own job", async () => {
  const OTHER = `unidock-${"b".repeat(40)}`;
  const statuses: Record<string, string[]> = {
    job_1: ["running", "succeeded"],
    job_2: ["queued", "queued", "failed"],
  };
  getJob.mockImplementation(async (id: string) => {
    const state = statuses[id]!.shift() ?? "running";
    return { ...job(state, state === "succeeded" ? { transcriptId: "t_1" } : {}), id };
  });
  const first = panelPort();
  const second = panelPort();
  monitor.connect(first.port);
  monitor.connect(second.port);
  first.send({ type: "track", jobId: "job_1", key: KEY });
  second.send({ type: "track", jobId: "job_2", key: OTHER });
  await vi.advanceTimersByTimeAsync(CAPTION_POLL_MS.queued * 2);
  expect(first.received.every((u) => u.jobId === "job_1")).toBe(true);
  expect(second.received.every((u) => u.jobId === "job_2")).toBe(true);
  expect(first.received.at(-1)?.snapshot?.phase).toBe("succeeded");
  expect(second.received.at(-1)?.snapshot?.phase).toBe("failed");
  expect(clearActiveJob).toHaveBeenCalledWith("job_2");
  expect(alarm.clear).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("drops only the job whose record disappeared", async () => {
  const OTHER = `unidock-${"b".repeat(40)}`;
  getJob.mockImplementation(async (id: string) => ({ ...job("queued"), id }));
  const panel = panelPort();
  monitor.connect(panel.port);
  panel.send({ type: "track", jobId: "job_1", key: KEY });
  panel.send({ type: "track", jobId: "job_2", key: OTHER });
  await vi.advanceTimersByTimeAsync(0);
  monitor.storageChanged(
    { "unidock.caption-active-job.v1": { newValue: [{ jobId: "job_2", key: OTHER }] } },
    "local",
  );
  expect(panel.received.at(-1)).toEqual({ type: "snapshot", jobId: "job_1", snapshot: null });
  getJob.mockClear();
  await vi.advanceTimersByTimeAsync(CAPTION_POLL_MS.queued);
  expect(getJob.mock.calls.map((call) => call[0])).toEqual(["job_2"]);
});

it("accepts only exact request shapes", () => {
  expect(captionJobRequest({ type: "track", jobId: "job_1", key: KEY })).not.toBeNull();
  expect(captionJobRequest({ type: "track", jobId: "job_1", key: "unidock-short" })).toBeNull();
  expect(captionJobRequest({ type: "track", jobId: "job_1", key: KEY, url: "x" })).toBeNull();
  expect(captionJobRequest({ type: "untrack", jobId: "../job" })).toBeNull();
  expect(captionJobRequest({ type: "visible", visible: "yes" })).toBeNull();
});
