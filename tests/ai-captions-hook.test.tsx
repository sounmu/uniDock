// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mount } from "./ui-helpers";

const identifyMedia = vi.hoisted(() => vi.fn());
const requestCaptionMediaAccess = vi.hoisted(() => vi.fn());
const extractAudio = vi.hoisted(() => vi.fn());
const createJob = vi.hoisted(() => vi.fn());
const uploadAudio = vi.hoisted(() => vi.fn());
const getJob = vi.hoisted(() => vi.fn());
const getTranscript = vi.hoisted(() => vi.fn());
const cancelJob = vi.hoisted(() => vi.fn());
const loadActiveJob = vi.hoisted(() => vi.fn());
const saveActiveJob = vi.hoisted(() => vi.fn());
const clearActiveJob = vi.hoisted(() => vi.fn());

vi.mock("../src/captions/media-source", async (orig) => ({
  ...(await orig<object>()),
  identifyMedia,
  requestCaptionMediaAccess,
}));
vi.mock("../src/captions/referer-rule", () => ({
  withCaptionMediaRule: (_url: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../src/captions/media-fetch", () => ({
  mediaRangeReader: () => ({
    totalSize: async () => 12345,
    fetchRange: async () => new ArrayBuffer(0),
  }),
}));
vi.mock("../src/captions/audio-extract", async (orig) => ({
  ...(await orig<object>()),
  extractAudio,
}));
vi.mock("../src/captions/job-client", async (orig) => ({
  ...(await orig<object>()),
  createJob,
  uploadAudio,
  getJob,
  getTranscript,
  cancelJob,
}));
vi.mock("../src/captions/job-record", () => ({
  captionJobKey: async () => "unidock-hashedkey",
  loadActiveJob,
  saveActiveJob,
  clearActiveJob,
}));

import { useAiCaptions } from "../entrypoints/sidepanel/useAiCaptions";

let hook: ReturnType<typeof useAiCaptions>;
function Probe() {
  hook = useAiCaptions();
  return <div>{hook.state.phase}</div>;
}
let ui: Awaited<ReturnType<typeof mount>> | undefined;

const succeeded = {
  state: "succeeded",
  transcriptId: "t_1",
  expiresAt: "2027-01-01T00:00:00Z",
};
const transcript = {
  schemaVersion: 1,
  language: "ko",
  engine: "whisper",
  modelRevision: "r1",
  pipelineVersion: "p1",
  createdAt: "",
  expiresAt: "",
  segments: [{ start_ms: 0, end_ms: 1000, text: "안녕" }],
};

type Listener = (...args: unknown[]) => void;
let tabEvents: Record<"activated" | "updated" | "removed", Listener[]>;
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
  vi.stubGlobal("chrome", {
    tabs: {
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
    tabId: 7,
    windowId: 1,
  });
  extractAudio.mockResolvedValue(new Blob(["a"], { type: "audio/mp4" }));
  createJob.mockResolvedValue("job_1");
  uploadAudio.mockResolvedValue(undefined);
  cancelJob.mockResolvedValue(undefined);
  getTranscript.mockResolvedValue(transcript);
  loadActiveJob.mockResolvedValue(null);
  saveActiveJob.mockResolvedValue(undefined);
  clearActiveJob.mockResolvedValue(undefined);
});
afterEach(async () => {
  await ui?.unmount();
  ui = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function generate() {
  ui = await mount(<Probe />);
  await act(async () => {
    await hook.generate();
  });
}

it("creates the job first, then extracts, uploads, saves and shows the transcript", async () => {
  getJob
    .mockResolvedValueOnce({ state: "awaiting_upload", expiresAt: "" })
    .mockResolvedValueOnce(succeeded);
  await generate();
  expect(hook.state.phase).toBe("succeeded");
  expect(hook.state.result?.engine).toBe("whisper");
  expect(hook.state.result?.transcript.itemCount).toBe(1);
  expect(hook.state.expiresAt).toBe("2027-01-01T00:00:00Z");
  expect(createJob).toHaveBeenCalledWith(
    "unidock-hashedkey",
    expect.objectContaining({ durationHintS: 100 }),
    expect.anything(),
  );
  expect(createJob.mock.invocationCallOrder[0]).toBeLessThan(
    extractAudio.mock.invocationCallOrder[0]!,
  );
  expect(uploadAudio).toHaveBeenCalledWith("job_1", expect.any(Blob), expect.anything());
  expect(saveActiveJob).toHaveBeenCalledWith("job_1");
});

it("shows an existing accepted job for a duplicate request without re-extracting", async () => {
  getJob.mockResolvedValueOnce({ state: "running", expiresAt: "" });
  getJob.mockResolvedValueOnce(succeeded);
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    ui = await mount(<Probe />);
    const run = act(async () => {
      await hook.generate();
    });
    await vi.runAllTimersAsync();
    await run;
  } finally {
    vi.useRealTimers();
  }
  expect(extractAudio).not.toHaveBeenCalled();
  expect(uploadAudio).not.toHaveBeenCalled();
  expect(hook.state.phase).toBe("succeeded");
});

it("stops with PERMISSION when the CDN grant is refused", async () => {
  requestCaptionMediaAccess.mockResolvedValue(false);
  await generate();
  expect(hook.state.phase).toBe("failed");
  expect(hook.state.errorCode).toBe("PERMISSION");
  expect(identifyMedia).not.toHaveBeenCalled();
  expect(createJob).not.toHaveBeenCalled();
});

it("reports a failure code when identification fails", async () => {
  const { MediaSourceError } = await import("../src/captions/media-source");
  identifyMedia.mockRejectedValue(new MediaSourceError("UNSUPPORTED_MEDIA"));
  await generate();
  expect(hook.state.phase).toBe("failed");
  expect(hook.state.errorCode).toBe("UNSUPPORTED_MEDIA");
});

it("re-queries a saved accepted job when the panel opens again", async () => {
  loadActiveJob.mockResolvedValue("job_9");
  getJob.mockResolvedValueOnce(succeeded);
  ui = await mount(<Probe />);
  await act(async () => {
    await vi.waitFor(() => expect(hook.state.phase).toBe("succeeded"));
  });
  expect(getJob).toHaveBeenCalledWith("job_9", expect.anything());
  expect(createJob).not.toHaveBeenCalled();
});

async function startPendingJob() {
  getJob
    .mockResolvedValueOnce({ state: "awaiting_upload", expiresAt: "" })
    .mockReturnValue(new Promise(() => {}));
  ui = await mount(<Probe />);
  await act(async () => {
    void hook.generate();
    await vi.waitFor(() => expect(saveActiveJob).toHaveBeenCalledWith("job_1"));
  });
}

it("does not cancel or forget an accepted job when the panel closes", async () => {
  await startPendingJob();
  await ui!.unmount();
  ui = undefined;
  expect(cancelJob).not.toHaveBeenCalled();
  expect(clearActiveJob).not.toHaveBeenCalled();
});

it("cancels the server job and forgets it when the user cancels", async () => {
  await startPendingJob();
  await act(async () => hook.cancel());
  expect(cancelJob).toHaveBeenCalledWith("job_1");
  expect(clearActiveJob).toHaveBeenCalled();
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

it("cancels when the job's tab closes or another tab in its window is selected", async () => {
  await startPendingJob();
  await fire("activated", { tabId: 8, windowId: 1 });
  expect(cancelJob).toHaveBeenCalledWith("job_1");
  await ui!.unmount();
  cancelJob.mockClear();
  saveActiveJob.mockClear();
  await startPendingJob();
  await fire("removed", 7);
  expect(cancelJob).toHaveBeenCalledWith("job_1");
});

it("never cancels a job restored on reopen because of tab events", async () => {
  loadActiveJob.mockResolvedValue("job_9");
  getJob.mockReturnValue(new Promise(() => {}));
  ui = await mount(<Probe />);
  await act(async () => {
    await vi.waitFor(() => expect(getJob).toHaveBeenCalledWith("job_9", expect.anything()));
  });
  await fire("removed", 7);
  await fire("activated", { tabId: 8, windowId: 1 });
  await fire("updated", 7, { status: "loading" });
  expect(cancelJob).not.toHaveBeenCalled();
  expect(hook.state.phase).toBe("queued");
});
