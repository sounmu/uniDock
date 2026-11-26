// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount } from "./ui-helpers";
import { fakeWorker, forgetWork, type FakeWorker } from "./caption-work-helpers";

const identifyMedia = vi.hoisted(() => vi.fn());
const requestCaptionMediaAccess = vi.hoisted(() => vi.fn());
const getJob = vi.hoisted(() => vi.fn());
const getTranscript = vi.hoisted(() => vi.fn());
const cancelJob = vi.hoisted(() => vi.fn());
const getWorkerStatus = vi.hoisted(() => vi.fn());
const loadActiveJobs = vi.hoisted(() => vi.fn());
const clearActiveJob = vi.hoisted(() => vi.fn());
const hasCachedTranscripts = vi.hoisted(() => vi.fn());
const loadCachedTranscript = vi.hoisted(() => vi.fn());
const saveCachedTranscript = vi.hoisted(() => vi.fn());
const readCaptionCacheEpoch = vi.hoisted(() => vi.fn());
vi.mock("../src/captions/transcript-cache", () => ({
  CAPTION_TRANSCRIPT_CACHE_KEY: "unidock.caption-transcripts.v1",
  hasCachedTranscripts,
  loadCachedTranscript,
  saveCachedTranscript,
  readCaptionCacheEpoch,
}));
vi.mock("../src/captions/media-source", async (orig) => ({
  ...(await orig<object>()),
  identifyMedia,
  requestCaptionMediaAccess,
}));
vi.mock("../src/captions/job-client", async (orig) => ({
  ...(await orig<object>()),
  getJob,
  getTranscript,
  cancelJob,
  getWorkerStatus,
}));
vi.mock("../src/captions/job-record", async (orig) => ({
  ...(await orig<object>()),
  captionJobKey: async () => "unidock-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  loadActiveJobs,
  clearActiveJob,
}));

import { useAiCaptions } from "../entrypoints/sidepanel/useAiCaptions";
import { CAPTION_JOB_PORT, CaptionJobMonitor } from "../src/captions/job-monitor";
import type { SingleWork } from "../src/captions/work-protocol";

const KEY = "unidock-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RUN = "00000000-0000-4000-8000-000000000001";
const lecture = { documentId: "DOC1", title: "3주차 강의", durationS: 100 };
const uploading = { ...lecture, phase: "uploading", jobId: "job_1", key: KEY } as const;

let monitor: CaptionJobMonitor;
let worker: FakeWorker;
type Handler = (value?: unknown) => void;
/** A panel-to-worker port pair with Chrome's asynchronous, cloned delivery. */
function connectToMonitor() {
  const handlers = () => ({ message: [] as Handler[], disconnect: [] as Handler[] });
  const panelSide = handlers();
  const workerSide = handlers();
  let open = true;
  const deliver = (fns: Handler[], value?: unknown) =>
    void Promise.resolve().then(() => fns.forEach((fn) => fn(value)));
  const end = (own: ReturnType<typeof handlers>, peer: ReturnType<typeof handlers>) => ({
    name: CAPTION_JOB_PORT,
    onMessage: { addListener: (fn: Handler) => own.message.push(fn) },
    onDisconnect: { addListener: (fn: Handler) => own.disconnect.push(fn) },
    postMessage: (value: unknown) => {
      if (!open) throw new Error("closed");
      deliver(peer.message, structuredClone(value));
    },
    disconnect: () => {
      if (!open) return;
      open = false;
      deliver(peer.disconnect);
    },
  });
  monitor.connect(end(workerSide, panelSide) as unknown as chrome.runtime.Port);
  return end(panelSide, workerSide);
}

let hook: ReturnType<typeof useAiCaptions>;
function Probe() {
  hook = useAiCaptions();
  return <div>{hook.state.phase}</div>;
}
let ui: Awaited<ReturnType<typeof mount>> | undefined;
let generating: Promise<void> | undefined;

