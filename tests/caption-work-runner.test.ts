import { afterEach, beforeEach, expect, it, vi } from "vitest";

const createJob = vi.hoisted(() => vi.fn());
const uploadAudio = vi.hoisted(() => vi.fn());
const cancelJob = vi.hoisted(() => vi.fn());
const extractAudio = vi.hoisted(() => vi.fn());
vi.mock("../src/captions/job-client", async (original) => ({
  ...(await original<object>()),
  createJob,
  uploadAudio,
  cancelJob,
}));
vi.mock("../src/captions/media-fetch", () => ({
  mediaRangeReader: () => ({
    totalSize: async () => 12345,
    fetchRange: async () => new ArrayBuffer(0),
    fetchRanges: vi.fn(),
  }),
}));
vi.mock("../src/captions/audio-extract", async (original) => ({
  ...(await original<object>()),
  extractAudio,
}));

import { OPEN_RATE_WINDOW_MS } from "../src/open-tab";
import type { LectureMedia, MediaReply, OpenReply } from "../src/captions/work-protocol";
import {
  CaptionWorkRunner,
  MEDIA_RETRY_MS,
  MEDIA_WAIT_MS,
  RATE_LIMIT_RETRY_MS,
  type WorkSnapshot,
  type WorkerLink,
} from "../src/captions/work-runner";

const run = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const handles = [
  "00000000-0000-4000-8000-0000000000a1",
  "00000000-0000-4000-8000-0000000000a2",
  "00000000-0000-4000-8000-0000000000a3",
];
const keyOf = (index: number) => `unidock-${String(index).repeat(40)}`;
const media = (index: number): LectureMedia => ({
  mediaUrl:
    "https://korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/0123456789abc/contents/media_files/screen.mp4",
  durationS: 60,
  key: keyOf(index),
  title: `${index}주차 강의`,
  tabId: 9,
  documentId: `DOC${index}`,
});
const found = (index: number): MediaReply => ({ status: "success", media: media(index) });
const opened = (previous: string | null = null): OpenReply => ({ status: "success", previous });
const failure = (code: string) => Object.assign(new Error(code), { code });
const job = (id: string, state = "awaiting_upload") => ({ id, state, cancelRequested: false });
const startSingle = { version: 1, type: "CAPTION_WORK_START", kind: "single", run, tabId: 3 } as const;
const startQueue = (count = 2) =>
  ({
    version: 1,
    type: "CAPTION_WORK_START",
    kind: "queue",
    run,
    tabId: 3,
    items: handles.slice(0, count).map((handle, index) => ({ handle, title: `강의 ${index + 1}` })),
  }) as const;
const cancel = (kind: "single" | "queue", id = run) =>
  ({ version: 1, type: "CAPTION_WORK_CANCEL", kind, run: id }) as const;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
/** Runs every promise continuation queued so far; no timer is involved. */
const drained = () => new Promise<void>((resolve) => setImmediate(resolve));

let snapshots: WorkSnapshot[];
let watchers: { check: (work: WorkSnapshot) => boolean; resolve: (work: WorkSnapshot) => void }[];
let rules: string[];
let link: {
  media: ReturnType<typeof vi.fn<WorkerLink["media"]>>;
  open: ReturnType<typeof vi.fn<WorkerLink["open"]>>;
  accept: ReturnType<typeof vi.fn<WorkerLink["accept"]>>;
  rule: WorkerLink["rule"];
  publish: WorkerLink["publish"];
};
let runner: CaptionWorkRunner;

/** Resolves with the first reported state that satisfies `check`. */
function until(check: (work: WorkSnapshot) => boolean): Promise<WorkSnapshot> {
  const seen = snapshots.find(check);
  if (seen) return Promise.resolve(seen);
  return new Promise((resolve) => watchers.push({ check, resolve }));
}
const last = () => snapshots.at(-1)!;
const singlePhases = () =>
  snapshots.map((work) => work.single?.phase).filter((phase, at, all) => phase !== all[at - 1]);
const itemPhases = () => last().queue!.items.map((item) => item.phase);
const queueDone = () => until((work) => work.queue !== null && !work.queue.running);

