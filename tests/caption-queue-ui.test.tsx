// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { mount } from "./ui-helpers";
import { LECTURE_TAB_KEY } from "../src/open-tab";
import type { useCaptionQueue } from "../entrypoints/sidepanel/useCaptionQueue";

const queryActive = vi.hoisted(() => vi.fn());
const identifyMedia = vi.hoisted(() => vi.fn());
const submitLecture = vi.hoisted(() => vi.fn());
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

type Queue = ReturnType<typeof useCaptionQueue>;
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
let posted: unknown[];
let receive: ((message: unknown) => void) | undefined;
let queue: Queue;
let ui: Awaited<ReturnType<typeof mount>>;

beforeEach(() => {
  posted = [];
  receive = undefined;
  vi.stubGlobal("chrome", {
    storage: { session: { get: vi.fn(async () => ({ [LECTURE_TAB_KEY]: 9 })) } },
    runtime: {
      connect: () => ({
        postMessage: (message: unknown) => posted.push(message),
        onMessage: { addListener: (listener: typeof receive) => (receive = listener) },
        onDisconnect: { addListener: vi.fn() },
        disconnect: vi.fn(),
      }),
    },
  });
  queryActive.mockResolvedValue({ status: "success", opened: true });
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
  ui = await mount(<Harness />);
}

const phases = () => queue.items.map((item) => item.phase);

it("opens each lecture in the lecture tab and waits for its own player", async () => {
  vi.useFakeTimers();
  // The tab still shows the first lecture's player right after the second open.
  identifyMedia
    .mockResolvedValueOnce(media("first"))
    .mockResolvedValueOnce(media("first"))
    .mockResolvedValue(media("second"));
  await render();
  await act(async () => {
    const run = queue.start({ handles: ["a", "b"], target }, (handle) => `강의 ${handle}`);
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
  });
  expect(queryActive.mock.calls.map(([request]) => request)).toEqual([
    { version: 1, type: "RECORDING_OPEN", handle: "a", reuse: true },
    { version: 1, type: "RECORDING_OPEN", handle: "b", reuse: true },
  ]);
  expect(identifyMedia).toHaveBeenCalledWith(9);
  expect(submitLecture.mock.calls.map(([found]) => found.documentId)).toEqual(["first", "second"]);
  expect(phases()).toEqual(["queued", "queued"]);
  expect(posted).toContainEqual({ type: "track", jobId: "job-second", key: "key-second" });
});

it("skips a lecture that cannot be opened and goes on", async () => {
  queryActive.mockResolvedValueOnce({ status: "error", code: "STALE_SELECTION" });
  identifyMedia.mockResolvedValue(media("second"));
  await render();
  await act(() => queue.start({ handles: ["a", "b"], target }, String));
  expect(queue.items[0]).toMatchObject({ phase: "failed", errorCode: "STALE_SELECTION" });
  expect(queue.items[1]?.phase).toBe("queued");
});

it("stops the whole queue once today's quota runs out", async () => {
  identifyMedia.mockResolvedValue(media("first"));
  submitLecture.mockRejectedValueOnce(Object.assign(new Error("quota"), { code: "QUOTA_EXCEEDED" }));
  await render();
  await act(() => queue.start({ handles: ["a", "b", "c"], target }, String));
  expect(queryActive).toHaveBeenCalledOnce();
  expect(queue.items.map((item) => item.errorCode)).toEqual([
    "QUOTA_EXCEEDED",
    "QUOTA_EXCEEDED",
    "QUOTA_EXCEEDED",
  ]);
  expect(queue.running).toBe(false);
});

it("shows the server's progress and stops following a finished job", async () => {
  identifyMedia.mockResolvedValue(media("first"));
  await render();
  await act(() => queue.start({ handles: ["a"], target }, String));
  await act(async () =>
    receive?.({
      type: "snapshot",
      jobId: "job-first",
      snapshot: { jobId: "job-first", key: "key-first", phase: "running", serverProgress: null, workerOffline: false, errorCode: null },
    }),
  );
  expect(phases()).toEqual(["running"]);
  await act(async () =>
    receive?.({
      type: "snapshot",
      jobId: "job-first",
      snapshot: { jobId: "job-first", key: "key-first", phase: "succeeded", serverProgress: null, workerOffline: false, errorCode: null },
    }),
  );
  expect(phases()).toEqual(["succeeded"]);
  expect(posted).toContainEqual({ type: "untrack", jobId: "job-first" });
});