const job = (state: string, extra: Record<string, unknown> = {}) => ({
  id: "job_1",
  state,
  cancelRequested: false,
  ...extra,
});
const succeeded = job("succeeded", { transcriptId: "t_1" });
const transcript = {
  schemaVersion: 1,
  language: "ko",
  engine: "whisper",
  modelRevision: "r1",
  pipelineVersion: "p1",
  createdAt: "",
  expiresAt: "2027-01-01T00:00:00Z",
  durationMs: 1000,
  segments: [{ start_ms: 0, end_ms: 1000, text: "안녕" }],
};
const cachedTranscript = (text: string) => ({
  items: [{ index: 0, time: "00:00", text }],
  engine: "whisper",
  modelRevision: "r1",
  expiresAt: "2027-01-01T00:00:00Z",
  extractedAt: "2026-11-01T00:00:00Z",
});

type Listener = (...args: unknown[]) => void;
let tabEvents: Record<"activated" | "updated" | "removed", Listener[]>;
let storageListeners: Listener[];
const activeTabs = vi.fn();
function event(name: keyof typeof tabEvents) {
  return {
    addListener: (fn: Listener) => tabEvents[name].push(fn),
    removeListener: (fn: Listener) =>
      (tabEvents[name] = tabEvents[name].filter((f) => f !== fn)),
  };
}
async function fire(name: keyof typeof tabEvents, ...args: unknown[]) {
  await act(async () => tabEvents[name].forEach((fn) => fn(...args)));
}

beforeEach(() => {
  tabEvents = { activated: [], updated: [], removed: [] };
  storageListeners = [];
  monitor = new CaptionJobMonitor({ set: () => {}, clear: () => {} });
  worker = fakeWorker();
  activeTabs.mockResolvedValue([{ id: 7, windowId: 1 }]);
  vi.stubGlobal("chrome", {
    runtime: { ...worker.runtime, connect: vi.fn(() => connectToMonitor()), lastError: undefined },
    storage: { onChanged: {
      addListener: (fn: Listener) => storageListeners.push(fn),
      removeListener: (fn: Listener) => {
        storageListeners = storageListeners.filter((listener) => listener !== fn);
      },
    } },
    tabs: {
      query: activeTabs,
      onActivated: event("activated"),
      onUpdated: event("updated"),
      onRemoved: event("removed"),
    },
  });
  requestCaptionMediaAccess.mockResolvedValue(true);
  identifyMedia.mockResolvedValue({
    mediaUrl:
      "https://korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/0123456789abc/contents/media_files/screen.mp4",
    durationS: 100,
    contentId: "0123456789abc",
    title: "3주차 강의",
    tabId: 7,
    windowId: 1,
    documentId: "DOC1",
  });
  getWorkerStatus.mockResolvedValue("online");
  cancelJob.mockResolvedValue(undefined);
  getTranscript.mockResolvedValue(transcript);
  loadActiveJobs.mockResolvedValue([]);
  clearActiveJob.mockResolvedValue(undefined);
  hasCachedTranscripts.mockResolvedValue(false);
  loadCachedTranscript.mockResolvedValue(null);
  saveCachedTranscript.mockResolvedValue(undefined);
  readCaptionCacheEpoch.mockResolvedValue(null);
});
afterEach(async () => {
  await ui?.unmount();
  ui = undefined;
  generating = undefined;
  await forgetWork();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.useRealTimers();
});

/** Presses Generate; resolves with the start once the worker has it. */
async function press() {
  const started = worker.next("CAPTION_WORK_START");
  await act(async () => {
    generating = hook.generate();
    await started;
  });
  return started;
}
async function start() {
  ui = await mount(<Probe />);
  return press();
}
/** What the offscreen document reports of the run, through the worker. */
const prepared = (patch: Partial<SingleWork>) =>
  worker.report({ single: { ...worker.single!, ...patch } });
