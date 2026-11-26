// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { mount } from "./ui-helpers";
import { fakeWorker, forgetWork, type FakeWorker } from "./caption-work-helpers";
import type { useCaptionQueue } from "../entrypoints/sidepanel/useCaptionQueue";
import type { QueueWork, QueueWorkItem } from "../src/captions/work-protocol";

const queryActive = vi.hoisted(() => vi.fn());
const mediaAccess = vi.hoisted(() => vi.fn());
vi.mock("../src/transport", () => ({ queryActive }));
vi.mock("../src/captions/media-source", async (original) => ({
  ...(await original<object>()),
  requestCaptionMediaAccess: mediaAccess,
}));

type Queue = ReturnType<typeof useCaptionQueue>;
const target = { id: 3, url: "https://mylms.korea.ac.kr/courses/1/modules", documentToken: "token" };
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const batch = "00000000-0000-4000-8000-0000000000b1";
const laterBatch = "00000000-0000-4000-8000-0000000000b2";
const KEY_A = `unidock-${"a".repeat(40)}`;
const KEY_B = `unidock-${"b".repeat(40)}`;
const KEY_C = `unidock-${"c".repeat(40)}`;
const titleOf = (handle: string) => `강의 ${handle.at(-1)}`;
const item = (
  handle: string,
  phase: QueueWorkItem["phase"],
  extra: Partial<QueueWorkItem> = {},
): QueueWorkItem => ({
  handle,
  title: titleOf(handle),
  phase,
  errorCode: null,
  jobId: null,
  key: null,
  ...extra,
});
const list = (items: QueueWorkItem[], extra: Partial<QueueWork> = {}): QueueWork => ({
  run: batch,
  tabId: 3,
  running: true,
  items,
  ...extra,
});
const accepted = (handle: string, jobId: string, key: string) =>
  item(handle, "queued", { jobId, key });
const snapshot = (jobId: string, phase: string, errorCode: string | null = null) => ({
  type: "snapshot",
  jobId,
  snapshot: { jobId, key: KEY_A, phase, serverProgress: null, workerOffline: false, errorCode },
});

let worker: FakeWorker;
let posted: unknown[];
let receive: ((message: unknown) => void) | undefined;
let dropped: (() => void) | undefined;
let disconnected: number;
const connect = vi.fn();
let queue: Queue;
let ui: Awaited<ReturnType<typeof mount>> | undefined;

