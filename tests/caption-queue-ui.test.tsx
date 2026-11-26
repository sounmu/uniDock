// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { mount } from "./ui-helpers";
import { lectureTabKey } from "../src/open-tab";
import { CAPTION_SESSION_EPOCH_KEY } from "../src/caption-server-settings";
import type { useCaptionQueue } from "../entrypoints/sidepanel/useCaptionQueue";

const queryActive = vi.hoisted(() => vi.fn());
const identifyMedia = vi.hoisted(() => vi.fn());
const submitLecture = vi.hoisted(() => vi.fn());
const cancelJob = vi.hoisted(() => vi.fn());
const mediaAccess = vi.hoisted(() => vi.fn());
const publishQueuePreparing = vi.hoisted(() => vi.fn());
vi.mock("../src/transport", () => ({ queryActive }));
vi.mock("../src/captions/media-source", async (original) => ({
  ...(await original<object>()),
  identifyMedia,
  requestCaptionMediaAccess: mediaAccess,
}));
vi.mock("../src/captions/submit-lecture", async (original) => ({
  ...(await original<object>()),
  submitLecture,
}));
vi.mock("../entrypoints/sidepanel/progress-activity", async (original) => ({
  ...(await original<object>()),
  publishQueuePreparing,
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
    : request.type === "CAPTION_BATCH_VERIFY"
      ? { status: "success", verified: true }
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
      session: {
        get: vi.fn(async (key: string) => (key === lectureTabKey(target.id) ? { [key]: 9 } : {})),
      },
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
  mediaAccess.mockResolvedValue(true);
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

it("opens each lecture in the lecture tab and sends the player confirmed as its own", async () => {
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
    { version: 1, type: "CAPTION_BATCH_VERIFY", batch, index: 0, document: "first" },
    { version: 1, type: "CAPTION_BATCH_OPEN", batch, index: 1 },
    { version: 1, type: "CAPTION_BATCH_VERIFY", batch, index: 1, document: "second" },
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

it.each([
  ["shows another lecture", async () => ({ status: "error", code: "LECTURE_MISMATCH" })],
  ["cannot be asked about", () => Promise.reject(new Error("no receiver"))],
])("sends no audio from a lecture tab that %s, and goes on", async (_case, answer) => {
  vi.useFakeTimers();
  let shown = "other";
  queryActive.mockImplementation(
    async (request: { type: string; index?: number; document?: string }) => {
      if (request.type === "CAPTION_BATCH_OPEN" && request.index === 1) shown = "second";
      return request.type === "CAPTION_BATCH_VERIFY" && request.document === "other"
        ? answer()
        : admitted(request);
    },
  );
  identifyMedia.mockImplementation(async () => media(shown));
  identifyMedia.mockImplementationOnce(noPlayer);
  await render();
  await act(async () => {
    const run = queue.start({ handles: ["a", "b"], target }, String);
    await vi.advanceTimersByTimeAsync(50_000);
    await run;
  });
  expect(queryActive).toHaveBeenCalledWith(
    { version: 1, type: "CAPTION_BATCH_VERIFY", batch, index: 0, document: "other" },
    expect.objectContaining({ target }),
  );
  expect(queue.items[0]).toMatchObject({ phase: "failed", errorCode: "LECTURE_MISMATCH", jobId: null });
  expect(submitLecture.mock.calls.map(([found]) => found.documentId)).toEqual(["second"]);
  expect(queue.items[1]?.phase).toBe("queued");
});

it("treats a tab that never leaves the previous lecture as a mismatch without asking", async () => {
  vi.useFakeTimers();
  identifyMedia.mockImplementation(async () => media("old"));
  await render();
  await act(async () => {
    const run = queue.start({ handles: ["a"], target }, String);
    await vi.advanceTimersByTimeAsync(50_000);
    await run;
  });
  expect(queue.items[0]).toMatchObject({ phase: "failed", errorCode: "LECTURE_MISMATCH" });
  expect(queryActive.mock.calls.map(([request]) => request.type)).toEqual([
    "CAPTION_BATCH_ADMIT",
    "CAPTION_BATCH_OPEN",
  ]);
  expect(submitLecture).not.toHaveBeenCalled();
});

it("reports no player when the tab leaves the previous lecture for a page without one", async () => {
  vi.useFakeTimers();
  identifyMedia.mockResolvedValueOnce(media("old")).mockResolvedValueOnce(media("old"));
  identifyMedia.mockImplementation(noPlayer);
  await render();
  await act(async () => {
    const run = queue.start({ handles: ["a"], target }, String);
    await vi.advanceTimersByTimeAsync(50_000);
    await run;
  });
  expect(queue.items[0]).toMatchObject({ phase: "failed", errorCode: "UNSUPPORTED_MEDIA" });
});

it("sends nothing when stopped while the lecture is being confirmed", async () => {
  vi.useFakeTimers();
  let confirm: (() => void) | undefined;
  queryActive.mockImplementation((request: { type: string }) =>
    request.type === "CAPTION_BATCH_VERIFY"
      ? new Promise((resolve) => (confirm = () => resolve({ status: "success", verified: true })))
      : admitted(request),
  );
  identifyMedia.mockImplementationOnce(noPlayer).mockResolvedValue(media("first"));
  await render();
  await act(async () => {
    const run = queue.start({ handles: ["a"], target }, String);
    await vi.advanceTimersByTimeAsync(0);
    queue.stop();
    confirm?.();
    await run;
  });
  expect(confirm).toBeDefined();
  expect(submitLecture).not.toHaveBeenCalled();
  expect(phases()).toEqual(["cancelled"]);
});

it("reports the limit when the lecture check itself keeps being refused", async () => {
  vi.useFakeTimers();
  queryActive.mockImplementation(async (request: { type: string }) =>
    request.type === "CAPTION_BATCH_VERIFY" ? { status: "error", code: "RATE_LIMITED" } : admitted(request),
  );
  identifyMedia.mockImplementationOnce(noPlayer).mockResolvedValue(media("first"));
  await render();
  await act(async () => {
    const run = queue.start({ handles: ["a"], target }, String);
    await vi.advanceTimersByTimeAsync(50_000);
    await run;
  });
  expect(queue.items[0]).toMatchObject({ phase: "failed", errorCode: "RATE_LIMITED" });
  expect(submitLecture).not.toHaveBeenCalled();
});

it("stops the queue when the list tab is lost while a lecture is confirmed", async () => {
  queryActive.mockImplementation(async (request: { type: string }) =>
    request.type === "CAPTION_BATCH_VERIFY" ? { status: "error", code: "RELOAD_TAB" } : admitted(request),
  );
  identifyMedia.mockImplementationOnce(noPlayer).mockResolvedValue(media("first"));
  await render();
  await act(() => queue.start({ handles: ["a", "b"], target }, String));
  expect(queue.items.map((item) => item.errorCode)).toEqual(["RELOAD_TAB", "RELOAD_TAB"]);
  expect(opens()).toHaveLength(1);
  expect(submitLecture).not.toHaveBeenCalled();
});

it("waits out the tab-open limit and opens the same lecture again", async () => {
  vi.useFakeTimers();
  queryActive
    .mockImplementationOnce(admitted)
    .mockResolvedValueOnce({ status: "error", code: "RATE_LIMITED" });
  // Each open attempt first reads what the tab shows.
  for (const shown of ["old", "old", "first", "first", "second"])
    identifyMedia.mockResolvedValueOnce(media(shown));
  await render();
  await act(async () => {
    const run = queue.start({ handles: ["a", "b"], target }, String);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
  });
  expect(opens().map(([request]) => request.index)).toEqual([0, 0, 1]);
  expect(phases()).toEqual(["queued", "queued"]);
});

it("compares against what the tab shows right before a retried open", async () => {
  vi.useFakeTimers();
  queryActive
    .mockImplementationOnce(admitted)
    .mockResolvedValueOnce({ status: "error", code: "RATE_LIMITED" });
  // The user switches the lecture tab to another lecture during the wait;
  // it stays readable until the retried open commits.
  for (const shown of ["old", "switched", "switched", "first"])
    identifyMedia.mockResolvedValueOnce(media(shown));
  await render();
  await act(async () => {
    const run = queue.start({ handles: ["a"], target }, String);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
  });
  expect(submitLecture.mock.calls.map(([found]) => found.documentId)).toEqual(["first"]);
});

it("gives up on a lecture still refused after one limit window and goes on", async () => {
  vi.useFakeTimers();
  let secondOpened = false;
  queryActive.mockImplementation(async (request: { type: string; index?: number }) => {
    if (request.type === "CAPTION_BATCH_OPEN" && request.index === 0)
      return { status: "error", code: "RATE_LIMITED" };
    if (request.type === "CAPTION_BATCH_OPEN") secondOpened = true;
    return admitted(request);
  });
  identifyMedia.mockImplementation(() => (secondOpened ? Promise.resolve(media("second")) : noPlayer()));
  await render();
  await act(async () => {
    const run = queue.start({ handles: ["a", "b"], target }, String);
    await vi.advanceTimersByTimeAsync(70_000);
    await run;
  });
  expect(queue.items[0]).toMatchObject({ phase: "failed", errorCode: "RATE_LIMITED" });
  expect(queue.items[1]?.phase).toBe("queued");
});

it("stops waiting on the tab-open limit when the run is stopped", async () => {
  vi.useFakeTimers();
  queryActive.mockImplementation(async (request: { type: string }) =>
    request.type === "CAPTION_BATCH_OPEN" ? { status: "error", code: "RATE_LIMITED" } : admitted(request),
  );
  identifyMedia.mockImplementation(noPlayer);
  await render();
  await act(async () => {
    const run = queue.start({ handles: ["a", "b"], target }, String);
    await vi.advanceTimersByTimeAsync(1_000);
    queue.stop();
    await run;
  });
  expect(opens()).toHaveLength(1);
  expect(phases()).toEqual(["cancelled", "cancelled"]);
});

it("ends at once when stopped while a refused open is still in flight", async () => {
  vi.useFakeTimers();
  let refuse: (() => void) | undefined;
  queryActive.mockImplementation((request: { type: string }) =>
    request.type === "CAPTION_BATCH_OPEN"
      ? new Promise((resolve) => (refuse = () => resolve({ status: "error", code: "RATE_LIMITED" })))
      : admitted(request),
  );
  identifyMedia.mockImplementation(noPlayer);
  await render();
  let finished = false;
  await act(async () => {
    const run = queue.start({ handles: ["a", "b"], target }, String).then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(0);
    queue.stop();
    refuse?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(true);
    await run;
  });
  expect(opens()).toHaveLength(1);
  expect(phases()).toEqual(["cancelled", "cancelled"]);
});

it("spends nothing from the list when media access is refused", async () => {
  mediaAccess.mockResolvedValueOnce(false);
  await render();
  await act(() => queue.start({ handles: ["a", "b"], target }, String));
  expect(queryActive).not.toHaveBeenCalled();
  expect(queue.items.map((item) => item.errorCode)).toEqual(["PERMISSION", "PERMISSION"]);
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
  // While lectures wait to be read and uploaded, the batch holds the panel's audio slot.
  expect(publishQueuePreparing.mock.calls.at(-1)).toEqual([true]);
  let cancelled!: () => void;
  cancelJob.mockReturnValueOnce(new Promise<void>((resolve) => (cancelled = resolve)));
  await act(async () => queue.stop());
  await vi.waitFor(() => expect(cancelJob).toHaveBeenCalledWith("job-open"));
  // A restart could get the same job back, so the run holds until it is cancelled.
  expect(queue.running).toBe(true);
  await act(async () => {
    cancelled();
    await run;
  });
  expect(queue.running).toBe(false);
  expect(phases()).toEqual(["cancelled", "cancelled"]);
  expect(opens()).toHaveLength(1);
  expect(publishQueuePreparing.mock.calls.at(-1)).toEqual([false]);
});

it("cancels the job of a lecture whose audio could not be read before going on", async () => {
  identifyMedia
    .mockImplementationOnce(noPlayer)
    .mockResolvedValueOnce(media("first"))
    .mockResolvedValueOnce(media("first"))
    .mockResolvedValue(media("second"));
  submitLecture.mockImplementationOnce(async (_found: unknown, hooks: Hooks) => {
    hooks.onJob("job-unread");
    hooks.onPhase("extracting");
    throw Object.assign(new Error("network"), { code: "MEDIA_NETWORK" });
  });
  let releaseSlot!: () => void;
  cancelJob.mockReturnValueOnce(new Promise<void>((resolve) => (releaseSlot = resolve)));
  await render();
  let run!: Promise<void>;
  await act(async () => {
    run = queue.start({ handles: ["a", "b"], target }, String);
  });
  await vi.waitFor(() => expect(cancelJob).toHaveBeenCalledWith("job-unread"));
  expect(opens()).toHaveLength(1);
  await act(async () => {
    releaseSlot();
    await run;
  });
  expect(opens()).toHaveLength(2);
  expect(queue.items[0]).toMatchObject({ phase: "failed", errorCode: "MEDIA_NETWORK" });
  expect(queue.items[1]?.phase).toBe("queued");
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