/** The server has the audio: the document handed the job to the worker. */
const accepted = () => prepared({ ...uploading, phase: "queued" });
const finished = () =>
  act(async () => {
    await generating;
  });
/** A run the document holds before this panel page exists. */
const inFlight = (patch: Partial<SingleWork> = {}): SingleWork => ({
  run: RUN,
  tabId: 7,
  errorCode: null,
  ...uploading,
  ...patch,
});
async function startPendingJob() {
  getJob.mockReturnValue(new Promise(() => {}));
  await start();
  await accepted();
  expect(getJob).toHaveBeenCalledWith("job_1", expect.anything());
}

it("starts the run for the active tab and shows every step the worker reports, then the transcript", async () => {
  getJob.mockResolvedValueOnce(succeeded);
  const command = await start();
  expect(command).toEqual({
    version: 1,
    type: "CAPTION_WORK_START",
    kind: "single",
    run: expect.stringMatching(/^[0-9a-f-]{36}$/),
    tabId: 7,
  });
  expect(hook.state.phase).toBe("identifying");

  await prepared({ ...uploading, phase: "extracting" });
  expect(hook.state).toMatchObject({ phase: "extracting", title: "3주차 강의", durationS: 100 });
  expect(hook.player).toEqual({ tabId: 7, documentId: "DOC1" });
  await prepared({ phase: "uploading" });
  expect(hook.state.phase).toBe("uploading");

  await accepted();
  await finished();
  expect(hook.state.phase).toBe("succeeded");
  expect(hook.state.result?.engine).toBe("whisper");
  expect(hook.state.result?.transcript.itemCount).toBe(1);
  expect(hook.state.result?.transcript.pageTitle).toBe("3주차 강의");
  expect(hook.state.expiresAt).toBe("2027-01-01T00:00:00Z");
  expect(getJob).toHaveBeenCalledWith("job_1", expect.anything());
  // The panel reads no media itself and stops nothing on its way.
  expect(identifyMedia).not.toHaveBeenCalled();
  expect(worker.sent("CAPTION_WORK_CANCEL")).toEqual([]);
});

it("asks for media access in the click itself and stops with PERMISSION when it is refused", async () => {
  requestCaptionMediaAccess.mockResolvedValue(false);
  ui = await mount(<Probe />);
  let askedInClick = false;
  await act(async () => {
    const run = hook.generate();
    askedInClick = requestCaptionMediaAccess.mock.calls.length === 1;
    await run;
  });
  expect(askedInClick).toBe(true);
  expect(hook.state).toMatchObject({ phase: "failed", errorCode: "PERMISSION" });
  expect(activeTabs).not.toHaveBeenCalled();
  expect(worker.sent("CAPTION_WORK_START")).toEqual([]);
});

it("starts nothing without an active tab", async () => {
  activeTabs.mockResolvedValue([]);
  ui = await mount(<Probe />);
  await act(async () => {
    await hook.generate();
  });
  expect(hook.state).toMatchObject({ phase: "failed", errorCode: "ACTIVATE_TAB" });
  expect(worker.sent("CAPTION_WORK_START")).toEqual([]);
});

it("shows the worker's refusal when another lecture's audio is still being read", async () => {
  worker.answer = (command) =>
    command.type === "CAPTION_WORK_START"
      ? { status: "error", code: "ACTIVE_JOB_EXISTS" }
      : undefined;
  await start();
  await finished();
  expect(hook.state).toMatchObject({ phase: "failed", errorCode: "ACTIVE_JOB_EXISTS" });
});

it.each(["UNSUPPORTED_MEDIA", "QUOTA_EXCEEDED", "MEDIA_NETWORK"])(
  "shows the %s a run failed with and leaves its job to the document",
  async (code) => {
    await start();
    await prepared({ phase: "failed", errorCode: code });
    await finished();
    expect(hook.state).toMatchObject({ phase: "failed", errorCode: code });
    expect(cancelJob).not.toHaveBeenCalled();
    expect(clearActiveJob).not.toHaveBeenCalled();
  },
);