beforeEach(() => {
  snapshots = [];
  watchers = [];
  rules = [];
  link = {
    media: vi.fn<WorkerLink["media"]>(),
    open: vi.fn<WorkerLink["open"]>(),
    accept: vi.fn<WorkerLink["accept"]>(async () => {}),
    rule: {
      add: async () => {
        rules.push("add");
        return true;
      },
      remove: async () => {
        rules.push("remove");
      },
    },
    publish: (work) => {
      snapshots.push(work);
      for (const watcher of watchers.splice(0))
        if (watcher.check(work)) watcher.resolve(work);
        else watchers.push(watcher);
    },
  };
  runner = new CaptionWorkRunner(link);
  createJob.mockImplementation(async (key: string) => job(`job-${key.at(-1)}`));
  extractAudio.mockResolvedValue(new Blob(["audio"]));
  uploadAudio.mockResolvedValue(undefined);
  cancelJob.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("reads the tab's media, uploads its audio and hands the accepted job to the worker", async () => {
  link.media.mockResolvedValue(found(1));
  expect(await runner.command(startSingle)).toEqual({ status: "success", accepted: null });
  expect(runner.busy()).toBe(true);
  const done = await until((work) => work.single?.phase === "queued");

  expect(link.media).toHaveBeenCalledWith({ tabId: 3 });
  expect(singlePhases()).toEqual(["identifying", "extracting", "uploading", "queued"]);
  expect(done.single).toEqual({
    run,
    tabId: 3,
    documentId: "DOC1",
    phase: "queued",
    jobId: "job-1",
    key: keyOf(1),
    errorCode: null,
    title: "1주차 강의",
    durationS: 60,
  });
  expect(createJob).toHaveBeenCalledWith(keyOf(1), { durationHintS: 60 }, expect.any(AbortSignal));
  expect(rules).toEqual(["add", "remove"]);
  expect(link.accept).toHaveBeenCalledExactlyOnceWith("job-1", keyOf(1));
  // While the server had no audio the job was the document's to cancel.
  const extracting = snapshots.find((work) => work.single?.phase === "extracting")!;
  expect(extracting.unfinished).toEqual(["job-1"]);
  expect(done.unfinished).toEqual([]);
  expect(cancelJob).not.toHaveBeenCalled();
  expect(runner.busy()).toBe(false);
});

it("skips reading audio for a job the server already has", async () => {
  link.media.mockResolvedValue(found(1));
  createJob.mockResolvedValue(job("job-old", "running"));
  await runner.command(startSingle);
  await until((work) => work.single?.phase === "queued");
  expect(extractAudio).not.toHaveBeenCalled();
  expect(uploadAudio).not.toHaveBeenCalled();
  expect(snapshots.every((work) => work.unfinished.length === 0)).toBe(true);
  expect(link.accept).toHaveBeenCalledWith("job-old", keyOf(1));
});

it("a failed read cancels the job the server has no audio for", async () => {
  link.media.mockResolvedValue(found(1));
  extractAudio.mockRejectedValue(failure("MEDIA_DENIED"));
  const released = deferred();
  cancelJob.mockReturnValue(released.promise);
  await runner.command(startSingle);
  const failed = await until((work) => work.single?.phase === "failed");
  expect(failed.single).toMatchObject({ phase: "failed", errorCode: "MEDIA_DENIED", jobId: "job-1" });
  await until((work) => work.single?.phase === "failed" && work.unfinished.length === 1);
  expect(cancelJob).toHaveBeenCalledExactlyOnceWith("job-1");
  // Until the server confirms, the job still counts as unfinished.
  expect(runner.busy()).toBe(true);
  released.resolve();
  await until((work) => work.single?.phase === "failed" && work.unfinished.length === 0);
  expect(runner.busy()).toBe(false);
  expect(rules).toEqual(["add", "remove"]);
  expect(link.accept).not.toHaveBeenCalled();
});

it.each([
  [{ status: "error", code: "ACTIVATE_TAB" } as MediaReply, "ACTIVATE_TAB"],
  [{ status: "pending" } as MediaReply, "UNSUPPORTED_MEDIA"],
])("a tab without readable media fails before any job exists: %o", async (reply, code) => {
  link.media.mockResolvedValue(reply);
  await runner.command(startSingle);
  const failed = await until((work) => work.single?.phase === "failed");
  expect(failed.single?.errorCode).toBe(code);
  expect(createJob).not.toHaveBeenCalled();
  expect(cancelJob).not.toHaveBeenCalled();
});

it("fails without reading media when the worker cannot install the rule, and gives the use back", async () => {
  link.media.mockResolvedValue(found(1));
  link.rule = { add: async () => false, remove: async () => {} };
  runner = new CaptionWorkRunner(link);
  await runner.command(startSingle);
  const failed = await until((work) => work.single?.phase === "failed" && work.unfinished.length === 0);
  expect(failed.single?.errorCode).toBe("UNKNOWN");
  expect(extractAudio).not.toHaveBeenCalled();
  expect(cancelJob).toHaveBeenCalledExactlyOnceWith("job-1");
});

it("cancelling a run that is uploading stops it and releases its job", async () => {
  link.media.mockResolvedValue(found(1));
  const upload = deferred();
  let signal: AbortSignal | undefined;
  uploadAudio.mockImplementation((_id: string, _audio: Blob, given: AbortSignal) => {
    signal = given;
    return upload.promise;
  });
  await runner.command(startSingle);
  await until((work) => work.single?.phase === "uploading");

  expect(await runner.command(cancel("single"))).toEqual({ status: "success", accepted: null });
  expect(signal?.aborted).toBe(true);
  expect(cancelJob).toHaveBeenCalledExactlyOnceWith("job-1");
  expect(last()).toEqual({ single: null, queue: null, unfinished: [] });

  // The upload answering late changes nothing.
  upload.resolve();
  await drained();
  expect(link.accept).not.toHaveBeenCalled();
  expect(last().single).toBeNull();
  expect(cancelJob).toHaveBeenCalledOnce();
});

it("cancelling after the hand-over names the job for the caller to cancel", async () => {
  link.media.mockResolvedValue(found(1));
  await runner.command(startSingle);
  await until((work) => work.single?.phase === "queued");
  expect(await runner.command(cancel("single"))).toEqual({ status: "success", accepted: "job-1" });
  expect(cancelJob).not.toHaveBeenCalled();
  expect(last().single).toBeNull();
});

it("ignores a cancel for a run it does not hold", async () => {
  link.media.mockReturnValue(new Promise(() => {}));
  await runner.command(startSingle);
  expect(await runner.command(cancel("single", other))).toEqual({ status: "success", accepted: null });
  expect(await runner.command(cancel("queue", other))).toEqual({ status: "success", accepted: null });
  expect(last().single?.run).toBe(run);
  expect(cancelJob).not.toHaveBeenCalled();
});

it("reads one lecture's audio at a time, and takes the next run once that is done", async () => {
  link.media.mockResolvedValue(found(1));
  const upload = deferred();
  uploadAudio.mockReturnValueOnce(upload.promise);
  await runner.command(startSingle);
  await until((work) => work.single?.phase === "uploading");
  const busy = { status: "error", code: "ACTIVE_JOB_EXISTS" };
  expect(await runner.command({ ...startSingle, run: other })).toEqual(busy);
  expect(await runner.command(startQueue())).toEqual(busy);
  expect(last().single?.run).toBe(run);

  upload.resolve();
  await until((work) => work.single?.phase === "queued");
  link.media.mockResolvedValue(found(2));
  expect((await runner.command({ ...startSingle, run: other })).status).toBe("success");
  const next = await until((work) => work.single?.run === other && work.single.phase === "queued");
  expect(next.single?.jobId).toBe("job-2");
});

it("uploads once into a fresh job when the server holds audio of another length", async () => {
  link.media.mockResolvedValue(found(1));
  createJob.mockResolvedValueOnce(job("job-old")).mockResolvedValueOnce(job("job-new"));
  uploadAudio.mockRejectedValueOnce(failure("UPLOAD_CONFLICT")).mockResolvedValueOnce(undefined);
  await runner.command(startSingle);
  const done = await until((work) => work.single?.phase === "queued");
  expect(cancelJob).toHaveBeenCalledExactlyOnceWith("job-old", expect.any(AbortSignal));
  expect(uploadAudio.mock.calls.map(([id]) => id)).toEqual(["job-old", "job-new"]);
  expect(done.single?.jobId).toBe("job-new");
  expect(link.accept).toHaveBeenCalledExactlyOnceWith("job-new", keyOf(1));
  // The fresh job took over as the one to release.
  expect(snapshots.some((work) => work.unfinished.includes("job-new"))).toBe(true);
});

it("gives up when the server returns the conflicting job again", async () => {
  link.media.mockResolvedValue(found(1));
  createJob.mockResolvedValue(job("job-old"));
  uploadAudio.mockRejectedValue(failure("UPLOAD_CONFLICT"));
  await runner.command(startSingle);
  const failed = await until((work) => work.single?.phase === "failed" && work.unfinished.length === 0);
  expect(failed.single?.errorCode).toBe("UPLOAD_CONFLICT");
  expect(uploadAudio).toHaveBeenCalledOnce();
  expect(link.accept).not.toHaveBeenCalled();
});

it("follows a job another upload already finished", async () => {
  link.media.mockResolvedValue(found(1));
  uploadAudio.mockRejectedValue(failure("UPLOAD_CLOSED"));
  await runner.command(startSingle);
  await until((work) => work.single?.phase === "queued");
  expect(link.accept).toHaveBeenCalledWith("job-1", keyOf(1));
  expect(cancelJob).not.toHaveBeenCalled();
});

it("keeps the run failed when the worker cannot take the job over, without cancelling it", async () => {
  link.media.mockResolvedValue(found(1));
  link.accept.mockRejectedValue(failure("STORAGE"));
  await runner.command(startSingle);
  const failed = await until((work) => work.single?.phase === "failed");
  expect(failed.single?.errorCode).toBe("STORAGE");
  await drained();
  // The server has the audio: cancelling now would throw the work away.
  expect(cancelJob).not.toHaveBeenCalled();
});

it("a changed sign-in drops every run and leaves the earlier account's jobs alone", async () => {
  link.media.mockResolvedValue(found(1));
  const upload = deferred();
  let signal: AbortSignal | undefined;
  uploadAudio.mockImplementation((_id: string, _audio: Blob, given: AbortSignal) => {
    signal = given;
    return upload.promise;
  });
  await runner.command(startSingle);
  await until((work) => work.single?.phase === "uploading");
  runner.sessionEnded();
  expect(signal?.aborted).toBe(true);
  expect(last()).toEqual({ single: null, queue: null, unfinished: [] });
  upload.reject(failure("ABORTED"));
  await drained();
  expect(cancelJob).not.toHaveBeenCalled();
  expect(last().single).toBeNull();
  expect(runner.busy()).toBe(false);
});

it("opens each lecture in turn and hands every job over", async () => {
  link.open.mockResolvedValueOnce(opened(null)).mockResolvedValueOnce(opened("DOC1"));
  link.media.mockResolvedValueOnce(found(1)).mockResolvedValueOnce(found(2));
  expect(await runner.command(startQueue())).toEqual({ status: "success", accepted: null });
  expect(snapshots[0]!.queue).toMatchObject({ run, tabId: 3, running: true });
  expect(snapshots[0]!.queue!.items.map((item) => [item.title, item.phase])).toEqual([
    ["강의 1", "waiting"],
    ["강의 2", "waiting"],
  ]);
  const done = await queueDone();

  expect(link.open.mock.calls).toEqual([
    [3, run, 0],
    [3, run, 1],
  ]);
  // Each lecture is read only once the tab shows a document other than the last one.
  expect(link.media.mock.calls).toEqual([
    [{ lectureOf: 3, after: null }],
    [{ lectureOf: 3, after: "DOC1" }],
  ]);
  expect(done.queue!.items).toEqual([
    { handle: handles[0], title: "강의 1", phase: "queued", errorCode: null, jobId: "job-1", key: keyOf(1) },
    { handle: handles[1], title: "강의 2", phase: "queued", errorCode: null, jobId: "job-2", key: keyOf(2) },
  ]);
  expect(link.accept.mock.calls).toEqual([
    ["job-1", keyOf(1)],
    ["job-2", keyOf(2)],
  ]);
  expect(done.unfinished).toEqual([]);
  expect(cancelJob).not.toHaveBeenCalled();
  // The first lecture was uploaded before the second was opened.
  expect(uploadAudio.mock.invocationCallOrder[0]!).toBeLessThan(
    link.open.mock.invocationCallOrder[1]!,
  );
});

it("waits for the lecture tab to show the new lecture's player", async () => {
  vi.useFakeTimers();
  link.open.mockResolvedValue(opened("OLD"));
  link.media
    .mockResolvedValueOnce({ status: "pending" })
    .mockResolvedValueOnce({ status: "error", code: "UNSUPPORTED_MEDIA" })
    .mockResolvedValueOnce(found(1));
  await runner.command(startQueue(1));
  await until((work) => work.queue?.items[0]?.phase === "identifying");
  expect(link.media).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(MEDIA_RETRY_MS - 1);
  expect(link.media).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(link.media).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(MEDIA_RETRY_MS);
  await queueDone();
  expect(itemPhases()).toEqual(["queued"]);
});

it("gives a lecture up when its player never appears, and goes on to the next", async () => {
  vi.useFakeTimers();
  link.open.mockResolvedValue(opened(null));
  link.media.mockResolvedValue({ status: "pending" });
  await runner.command(startQueue());
  await vi.advanceTimersByTimeAsync(MEDIA_WAIT_MS + MEDIA_RETRY_MS);
  expect(last().queue!.items[0]).toMatchObject({ phase: "failed", errorCode: "UNSUPPORTED_MEDIA" });
  expect(link.open).toHaveBeenCalledWith(3, run, 1);
  expect(last().queue!.running).toBe(true);
  expect(createJob).not.toHaveBeenCalled();
});

it("waits out the tab opener's rate limit, then opens the same lecture", async () => {
  vi.useFakeTimers();
  link.open
    .mockResolvedValueOnce({ status: "error", code: "RATE_LIMITED" })
    .mockResolvedValueOnce({ status: "error", code: "RATE_LIMITED" })
    .mockResolvedValue(opened(null));
  link.media.mockResolvedValue(found(1));
  await runner.command(startQueue(1));
  await until((work) => work.queue?.items[0]?.phase === "opening");
  await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS - 1);
  expect(link.open).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(link.open).toHaveBeenCalledTimes(2);
  expect(last().queue!.items[0]!.phase).toBe("opening");
  await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MS);
  await queueDone();
  expect(link.open.mock.calls.every(([, , index]) => index === 0)).toBe(true);
  expect(itemPhases()).toEqual(["queued"]);
});