beforeEach(() => {
  posted = [];
  receive = undefined;
  dropped = undefined;
  disconnected = 0;
  worker = fakeWorker();
  connect.mockImplementation(() => ({
    postMessage: (message: unknown) => posted.push(message),
    onMessage: { addListener: (listener: typeof receive) => (receive = listener) },
    onDisconnect: { addListener: (listener: typeof dropped) => (dropped = listener) },
    disconnect: () => disconnected++,
  }));
  vi.stubGlobal("chrome", { runtime: { ...worker.runtime, connect, lastError: undefined } });
  queryActive.mockResolvedValue({ status: "success", batch });
  mediaAccess.mockResolvedValue(true);
});
afterEach(async () => {
  await ui?.unmount();
  ui = undefined;
  await forgetWork();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

async function render() {
  const { useCaptionQueue } = await import("../entrypoints/sidepanel/useCaptionQueue");
  function Harness() {
    queue = useCaptionQueue();
    return null;
  }
  ui = await mount(<StrictMode><Harness /></StrictMode>);
}
const start = (handles: string[] = [A, B]) =>
  act(() => queue.start({ handles, target }, titleOf));
const phases = () => queue.items.map((entry) => entry.phase);
const codes = () => queue.items.map((entry) => entry.errorCode);
const tracks = () => posted.filter((message) => (message as { type: string }).type === "track");

it("asks for media access, admits the selection, then hands the list to the worker", async () => {
  await render();
  await act(() =>
    queue.start({ handles: [A, B], target }, (handle) => (handle === A ? "강의 a" : "가".repeat(400))),
  );
  expect(mediaAccess.mock.invocationCallOrder[0]!).toBeLessThan(
    queryActive.mock.invocationCallOrder[0]!,
  );
  expect(queryActive).toHaveBeenCalledExactlyOnceWith(
    { version: 1, type: "CAPTION_BATCH_ADMIT", handles: [A, B] },
    { target, signal: expect.any(AbortSignal) },
  );
  // The worker gets the admitted batch and labels; it opens the lectures, not this panel.
  expect(worker.sent("CAPTION_WORK_START")).toEqual([
    {
      version: 1,
      type: "CAPTION_WORK_START",
      kind: "queue",
      run: batch,
      tabId: 3,
      items: [
        { handle: A, title: "강의 a" },
        { handle: B, title: "가".repeat(300) },
      ],
    },
  ]);
  expect(phases()).toEqual(["waiting", "waiting"]);
  expect(queue.running).toBe(true);
});

it("shows the list at once and takes no second start while the first is being admitted", async () => {
  const access = Promise.withResolvers<boolean>();
  mediaAccess.mockReturnValue(access.promise);
  await render();
  let run!: Promise<void>;
  await act(async () => {
    run = queue.start({ handles: [A, B], target }, titleOf);
  });
  expect(queue.items).toEqual([
    { handle: A, title: "강의 a", phase: "waiting", errorCode: null, jobId: null },
    { handle: B, title: "강의 b", phase: "waiting", errorCode: null, jobId: null },
  ]);
  expect(queue.running).toBe(true);
  expect(worker.sent("CAPTION_WORK_START")).toEqual([]);

  await start([C]);
  expect(mediaAccess).toHaveBeenCalledOnce();
  await act(async () => {
    access.resolve(true);
    await run;
  });
  expect(worker.sent("CAPTION_WORK_START")).toHaveLength(1);
  expect(queue.items.map((entry) => entry.handle)).toEqual([A, B]);
});

it("spends nothing from the list when media access is refused", async () => {
  mediaAccess.mockResolvedValueOnce(false);
  await render();
  await start();
  expect(queryActive).not.toHaveBeenCalled();
  expect(worker.sent("CAPTION_WORK_START")).toEqual([]);
  expect(codes()).toEqual(["PERMISSION", "PERMISSION"]);
  expect(phases()).toEqual(["failed", "failed"]);
  expect(queue.running).toBe(false);
});

it.each([
  ["the list tab refuses it", () => Promise.resolve({ status: "error", code: "STALE_SELECTION" }), "STALE_SELECTION"],
  ["the list tab cannot be reached", () => Promise.reject(Object.assign(new Error("gone"), { code: "RELOAD_TAB" })), "RELOAD_TAB"],
  ["the answer names no batch", () => Promise.resolve({ status: "success", opened: true }), "STALE_SELECTION"],
])("fails every lecture and starts nothing when %s", async (_case, answer, code) => {
  queryActive.mockImplementationOnce(answer);
  await render();
  await start();
  expect(codes()).toEqual([code, code]);
  expect(queue.running).toBe(false);
  expect(worker.sent("CAPTION_WORK_START")).toEqual([]);
});

it("fails every lecture when the worker cannot take the list", async () => {
  worker.answer = (command) =>
    command.type === "CAPTION_WORK_START"
      ? { status: "error", code: "ACTIVE_JOB_EXISTS" }
      : undefined;
  await render();
  await start();
  expect(codes()).toEqual(["ACTIVE_JOB_EXISTS", "ACTIVE_JOB_EXISTS"]);
  expect(queue.running).toBe(false);
});

it("stopped while the selection is being admitted, it ends cancelled and starts nothing", async () => {
  queryActive.mockImplementation(
    (_request: unknown, { signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      ),
  );
  await render();
  let run!: Promise<void>;
  await act(async () => {
    run = queue.start({ handles: [A, B], target }, titleOf);
  });
  expect(queryActive).toHaveBeenCalledOnce();
  await act(async () => {
    queue.stop();
    await run;
  });
  expect(phases()).toEqual(["cancelled", "cancelled"]);
  expect(queue.running).toBe(false);
  expect(worker.sent("CAPTION_WORK_START")).toEqual([]);
  // The worker never had this list, so there is nothing to stop or forget there.
  await act(async () => queue.clear());
  expect(queue.items).toEqual([]);
  expect(worker.sent("CAPTION_WORK_CANCEL")).toEqual([]);
  expect(worker.sent("CAPTION_WORK_DISMISS")).toEqual([]);
});

it("shows each lecture as the worker reports it", async () => {
  await render();
  await start();
  await worker.report({
    queue: list([
      item(A, "failed", { errorCode: "MEDIA_NETWORK" }),
      item(B, "uploading", { jobId: "job_b" }),
    ]),
  });
  expect(queue.items).toEqual([
    { handle: A, title: "강의 a", phase: "failed", errorCode: "MEDIA_NETWORK", jobId: null },
    { handle: B, title: "강의 b", phase: "uploading", errorCode: null, jobId: "job_b" },
  ]);
  // A job the server does not have yet is the document's, not one to follow.
  expect(connect).not.toHaveBeenCalled();
});

it("follows the jobs the server accepted and stops following a finished one", async () => {
  await render();
  await start([A, B, C]);
  await worker.report({
    queue: list([accepted(A, "job_a", KEY_A), item(B, "extracting", { jobId: "job_b" }), item(C, "waiting")]),
  });
  expect(tracks()).toEqual([{ type: "track", jobId: "job_a", key: KEY_A }]);

  await act(async () => receive?.(snapshot("job_a", "running")));
  expect(phases()).toEqual(["running", "extracting", "waiting"]);
  await worker.report({
    queue: list([accepted(A, "job_a", KEY_A), accepted(B, "job_b", KEY_B), item(C, "uploading", { jobId: "job_c" })]),
  });
  expect(tracks()).toEqual([
    { type: "track", jobId: "job_a", key: KEY_A },
    { type: "track", jobId: "job_b", key: KEY_B },
  ]);

  await act(async () => receive?.(snapshot("job_a", "succeeded")));
  expect(phases()[0]).toBe("succeeded");
  expect(posted).toContainEqual({ type: "untrack", jobId: "job_a" });
  // Neither a late snapshot nor the next report brings a finished job back.
  await act(async () => receive?.(snapshot("job_a", "running")));
  await worker.report({
    queue: list([accepted(A, "job_a", KEY_A), accepted(B, "job_b", KEY_B), accepted(C, "job_c", KEY_C)], {
      running: false,
    }),
  });
  expect(phases()[0]).toBe("succeeded");
  expect(tracks()).toHaveLength(3);

  await act(async () => receive?.(snapshot("job_b", "failed", "TRANSCRIPTION_FAILED")));
  expect(queue.items[1]).toMatchObject({ phase: "failed", errorCode: "TRANSCRIPTION_FAILED" });
  // The worker dropped this job: local data was deleted or the sign-in changed.
  await act(async () => receive?.({ type: "snapshot", jobId: "job_c", snapshot: null }));
  expect(queue.items[2]).toMatchObject({ phase: "cancelled", errorCode: null });
  expect(posted).toContainEqual({ type: "untrack", jobId: "job_c" });
});

it("tells the worker when the panel is hidden or shown", async () => {
  worker.queue = list([accepted(A, "job_a", KEY_A)]);
  await render();
  posted.length = 0;
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  visibility.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  visibility.mockRestore();
  expect(posted).toEqual([
    { type: "visible", visible: false },
    { type: "visible", visible: true },
  ]);
});

it("reconnects to a restarted worker only while a job is followed, and tracks it again", async () => {
  worker.queue = list([accepted(A, "job_a", KEY_A), item(B, "uploading", { jobId: "job_b" })]);
  await render();
  expect(connect).toHaveBeenCalledOnce();
  posted.length = 0;
  await act(async () => dropped?.());
  expect(connect).toHaveBeenCalledTimes(2);
  expect(tracks()).toEqual([{ type: "track", jobId: "job_a", key: KEY_A }]);

  await act(async () => receive?.(snapshot("job_a", "succeeded")));
  await act(async () => dropped?.());
  expect(connect).toHaveBeenCalledTimes(2);
  // The next accepted job opens a port of its own.
  await worker.report({
    queue: list([accepted(A, "job_a", KEY_A), accepted(B, "job_b", KEY_B)], { running: false }),
  });
  expect(connect).toHaveBeenCalledTimes(3);
  expect(tracks().at(-1)).toEqual({ type: "track", jobId: "job_b", key: KEY_B });
});

it("stops reconnecting after five drops", async () => {
  worker.queue = list([accepted(A, "job_a", KEY_A)]);
  await render();
  for (let drop = 0; drop < 8; drop++) await act(async () => dropped?.());
  expect(connect).toHaveBeenCalledTimes(6);
});

it("stop asks the worker to stop the list, and clear forgets only a stopped one", async () => {
  await render();
  await start();
  await act(async () => queue.clear());
  expect(worker.sent("CAPTION_WORK_DISMISS")).toEqual([]);
  expect(phases()).toEqual(["waiting", "waiting"]);

  await act(async () => queue.stop());
  expect(worker.sent("CAPTION_WORK_CANCEL")).toEqual([
    { version: 1, type: "CAPTION_WORK_CANCEL", kind: "queue", run: batch },
  ]);
  expect(queue.running).toBe(false);
  expect(phases()).toEqual(["cancelled", "cancelled"]);
  await act(async () => queue.stop());
  expect(worker.sent("CAPTION_WORK_CANCEL")).toHaveLength(1);

  await act(async () => queue.clear());
  expect(worker.sent("CAPTION_WORK_DISMISS")).toEqual([
    { version: 1, type: "CAPTION_WORK_DISMISS", run: batch },
  ]);
  expect(queue.items).toEqual([]);
});

it("a reopened panel shows the list the worker still runs and starts no second one", async () => {
  worker.queue = list([
    accepted(A, "job_a", KEY_A),
    item(B, "uploading", { jobId: "job_b" }),
    item(C, "waiting"),
  ]);
  await render();
  expect(phases()).toEqual(["queued", "uploading", "waiting"]);
  expect(queue.running).toBe(true);
  expect(tracks()).toEqual([{ type: "track", jobId: "job_a", key: KEY_A }]);

  await start([A]);
  expect(mediaAccess).not.toHaveBeenCalled();
  expect(queryActive).not.toHaveBeenCalled();
  expect(worker.sent("CAPTION_WORK_START")).toEqual([]);
});

it("closing the panel stops nothing and leaves the worker following the jobs", async () => {
  worker.queue = list([accepted(A, "job_a", KEY_A), item(B, "uploading", { jobId: "job_b" })]);
  await render();
  posted.length = 0;
  const before = disconnected;
  await ui!.unmount();
  ui = undefined;
  expect(worker.sent("CAPTION_WORK_CANCEL")).toEqual([]);
  expect(worker.queue?.running).toBe(true);
  expect(posted).toEqual([]);
  expect(disconnected).toBe(before + 1);
});

it("shows a new list from the worker's report alone, not from the jobs of the one before", async () => {
  worker.queue = list([accepted(A, "job_a", KEY_A)], { running: false });
  await render();
  await act(async () => receive?.(snapshot("job_a", "running")));
  expect(phases()).toEqual(["running"]);
  posted.length = 0;
  await worker.report({ queue: list([accepted(A, "job_a", KEY_A)], { run: laterBatch }) });
  expect(phases()).toEqual(["queued"]);
  expect(tracks()).toEqual([{ type: "track", jobId: "job_a", key: KEY_A }]);
});