it("cancelling while audio is read or uploaded tells the worker and cancels no job itself", async () => {
  const { run } = await start();
  await prepared(uploading);
  await act(async () => hook.cancel());
  expect(worker.sent("CAPTION_WORK_CANCEL")).toEqual([
    { version: 1, type: "CAPTION_WORK_CANCEL", kind: "single", run },
  ]);
  expect(hook.state.phase).toBe("idle");
  expect(hook.player).toBeNull();
  expect(cancelJob).not.toHaveBeenCalled();
  expect(clearActiveJob).not.toHaveBeenCalled();
});

it("cancels the job itself when the document handed it over just before the cancel arrived", async () => {
  await start();
  await prepared(uploading);
  // The worker already follows the job; this panel page has not heard of it.
  worker.single = { ...worker.single!, phase: "queued" };
  await act(async () => hook.cancel());
  expect(cancelJob).toHaveBeenCalledExactlyOnceWith("job_1");
  expect(clearActiveJob).toHaveBeenCalledExactlyOnceWith("job_1");
  expect(hook.state.phase).toBe("idle");
});

it("closing the panel while audio is uploaded stops nothing", async () => {
  await start();
  await prepared(uploading);
  await ui!.unmount();
  ui = undefined;
  expect(worker.sent("CAPTION_WORK_CANCEL")).toEqual([]);
  expect(worker.single?.phase).toBe("uploading");
  expect(cancelJob).not.toHaveBeenCalled();
  expect(clearActiveJob).not.toHaveBeenCalled();
});

it.each(["navigates", "closes"])("stops the run when its lecture tab %s during the upload", async (change) => {
  const { run } = await start();
  await prepared(uploading);
  if (change === "closes") await fire("removed", 7);
  else await fire("updated", 7, { url: "https://kucom.korea.ac.kr/other" });
  expect(worker.sent("CAPTION_WORK_CANCEL")).toEqual([
    { version: 1, type: "CAPTION_WORK_CANCEL", kind: "single", run },
  ]);
  expect(hook.state.phase).toBe("idle");
});

it("goes back to the start when the run was stopped elsewhere, without cancelling anything", async () => {
  await start();
  await prepared(uploading);
  await worker.report({ single: null });
  await finished();
  expect(hook.state.phase).toBe("idle");
  expect(worker.sent("CAPTION_WORK_CANCEL")).toEqual([]);
  expect(cancelJob).not.toHaveBeenCalled();
});

it("a reopened panel shows the upload that went on without it, and can cancel it", async () => {
  worker.single = inFlight();
  ui = await mount(<Probe />);
  expect(hook.state).toMatchObject({ phase: "uploading", title: "3주차 강의", durationS: 100 });
  expect(hook.player).toEqual({ tabId: 7, documentId: "DOC1" });
  expect(requestCaptionMediaAccess).not.toHaveBeenCalled();
  expect(worker.sent("CAPTION_WORK_START")).toEqual([]);

  await act(async () => hook.cancel());
  expect(worker.sent("CAPTION_WORK_CANCEL")).toEqual([
    { version: 1, type: "CAPTION_WORK_CANCEL", kind: "single", run: RUN },
  ]);
  expect(hook.state.phase).toBe("idle");
  expect(cancelJob).not.toHaveBeenCalled();
});

it("a reopened panel follows the job once the run it found has uploaded", async () => {
  getJob.mockResolvedValueOnce(succeeded);
  // The document has not found the lecture's player yet.
  worker.single = inFlight({
    phase: "identifying",
    documentId: null,
    jobId: null,
    key: null,
    title: "",
    durationS: 0,
  });
  ui = await mount(<Probe />);
  expect(hook.state.phase).toBe("identifying");
  await accepted();
  expect(hook.state.phase).toBe("succeeded");
  expect(hook.state.result?.transcript.pageTitle).toBe("3주차 강의");
  expect(getJob).toHaveBeenCalledWith("job_1", expect.anything());
});