it("stops asking once a whole rate window has passed and goes on to the next lecture", async () => {
  vi.useFakeTimers();
  link.open.mockImplementation(async (_tab, _batch, index) =>
    index === 0 ? { status: "error", code: "RATE_LIMITED" } : opened(null),
  );
  link.media.mockResolvedValue(found(2));
  await runner.command(startQueue());
  await vi.advanceTimersByTimeAsync(OPEN_RATE_WINDOW_MS + RATE_LIMIT_RETRY_MS);
  await queueDone();
  expect(last().queue!.items[0]).toMatchObject({ phase: "failed", errorCode: "RATE_LIMITED" });
  expect(last().queue!.items[1]!.phase).toBe("queued");
});

it.each(["LOGIN_REQUIRED", "RELOAD_TAB", "STALE_SELECTION"] as const)(
  "a selection lost with %s fails every remaining lecture at once",
  async (code) => {
    link.open.mockResolvedValue({ status: "error", code });
    await runner.command(startQueue(3));
    const done = await queueDone();
    expect(link.open).toHaveBeenCalledOnce();
    expect(done.queue!.items.map((item) => [item.phase, item.errorCode])).toEqual([
      ["failed", code],
      ["failed", code],
      ["failed", code],
    ]);
  },
);

it("one lecture that cannot be opened does not stop the others", async () => {
  link.open
    .mockResolvedValueOnce({ status: "error", code: "TAB_OPEN_FAILED" })
    .mockResolvedValue(opened(null));
  link.media.mockResolvedValue(found(2));
  await runner.command(startQueue());
  const done = await queueDone();
  expect(done.queue!.items.map((item) => [item.phase, item.errorCode])).toEqual([
    ["failed", "TAB_OPEN_FAILED"],
    ["queued", null],
  ]);
});

