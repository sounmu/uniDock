// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { mount } from "./ui-helpers";
import { LECTURE_TAB_KEY } from "../src/open-tab";
import { CAPTION_SESSION_EPOCH_KEY } from "../src/caption-server-settings";
import type { useCaptionQueue } from "../entrypoints/sidepanel/useCaptionQueue";

const queryActive = vi.hoisted(() => vi.fn());
const identifyMedia = vi.hoisted(() => vi.fn());
const submitLecture = vi.hoisted(() => vi.fn());
const cancelJob = vi.hoisted(() => vi.fn());
vi.mock("../src/transport", () => ({ queryActive }));
vi.mock("../src/captions/media-source", async (original) => ({
  ...(await original<object>()),
  identifyMedia,
  requestCaptionMediaAccess: () => Promise.resolve(true),
}));
vi.mock("../src/captions/submit-lecture", async (original) => ({
  ...(await original<object>()),
  submitLecture,
}));
vi.mock("../src/captions/job-client", async (original) => ({
  ...(await original<object>()),
  cancelJob,
}));

type Queue = ReturnType<typeof useCaptionQueue>;
type Hooks = {
  signal: AbortSignal;
  onJob: (jobId: string) => void;
  onPhase: (phase: string) => void;
};
type StorageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
const target = { id: 3, url: "https://mylms.korea.ac.kr/courses/1/modules", documentToken: "token" };
const media = (documentId: string) => ({
  mediaUrl: "https://cdn.example/video.mp4",
  durationS: 60,
  contentId: documentId,
  title: documentId,
  tabId: 9,
  windowId: 1,
  documentId,
});
const noPlayer = () => Promise.reject(new Error("no player"));
const batch = "00000000-0000-4000-8000-0000000000b1";
const admitted = async (request: { type: string }) =>
  request.type === "CAPTION_BATCH_ADMIT"
    ? { status: "success", batch }
    : { status: "success", opened: true };
const opens = () =>
  queryActive.mock.calls.filter(([request]) => request.type === "CAPTION_BATCH_OPEN");
let posted: unknown[];
let receive: ((message: unknown) => void) | undefined;
let storageChanged: StorageListener | undefined;
let queue: Queue;
let ui: Awaited<ReturnType<typeof mount>>;