it.each([{ tabId: 8 }, { documentId: "OTHER" }])(
  "does not show another lecture's run on this lecture (%o)",
  async (other) => {
    worker.single = inFlight(other);
    ui = await mount(<Probe />);
    expect(identifyMedia).toHaveBeenCalled();
    expect(hook.state.phase).toBe("idle");
    expect(worker.sent("CAPTION_WORK_CANCEL")).toEqual([]);
  },
);

it("a reopened panel shows a run that failed while it was closed, and forgets it on dismiss", async () => {
  worker.single = inFlight({ phase: "failed", errorCode: "MEDIA_DENIED" });
  ui = await mount(<Probe />);
  expect(hook.state).toMatchObject({ phase: "failed", errorCode: "MEDIA_DENIED" });
  await act(async () => hook.cancel());
  expect(worker.single).toBeNull();
  expect(hook.state.phase).toBe("idle");
  expect(cancelJob).not.toHaveBeenCalled();
});

it.each(["queued", "running"] as const)(
  "shows a completed %s job within two seconds while the panel is visible",
  async (state) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    getJob.mockResolvedValueOnce(job(state)).mockResolvedValueOnce(succeeded);
    try {
      await start();
      await accepted();
      expect(hook.state.phase).toBe(state);
      expect(getJob).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(2000));
      expect(hook.state.phase).toBe("succeeded");
      expect(getJob).toHaveBeenCalledTimes(2);
    } finally {
      await ui?.unmount();
      ui = undefined;
      vi.clearAllTimers();
      visibility.mockRestore();
    }
  },
);

it("keeps background polling slow and refreshes immediately when revealed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  getJob.mockResolvedValueOnce(job("queued")).mockResolvedValueOnce(succeeded);
  try {
    await start();
    await accepted();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(getJob).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(hook.state.phase).toBe("succeeded");
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await ui?.unmount();
    ui = undefined;
    vi.clearAllTimers();
    visibility.mockRestore();
  }
});

it("clears a pending status wait immediately on cancellation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  getJob.mockResolvedValueOnce(job("running"));
  try {
    await start();
    await accepted();
    expect(getJob).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => hook.cancel());
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(getJob).toHaveBeenCalledTimes(1);
  } finally {
    await ui?.unmount();
    ui = undefined;
    vi.clearAllTimers();
  }
});

it("re-queries a saved accepted job when the panel opens again", async () => {
  loadActiveJobs.mockResolvedValue([{ jobId: "job_9", key: KEY }]);
  getJob.mockResolvedValueOnce(succeeded);
  ui = await mount(<Probe />);
  expect(hook.state.phase).toBe("succeeded");
  expect(getJob).toHaveBeenCalledWith("job_9", expect.anything());
  expect(worker.sent("CAPTION_WORK_START")).toEqual([]);
});

it("opens cached captions without starting a run or contacting the caption server", async () => {
  hasCachedTranscripts.mockResolvedValue(true);
  loadCachedTranscript.mockResolvedValue(cachedTranscript("저장된 문장"));
  ui = await mount(<Probe />);
  expect(hook.state.phase).toBe("succeeded");
  expect(hook.state.restoredFromCache).toBe(true);
  expect(hook.state.result?.transcript.items[0]?.text).toBe("저장된 문장");
  expect(worker.sent("CAPTION_WORK_START")).toEqual([]);
  expect(getJob).not.toHaveBeenCalled();
  expect(getTranscript).not.toHaveBeenCalled();
  expect(requestCaptionMediaAccess).not.toHaveBeenCalled();
  await act(async () => storageListeners.forEach((fn) =>
    fn({ "unidock.caption-transcripts.v1": { oldValue: {} } }, "local")));
  expect(hook.state.phase).toBe("idle");
});