it("a refusal every later lecture would meet fails the rest without opening them", async () => {
  link.open.mockResolvedValue(opened(null));
  link.media.mockResolvedValueOnce(found(1)).mockResolvedValueOnce(found(2));
  createJob.mockResolvedValueOnce(job("job-1")).mockRejectedValueOnce(failure("QUOTA_EXCEEDED"));
  await runner.command(startQueue(3));
  const done = await queueDone();
  expect(done.queue!.items.map((item) => [item.phase, item.errorCode])).toEqual([
    ["queued", null],
    ["failed", "QUOTA_EXCEEDED"],
    ["failed", "QUOTA_EXCEEDED"],
  ]);
  expect(link.open).toHaveBeenCalledTimes(2);
  expect(cancelJob).not.toHaveBeenCalled();
});

it("a failed lecture gives its use back before the next lecture is opened", async () => {
  link.open.mockResolvedValue(opened(null));
  link.media.mockResolvedValueOnce(found(1)).mockResolvedValueOnce(found(2));
  extractAudio.mockRejectedValueOnce(failure("MEDIA_NETWORK")).mockResolvedValue(new Blob(["a"]));
  const released = deferred();
  cancelJob.mockReturnValueOnce(released.promise);
  await runner.command(startQueue());
  await until((work) => work.queue?.items[0]?.phase === "failed" && work.unfinished.length === 1);
  expect(cancelJob).toHaveBeenCalledExactlyOnceWith("job-1");
  await drained();
  expect(link.open).toHaveBeenCalledOnce();

  released.resolve();
  const done = await queueDone();
  expect(link.open).toHaveBeenCalledTimes(2);
  expect(done.queue!.items.map((item) => [item.phase, item.errorCode])).toEqual([
    ["failed", "MEDIA_NETWORK"],
    ["queued", null],
  ]);
});