beforeEach(() => {
  posted = [];
  receive = undefined;
  storageChanged = undefined;
  vi.stubGlobal("chrome", {
    storage: {
      session: { get: vi.fn(async () => ({ [LECTURE_TAB_KEY]: 9 })) },
      onChanged: {
        addListener: (listener: StorageListener) => (storageChanged = listener),
        removeListener: vi.fn(),
      },
    },
    runtime: {
      connect: () => ({
        postMessage: (message: unknown) => posted.push(message),
        onMessage: { addListener: (listener: typeof receive) => (receive = listener) },
        onDisconnect: { addListener: vi.fn() },
        disconnect: vi.fn(),
      }),
    },
  });
  queryActive.mockImplementation(admitted);
  cancelJob.mockResolvedValue(undefined);
  submitLecture.mockImplementation(async (found: { documentId: string }) => ({
    jobId: `job-${found.documentId}`,
    key: `key-${found.documentId}`,
  }));
});
afterEach(async () => {
  await ui?.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function render() {
  const { useCaptionQueue } = await import("../entrypoints/sidepanel/useCaptionQueue");
  function Harness() {
    queue = useCaptionQueue();
    return null;
  }
  ui = await mount(<StrictMode><Harness /></StrictMode>);
}

function hangingSubmission(awaitingUpload: boolean) {
  submitLecture.mockImplementationOnce((_found: unknown, hooks: Hooks) => {
    hooks.onJob("job-open");
    if (awaitingUpload) hooks.onPhase("extracting");
    return new Promise((_resolve, reject) =>
      hooks.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  });
}

const phases = () => queue.items.map((item) => item.phase);

it("opens each lecture in the lecture tab and waits for its own player", async () => {
  vi.useFakeTimers();
  // The tab still shows a lecture from an earlier run until the first open
  // commits, then each later open briefly still shows the lecture before it.
  for (const shown of ["old", "old", "first", "first", "first", "second"])
    identifyMedia.mockResolvedValueOnce(media(shown));
  await render();
  await act(async () => {
    const run = queue.start({ handles: ["a", "b"], target }, (handle) => `강의 ${handle}`);
    await vi.advanceTimersByTimeAsync(4_000);
    await run;
  });
  expect(queryActive.mock.calls.map(([request]) => request)).toEqual([
    { version: 1, type: "CAPTION_BATCH_ADMIT", handles: ["a", "b"] },
    { version: 1, type: "CAPTION_BATCH_OPEN", batch, index: 0 },
    { version: 1, type: "CAPTION_BATCH_OPEN", batch, index: 1 },
  ]);
  expect(identifyMedia).toHaveBeenCalledWith(9);
  expect(submitLecture.mock.calls.map(([found]) => found.documentId)).toEqual(["first", "second"]);
  expect(phases()).toEqual(["queued", "queued"]);
  expect(posted).toContainEqual({ type: "track", jobId: "job-second", key: "key-second" });
});

it("skips a lecture that cannot be opened and goes on", async () => {
  queryActive
    .mockImplementationOnce(admitted)
    .mockResolvedValueOnce({ status: "error", code: "TAB_OPEN_FAILED" });
  identifyMedia.mockImplementationOnce(noPlayer).mockImplementationOnce(noPlayer);
  identifyMedia.mockResolvedValue(media("second"));
  await render();
  await act(() => queue.start({ handles: ["a", "b"], target }, String));
  expect(queue.items[0]).toMatchObject({ phase: "failed", errorCode: "TAB_OPEN_FAILED" });
  expect(queue.items[1]?.phase).toBe("queued");
});

it("fails every lecture when the selection cannot be admitted", async () => {
  queryActive.mockResolvedValueOnce({ status: "error", code: "STALE_SELECTION" });
  await render();
  await act(() => queue.start({ handles: ["a", "b"], target }, String));
  expect(queue.items.map((item) => item.errorCode)).toEqual(["STALE_SELECTION", "STALE_SELECTION"]);
  expect(opens()).toHaveLength(0);
  expect(submitLecture).not.toHaveBeenCalled();
});

it("stops opening once the list tab has lost the admitted lectures", async () => {
  queryActive
    .mockImplementationOnce(admitted)
    .mockResolvedValueOnce({ status: "error", code: "RELOAD_TAB" });
  await render();
  await act(() => queue.start({ handles: ["a", "b", "c"], target }, String));
  expect(queue.items.map((item) => item.errorCode)).toEqual(["RELOAD_TAB", "RELOAD_TAB", "RELOAD_TAB"]);
  expect(opens()).toHaveLength(1);
});

it("stops the whole queue once today's quota runs out", async () => {
  identifyMedia.mockImplementationOnce(noPlayer).mockResolvedValue(media("first"));
  submitLecture.mockRejectedValueOnce(Object.assign(new Error("quota"), { code: "QUOTA_EXCEEDED" }));
  await render();
  await act(() => queue.start({ handles: ["a", "b", "c"], target }, String));
  expect(opens()).toHaveLength(1);
  expect(queue.items.map((item) => item.errorCode)).toEqual([
    "QUOTA_EXCEEDED",
    "QUOTA_EXCEEDED",
    "QUOTA_EXCEEDED",
  ]);
  expect(queue.running).toBe(false);
});

it("shows the server's progress and stops following a finished job", async () => {
  identifyMedia.mockImplementationOnce(noPlayer).mockResolvedValue(media("first"));
  await render();
  await act(() => queue.start({ handles: ["a"], target }, String));
  const snapshot = (phase: string) => ({
    type: "snapshot",
    jobId: "job-first",
    snapshot: { jobId: "job-first", key: "key-first", phase, serverProgress: null, workerOffline: false, errorCode: null },
  });
  await act(async () => receive?.(snapshot("running")));
  expect(phases()).toEqual(["running"]);
  await act(async () => receive?.(snapshot("succeeded")));
  expect(phases()).toEqual(["succeeded"]);
  expect(posted).toContainEqual({ type: "untrack", jobId: "job-first" });
});

it("cancels the job whose audio was not uploaded when stopped", async () => {
  identifyMedia.mockImplementationOnce(noPlayer).mockResolvedValue(media("first"));
  hangingSubmission(true);
  await render();
  let run!: Promise<void>;
  await act(async () => {
    run = queue.start({ handles: ["a", "b"], target }, String);
  });
  await vi.waitFor(() => expect(phases()[0]).toBe("extracting"));
  await act(async () => {
    queue.stop();
    await run;
  });
  expect(cancelJob).toHaveBeenCalledWith("job-open");
  expect(phases()).toEqual(["cancelled", "cancelled"]);
  expect(opens()).toHaveLength(1);
});

it("keeps a job the server already accepted when stopped", async () => {
  identifyMedia.mockImplementationOnce(noPlayer).mockResolvedValue(media("first"));
  hangingSubmission(false);
  await render();
  let run!: Promise<void>;
  await act(async () => {
    run = queue.start({ handles: ["a"], target }, String);
  });
  await vi.waitFor(() => expect(queue.items[0]?.jobId).toBe("job-open"));
  await act(async () => {
    queue.stop();
    await run;
  });
  expect(cancelJob).not.toHaveBeenCalled();
});

it("ends the run without touching jobs when the sign-in changes", async () => {
  identifyMedia.mockImplementationOnce(noPlayer).mockResolvedValue(media("first"));
  hangingSubmission(true);
  await render();
  let run!: Promise<void>;
  await act(async () => {
    run = queue.start({ handles: ["a", "b"], target }, String);
  });
  await vi.waitFor(() => expect(phases()[0]).toBe("extracting"));
  await act(async () => {
    storageChanged?.({ [CAPTION_SESSION_EPOCH_KEY]: { oldValue: 1, newValue: 2 } }, "session");
    await run;
  });
  expect(cancelJob).not.toHaveBeenCalled();
  expect(queue.running).toBe(false);
  expect(opens()).toHaveLength(1);
});