it("does not replace a newer action with a late cache read", async () => {
  hasCachedTranscripts.mockResolvedValue(true);
  const pending = Promise.withResolvers<ReturnType<typeof cachedTranscript>>();
  loadCachedTranscript.mockReturnValue(pending.promise);
  ui = await mount(<Probe />);
  expect(loadCachedTranscript).toHaveBeenCalled();
  await act(async () => {
    hook.cancel();
    pending.resolve(cachedTranscript("늦게 도착한 자막"));
  });
  expect(hook.state.phase).toBe("idle");
  expect(getJob).not.toHaveBeenCalled();
});

it.each([true, false])("discards the first transcript after deletion (storage event: %s)", async (deliverEvent) => {
  const response = Promise.withResolvers<typeof transcript>();
  getJob.mockResolvedValueOnce(succeeded);
  getTranscript.mockReturnValueOnce(response.promise);
  await start();
  await accepted();
  expect(getTranscript).toHaveBeenCalled();
  readCaptionCacheEpoch.mockResolvedValue("after-deletion");
  await act(async () => {
    if (deliverEvent) storageListeners.forEach((fn) =>
      fn({ "unidock.caption-session-epoch.v1": { newValue: "after-deletion" } }, "session"));
    response.resolve(transcript);
  });
  expect(hook.state.phase).toBe("idle");
  expect(hook.state.result).toBeNull();
  expect(saveCachedTranscript).not.toHaveBeenCalled();
});

it.each(["navigation", "reload", "close"])("discards a pending cached transcript on source %s", async (change) => {
  const pending = Promise.withResolvers<ReturnType<typeof cachedTranscript>>();
  hasCachedTranscripts.mockResolvedValue(true);
  loadCachedTranscript.mockReturnValueOnce(pending.promise);
  ui = await mount(<Probe />);
  expect(loadCachedTranscript).toHaveBeenCalled();
  if (change === "close") await fire("removed", 7);
  else await fire("updated", 7, change === "reload"
    ? { status: "loading" } : { url: "https://kucom.korea.ac.kr/em/lecture-b" });
  await act(async () => pending.resolve(cachedTranscript("이전 강의 자막")));
  expect(hook.state.phase).toBe("idle");
  expect(hook.state.result).toBeNull();
});

it("does not cancel or forget an accepted job when the panel closes", async () => {
  await startPendingJob();
  await ui!.unmount();
  ui = undefined;
  expect(cancelJob).not.toHaveBeenCalled();
  expect(clearActiveJob).not.toHaveBeenCalled();
  expect(worker.sent("CAPTION_WORK_CANCEL")).toEqual([]);
});

it("cancels the server job once and forgets it when the user cancels", async () => {
  await startPendingJob();
  await act(async () => hook.cancel());
  expect(cancelJob).toHaveBeenCalledExactlyOnceWith("job_1");
  expect(clearActiveJob).toHaveBeenCalledExactlyOnceWith("job_1");
  expect(hook.state.phase).toBe("idle");
});

it("ignores loading, closing and activation of unrelated tabs and windows", async () => {
  await startPendingJob();
  await fire("updated", 999, { status: "loading" });
  await fire("removed", 999);
  await fire("activated", { tabId: 999, windowId: 2 });
  expect(cancelJob).not.toHaveBeenCalled();
  expect(clearActiveJob).not.toHaveBeenCalled();
  expect(hook.state.phase).not.toBe("idle");
});

it("cancels when the job's own tab navigates", async () => {
  await startPendingJob();
  await fire("updated", 7, { url: "https://kucom.korea.ac.kr/other" });
  expect(cancelJob).toHaveBeenCalledWith("job_1");
  expect(hook.state.phase).toBe("idle");
});