it("stopping cancels the lecture in flight and leaves queued jobs alone", async () => {
  link.open.mockResolvedValue(opened(null));
  link.media.mockResolvedValueOnce(found(1)).mockResolvedValueOnce(found(2));
  const upload = deferred();
  let signal: AbortSignal | undefined;
  uploadAudio.mockResolvedValueOnce(undefined).mockImplementationOnce(
    (_id: string, _audio: Blob, given: AbortSignal) => {
      signal = given;
      return upload.promise;
    },
  );
  await runner.command(startQueue(3));
  await until((work) => work.queue?.items[1]?.phase === "uploading");

  expect(await runner.command(cancel("queue"))).toEqual({ status: "success", accepted: null });
  expect(signal?.aborted).toBe(true);
  expect(cancelJob).toHaveBeenCalledExactlyOnceWith("job-2");
  expect(last().queue!.running).toBe(false);
  expect(itemPhases()).toEqual(["queued", "cancelled", "cancelled"]);
  expect(last().unfinished).toEqual([]);

  upload.reject(failure("ABORTED"));
  await drained();
  expect(itemPhases()).toEqual(["queued", "cancelled", "cancelled"]);
  expect(link.open).toHaveBeenCalledTimes(2);
  expect(link.accept).toHaveBeenCalledOnce();
  // Stopping again has nothing left to stop.
  expect(await runner.command(cancel("queue"))).toEqual({ status: "success", accepted: null });
  expect(cancelJob).toHaveBeenCalledOnce();
});