it("keeps processing progress and receives the result after switching tabs", async () => {
  const completed = Promise.withResolvers<ReturnType<typeof job>>();
  getJob
    .mockResolvedValueOnce(job("running", { progress: { done: 60, total: 100 } }))
    .mockReturnValueOnce(completed.promise);
  vi.useFakeTimers();
  await start();
  await accepted();
  const progress = hook.state;
  expect(progress.phase).toBe("running");
  await fire("activated", { tabId: 8, windowId: 1 });
  await fire("activated", { tabId: 7, windowId: 1 });
  expect(hook.state).toBe(progress);
  expect(cancelJob).not.toHaveBeenCalled();
  expect(clearActiveJob).not.toHaveBeenCalled();
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
    completed.resolve(succeeded);
  });
  expect(hook.state.phase).toBe("succeeded");
  expect(worker.sent("CAPTION_WORK_START")).toHaveLength(1);
});

it("cancels when the job's tab closes", async () => {
  await startPendingJob();
  await fire("removed", 7);
  expect(cancelJob).toHaveBeenCalledWith("job_1");
});

it("cancels a restored job when its source tab closes", async () => {
  loadActiveJobs.mockResolvedValue([{ jobId: "job_9", key: KEY }]);
  getJob.mockReturnValue(new Promise(() => {}));
  ui = await mount(<Probe />);
  expect(getJob).toHaveBeenCalledWith("job_9", expect.anything());
  await fire("removed", 7);
  await fire("activated", { tabId: 8, windowId: 1 });
  await fire("updated", 7, { status: "loading" });
  expect(cancelJob).toHaveBeenCalledWith("job_9");
  expect(hook.state.phase).toBe("idle");
});

it("drops a saved job that loads after a newer Generate started", async () => {
  let resolveSaved!: (saved: { jobId: string; key: string }[]) => void;
  loadActiveJobs.mockReturnValue(new Promise((resolve) => (resolveSaved = resolve)));
  let grant!: (granted: boolean) => void;
  requestCaptionMediaAccess.mockReturnValue(new Promise((resolve) => (grant = resolve)));
  getJob.mockReturnValue(new Promise(() => {}));
  ui = await mount(<Probe />);
  await act(async () => {
    generating = hook.generate();
  });
  expect(hook.state.phase).toBe("identifying");
  await act(async () => resolveSaved([{ jobId: "job_old", key: KEY }]));
  const started = worker.next("CAPTION_WORK_START");
  await act(async () => {
    grant(true);
    await started;
  });
  await accepted();
  expect(getJob).toHaveBeenCalledWith("job_1", expect.anything());
  expect(getJob).not.toHaveBeenCalledWith("job_old", expect.anything());
  expect(hook.state.phase).toBe("queued");
});

it("does not show a saved job on a different lecture", async () => {
  loadActiveJobs.mockResolvedValue([{
    jobId: "job_other",
    key: "unidock-ffffffffffffffffffffffffffffffffffffffff",
  }]);
  ui = await mount(<Probe />);
  expect(identifyMedia).toHaveBeenCalled();
  expect(getJob).not.toHaveBeenCalled();
  expect(hook.state.phase).toBe("idle");
});

it("tells the panel when a queued job waits for an offline worker", async () => {
  let answer!: (status: "offline") => void;
  getWorkerStatus.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  getJob.mockResolvedValueOnce(job("queued"));
  await start();
  await accepted();
  expect(getWorkerStatus).toHaveBeenCalled();
  await act(async () => answer("offline"));
  expect(hook.state.phase).toBe("queued");
  expect(hook.state.workerOffline).toBe(true);
});

it("does not restore when the current tab is not a KU player", async () => {
  const { MediaSourceError } = await import("../src/captions/media-source");
  identifyMedia.mockRejectedValue(new MediaSourceError("ACTIVATE_TAB"));
  loadActiveJobs.mockResolvedValue([{ jobId: "job_9", key: KEY }]);
  ui = await mount(<Probe />);
  expect(identifyMedia).toHaveBeenCalled();
  expect(getJob).not.toHaveBeenCalled();
  expect(hook.state.phase).toBe("idle");
});