it("forgets a stopped list on dismiss, but never a running one", async () => {
  const dismiss = { version: 1, type: "CAPTION_WORK_DISMISS", run } as const;
  link.open.mockReturnValue(new Promise(() => {}));
  await runner.command(startQueue());
  await runner.command(dismiss);
  expect(last().queue?.running).toBe(true);
  await runner.command(cancel("queue"));
  await runner.command({ ...dismiss, run: other });
  expect(last().queue).not.toBeNull();
  await runner.command(dismiss);
  expect(last()).toEqual({ single: null, queue: null, unfinished: [] });
});

it("a changed sign-in ends a batch without cancelling the job in flight", async () => {
  link.open.mockResolvedValue(opened(null));
  link.media.mockResolvedValue(found(1));
  const upload = deferred();
  uploadAudio.mockReturnValue(upload.promise);
  await runner.command(startQueue());
  await until((work) => work.queue?.items[0]?.phase === "uploading");
  runner.sessionEnded();
  upload.reject(failure("ABORTED"));
  await drained();
  expect(last()).toEqual({ single: null, queue: null, unfinished: [] });
  expect(cancelJob).not.toHaveBeenCalled();
  expect(link.open).toHaveBeenCalledOnce();
});

it("lets a single lecture start once a batch has stopped", async () => {
  link.open.mockResolvedValue({ status: "error", code: "STALE_SELECTION" });
  await runner.command(startQueue());
  await queueDone();
  link.media.mockResolvedValue(found(1));
  expect((await runner.command({ ...startSingle, run: other })).status).toBe("success");
  const done = await until((work) => work.single?.phase === "queued");
  // The stopped list stays until it is dismissed or replaced.
  expect(done.queue?.run).toBe(run);
  expect((await runner.command(startQueue())).status).toBe("success");
});
