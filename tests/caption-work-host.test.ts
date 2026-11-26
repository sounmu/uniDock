import { afterEach, beforeEach, expect, it, vi } from "vitest";

const cancelJob = vi.hoisted(() => vi.fn());
const captionJobKey = vi.hoisted(() => vi.fn());
const saveActiveJob = vi.hoisted(() => vi.fn());
const identifyMedia = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ current: vi.fn(), refresh: vi.fn(), reject: vi.fn() }));
vi.mock("../src/captions/job-client", async (original) => ({
  ...(await original<object>()),
  cancelJob,
}));
vi.mock("../src/captions/job-record", async (original) => ({
  ...(await original<object>()),
  captionJobKey,
  saveActiveJob,
}));
vi.mock("../src/captions/media-source", async (original) => ({
  ...(await original<object>()),
  identifyMedia,
}));
vi.mock("../src/caption-server-settings", async (original) => ({
  ...(await original<object>()),
  storedSessionAccess: session,
}));

import { MediaSourceError } from "../src/captions/media-source";
import { lectureTabKey } from "../src/open-tab";
import {
  COMMAND_TIMEOUT_MS,
  CaptionWorkHost,
  DOCUMENT_CONNECT_MS,
  OPEN_TIMEOUT_MS,
} from "../src/captions/work-host";
import {
  isCaptionWorkState,
  type CommandOutcome,
  type QueueWork,
  type RunCommand,
  type SingleWork,
  type WorkPortCommand,
  type WorkRuns,
} from "../src/captions/work-protocol";

const run = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const batch = "00000000-0000-4000-8000-0000000000b1";
const handle = "00000000-0000-4000-8000-0000000000a1";
const key = `unidock-${"a".repeat(40)}`;
const mediaUrl =
  "https://korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/0123456789abc/contents/media_files/screen.mp4";
const single = (phase: SingleWork["phase"], id = run): SingleWork => ({
  run: id,
  tabId: 3,
  documentId: "DOC1",
  phase,
  jobId: phase === "identifying" ? null : "job_1",
  key: phase === "identifying" ? null : key,
  errorCode: phase === "failed" ? "MEDIA_DENIED" : null,
  title: "3주차 강의",
  durationS: 60,
});
const queue = (running: boolean, phases: QueueWork["items"][number]["phase"][]): QueueWork => ({
  run: batch,
  tabId: 3,
  running,
  items: phases.map((phase, index) => ({
    handle: handle.slice(0, -1) + index,
    title: `강의 ${index + 1}`,
    phase,
    errorCode: null,
    jobId: phase === "queued" ? `job_q${index}` : null,
    key: null,
  })),
});
const startSingle = { version: 1, type: "CAPTION_WORK_START", kind: "single", run, tabId: 3 } as const;
const cancelSingle = { version: 1, type: "CAPTION_WORK_CANCEL", kind: "single", run } as const;
const get = { version: 1, type: "CAPTION_WORK_GET" } as const;

/** Runs every promise continuation queued so far; no timer is involved. */
const drained = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The offscreen document's end of the work port, played by the test. */
function documentPort() {
  const messages: ((message: unknown) => void)[] = [];
  const disconnects: (() => void)[] = [];
  const posted: WorkPortCommand[] = [];
  const document = {
    posted,
    /**
     * What the document does with a command: the runs it then reports, and its
     * answer. By default it takes a start and has that run in flight.
     */
    answer: ((command) =>
      command.type === "CAPTION_WORK_START"
        ? {
            work: { single: single("identifying", command.run) },
            outcome: { status: "success", accepted: null },
          }
        : { outcome: { status: "success", accepted: null } }) as
      | ((command: RunCommand) => {
          work?: Partial<WorkRuns> & { unfinished?: string[] };
          outcome: CommandOutcome;
        })
      | undefined,
    port: {
      postMessage: (message: WorkPortCommand) => {
        posted.push(message);
        if (message.type !== "command" || !document.answer) return;
        const { work, outcome } = document.answer(message.command);
        if (work) document.report(work);
        document.send({ type: "reply", id: message.id, ...outcome });
      },
      onMessage: { addListener: (listener: (message: unknown) => void) => messages.push(listener) },
      onDisconnect: { addListener: (listener: () => void) => disconnects.push(listener) },
    },
    send: (message: unknown) => messages.forEach((listener) => listener(message)),
    report: (work: Partial<WorkRuns> & { unfinished?: string[] }) =>
      document.send({ type: "work", single: null, queue: null, unfinished: [], ...work }),
    drop: () => disconnects.forEach((listener) => listener()),
    commands: () =>
      posted.flatMap((message) => (message.type === "command" ? [message.command] : [])),
  };
  return document;
}
type Document = ReturnType<typeof documentPort>;

let host: CaptionWorkHost;
let documents: Document[];
let connectOnCreate: boolean;
let broadcasts: unknown[];
let lectureTab: number | undefined;
let tabUrl: string | undefined;
const createDocument = vi.fn();
const closeDocument = vi.fn();
const tabMessage = vi.fn();
const monitor = { track: vi.fn() };
const rules = { add: vi.fn(), remove: vi.fn(), clear: vi.fn() };
const onWork = vi.fn();
const current = () => documents.at(-1)!;
const connect = (to: CaptionWorkHost = host) => {
  const document = documentPort();
  documents.push(document);
  to.connect(document.port as unknown as chrome.runtime.Port);
  return document;
};

beforeEach(() => {
  documents = [];
  broadcasts = [];
  connectOnCreate = true;
  lectureTab = 9;
  tabUrl = "https://mylms.korea.ac.kr/courses/1/modules";
  createDocument.mockImplementation(async () => {
    if (connectOnCreate) connect();
  });
  closeDocument.mockResolvedValue(undefined);
  rules.add.mockResolvedValue(true);
  rules.remove.mockResolvedValue(undefined);
  rules.clear.mockResolvedValue(undefined);
  cancelJob.mockResolvedValue(undefined);
  saveActiveJob.mockResolvedValue(undefined);
  captionJobKey.mockResolvedValue(key);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "ext",
      sendMessage: vi.fn(async (message: unknown) => {
        broadcasts.push(message);
      }),
    },
    offscreen: { createDocument, closeDocument },
    tabs: {
      get: vi.fn(async () => {
        if (!tabUrl) throw new Error("no tab");
        return { id: 3, url: tabUrl };
      }),
      sendMessage: tabMessage,
    },
    storage: {
      session: {
        get: vi.fn(async (name: string) =>
          name === lectureTabKey(3) && lectureTab !== undefined ? { [name]: lectureTab } : {},
        ),
      },
    },
  });
  host = new CaptionWorkHost({ monitor, rules, onWork });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("creates the document for a start, with a reason that fits, and passes the command on", async () => {
  createDocument.mockImplementationOnce(async () => {
    connect().answer = () => ({
      work: { single: single("identifying"), queue: null },
      outcome: { status: "success", accepted: null },
    });
  });
  const reply = await host.command(startSingle);

  expect(createDocument).toHaveBeenCalledExactlyOnceWith({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: expect.stringContaining("Blob"),
  });
  expect(current().posted[0]).toEqual({ type: "ready" });
  expect(current().commands()).toEqual([startSingle]);
  expect(reply).toEqual({ status: "success", state: host.state(), accepted: null });
  expect(host.state().single).toEqual(single("identifying"));
  expect(isCaptionWorkState(host.state())).toBe(true);
  // Every panel page hears of the change, and so does the progress hub.
  expect(broadcasts).toEqual([host.state()]);
  expect(onWork).toHaveBeenLastCalledWith({ single: single("identifying"), queue: null });
  expect(closeDocument).not.toHaveBeenCalled();
});

it("answers a read and handles a cancel or dismiss without creating a document", async () => {
  expect(await host.command(get)).toEqual({ status: "success", state: host.state(), accepted: null });
  expect((await host.command(cancelSingle)).status).toBe("success");
  expect((await host.command({ version: 1, type: "CAPTION_WORK_DISMISS", run: batch })).status).toBe(
    "success",
  );
  expect(createDocument).not.toHaveBeenCalled();
  expect(host.state()).toMatchObject({ revision: 0, single: null, queue: null });
  expect(broadcasts).toEqual([]);
});

it("closes the document as soon as it reports nothing in flight, and opens a new one for the next start", async () => {
  await host.command(startSingle);
  const first = current();
  first.report({ single: single("uploading"), unfinished: ["job_1"] });
  await drained();
  expect(closeDocument).not.toHaveBeenCalled();

  first.report({ single: single("queued") });
  await drained();
  expect(closeDocument).toHaveBeenCalledOnce();
  expect(rules.clear).toHaveBeenCalledOnce();
  // The closed document's own disconnect arrives late and means nothing.
  first.drop();
  expect(cancelJob).not.toHaveBeenCalled();
  expect(host.state().single).toEqual(single("queued"));

  await host.command({ ...startSingle, run: other });
  expect(createDocument).toHaveBeenCalledTimes(2);
  expect(current()).not.toBe(first);
});

it("keeps the document while a cancelled job is still being released", async () => {
  await host.command(startSingle);
  current().report({ single: single("failed"), unfinished: ["job_1"] });
  await drained();
  expect(closeDocument).not.toHaveBeenCalled();
  current().report({ single: single("failed") });
  await drained();
  expect(closeDocument).toHaveBeenCalledOnce();
});

it("closes a document that was created but given nothing to do", async () => {
  createDocument.mockImplementationOnce(async () => {
    connect().answer = () => ({ outcome: { status: "error", code: "ACTIVE_JOB_EXISTS" } });
  });
  expect(await host.command(startSingle)).toEqual({ status: "error", code: "ACTIVE_JOB_EXISTS" });
  await drained();
  expect(closeDocument).toHaveBeenCalledOnce();
});

it("keeps showing what a closed document left, beside the next document's runs", async () => {
  await host.command(startSingle);
  current().report({ queue: queue(false, ["queued", "failed"]) });
  await drained();
  expect(closeDocument).toHaveBeenCalledOnce();
  expect(host.state().queue).toEqual(queue(false, ["queued", "failed"]));

  await host.command({ ...startSingle, run: other });
  current().report({ single: single("uploading", other), unfinished: ["job_1"] });
  expect(host.state().single?.run).toBe(other);
  expect(host.state().queue).toEqual(queue(false, ["queued", "failed"]));
  // A list the new document starts replaces the one left behind.
  current().report({ queue: { ...queue(true, ["waiting"]), run: other } });
  expect(host.state().queue?.run).toBe(other);
});

it("drops a run the connected document stops reporting", async () => {
  await host.command(startSingle);
  current().report({ single: single("uploading"), queue: queue(true, ["opening"]), unfinished: ["job_1"] });
  current().report({ queue: queue(true, ["opening"]) });
  expect(host.state().single).toBeNull();
  current().report({ unfinished: ["job_1"] });
  expect(host.state().queue).toBeNull();
});

it("forgets what an earlier document left on cancel or dismiss, naming an accepted job", async () => {
  await host.command(startSingle);
  current().report({ single: single("queued"), queue: queue(false, ["queued"]) });
  await drained();
  expect(closeDocument).toHaveBeenCalledOnce();

  expect(await host.command({ ...cancelSingle, run: other })).toMatchObject({ accepted: null });
  expect(host.state().single).not.toBeNull();
  expect(await host.command(cancelSingle)).toMatchObject({ status: "success", accepted: "job_1" });
  expect(host.state().single).toBeNull();
  expect(
    await host.command({ version: 1, type: "CAPTION_WORK_CANCEL", kind: "queue", run: batch }),
  ).toMatchObject({ status: "success", accepted: null });
  expect(host.state().queue).not.toBeNull();
  await host.command({ version: 1, type: "CAPTION_WORK_DISMISS", run: batch });
  expect(host.state().queue).toBeNull();
  expect(createDocument).toHaveBeenCalledOnce();
});

it("forgets a failed run left behind without naming a job", async () => {
  await host.command(startSingle);
  current().report({ single: single("failed") });
  await drained();
  expect(await host.command(cancelSingle)).toMatchObject({ status: "success", accepted: null });
  expect(host.state().single).toBeNull();
});

it("passes a cancel to the live document and trusts what it then reports", async () => {
  await host.command(startSingle);
  current().report({ single: single("uploading"), unfinished: ["job_1"] });
  current().answer = () => ({ work: {}, outcome: { status: "success", accepted: null } });
  expect(await host.command(cancelSingle)).toMatchObject({ status: "success", accepted: null });
  expect(current().commands()).toEqual([startSingle, cancelSingle]);
  expect(host.state().single).toBeNull();
  // The document cancels its own unfinished job; the worker does not.
  expect(cancelJob).not.toHaveBeenCalled();
});

it("cancels the unfinished jobs of a document that went away on its own", async () => {
  await host.command(startSingle);
  current().report({
    single: single("uploading"),
    queue: queue(true, ["queued", "extracting", "waiting"]),
    unfinished: ["job_1", "job_2"],
  });
  current().drop();

  expect(cancelJob.mock.calls).toEqual([["job_1"], ["job_2"]]);
  expect(rules.clear).toHaveBeenCalledOnce();
  expect(host.state().single).toMatchObject({ phase: "failed", errorCode: "UNKNOWN" });
  expect(host.state().queue).toMatchObject({ running: false });
  expect(host.state().queue!.items.map((item) => [item.phase, item.errorCode])).toEqual([
    ["queued", null],
    ["failed", "UNKNOWN"],
    ["cancelled", null],
  ]);
  expect(isCaptionWorkState(broadcasts.at(-1))).toBe(true);
  expect(closeDocument).not.toHaveBeenCalled();
  // The next start gets a fresh document.
  await host.command({ ...startSingle, run: other });
  expect(createDocument).toHaveBeenCalledTimes(2);
});

it("fails a command the crashed document never answered", async () => {
  await host.command(startSingle);
  current().report({ single: single("uploading"), unfinished: ["job_1"] });
  current().answer = undefined;
  const pending = host.command(cancelSingle);
  await drained();
  current().drop();
  expect(await pending).toEqual({ status: "error", code: "UNAVAILABLE" });
});

it("a restarted worker learns the runs from the document that lives on", async () => {
  await host.command(startSingle);
  const restarted = new CaptionWorkHost({ monitor, rules, onWork });
  expect(restarted.state().instance).not.toBe(host.state().instance);
  expect(restarted.state().single).toBeNull();
  const document = connect(restarted);
  expect(document.posted).toEqual([{ type: "ready" }]);
  document.report({ single: single("uploading"), unfinished: ["job_1"] });

  expect(restarted.state().single).toEqual(single("uploading"));
  document.answer = () => ({ outcome: { status: "error", code: "ACTIVE_JOB_EXISTS" } });
  expect(await restarted.command({ ...startSingle, run: other })).toEqual({
    status: "error",
    code: "ACTIVE_JOB_EXISTS",
  });
  // It talks to that document; no second one is created.
  expect(document.commands()).toEqual([{ ...startSingle, run: other }]);
  expect(createDocument).toHaveBeenCalledOnce();
  // And it knows which job to cancel if the document now dies.
  document.drop();
  expect(cancelJob).toHaveBeenCalledExactlyOnceWith("job_1");
});

it("waits for an existing document's port instead of creating a second document", async () => {
  createDocument.mockRejectedValueOnce(new Error("Only a single offscreen document may be created."));
  const reply = host.command(startSingle);
  await drained();
  expect(documents).toHaveLength(0);
  connect().answer = () => ({
    work: { single: single("identifying") },
    outcome: { status: "success", accepted: null },
  });
  expect((await reply).status).toBe("success");
  expect(createDocument).toHaveBeenCalledOnce();
  expect(closeDocument).not.toHaveBeenCalled();
});

it("replaces a document that never reaches the worker, then gives up", async () => {
  vi.useFakeTimers();
  connectOnCreate = false;
  const reply = host.command(startSingle);
  await vi.advanceTimersByTimeAsync(DOCUMENT_CONNECT_MS - 1);
  expect(closeDocument).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(closeDocument).toHaveBeenCalledOnce();
  expect(createDocument).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(DOCUMENT_CONNECT_MS);
  expect(await reply).toEqual({ status: "error", code: "UNAVAILABLE" });
  expect(createDocument).toHaveBeenCalledTimes(2);
});

it("stops waiting for a document that does not answer a command", async () => {
  vi.useFakeTimers();
  createDocument.mockImplementationOnce(async () => {
    connect().answer = undefined;
  });
  const reply = host.command(startSingle);
  await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
  expect(await reply).toEqual({ status: "error", code: "TIMEOUT" });
  // A late answer to the abandoned command is ignored.
  current().send({ type: "reply", id: 1, status: "success", accepted: null });
});

it("runs commands one after another", async () => {
  let release!: () => void;
  createDocument.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = () => {
          connect().answer = () => ({ work: {}, outcome: { status: "success", accepted: null } });
          resolve();
        };
      }),
  );
  const first = host.command(startSingle);
  const second = host.command(cancelSingle);
  await drained();
  expect(documents).toHaveLength(0);
  release();
  await Promise.all([first, second]);
  expect(current().commands()).toEqual([startSingle, cancelSingle]);
});

it("installs and removes the document's Referer rule and tells it the outcome", async () => {
  await host.command(startSingle);
  const document = current();
  document.report({ single: single("extracting"), unfinished: ["job_1"] });
  document.send({ type: "rule", id: 1947001, mediaUrl });
  await drained();
  expect(rules.add).toHaveBeenCalledExactlyOnceWith(1947001, mediaUrl);
  expect(document.posted.at(-1)).toEqual({ type: "rule", id: 1947001, ok: true });
  rules.add.mockResolvedValueOnce(false);
  document.send({ type: "rule", id: 1947002, mediaUrl });
  await drained();
  expect(document.posted.at(-1)).toEqual({ type: "rule", id: 1947002, ok: false });
  document.send({ type: "unrule", id: 1947001 });
  await drained();
  expect(rules.remove).toHaveBeenCalledExactlyOnceWith(1947001);
  expect(document.posted.at(-1)).toEqual({ type: "unrule", id: 1947001 });
});

it("ignores malformed port messages and messages from a port it replaced", async () => {
  await host.command(startSingle);
  const stale = current();
  stale.report({ single: single("uploading"), unfinished: ["job_1"] });
  const live = connect();
  stale.report({ single: single("failed") });
  stale.drop();
  expect(host.state().single).toEqual(single("uploading"));
  expect(cancelJob).not.toHaveBeenCalled();
  live.send({ type: "work", single: { ...single("uploading"), url: mediaUrl }, queue: null, unfinished: [] });
  live.send({ type: "alive" });
  live.send("alive");
  expect(host.state().single).toEqual(single("uploading"));
});

it("broadcasts only real changes, with a rising revision", async () => {
  await host.command(startSingle);
  current().report({ single: single("extracting"), unfinished: ["job_1"] });
  current().report({ single: single("extracting"), unfinished: ["job_1"] });
  current().report({ single: single("uploading"), unfinished: ["job_1"] });
  expect(broadcasts.map((state) => (state as { revision: number }).revision)).toEqual([1, 2, 3]);
  expect(
    broadcasts.map((state) => (state as { single: SingleWork }).single.phase),
  ).toEqual(["identifying", "extracting", "uploading"]);
  expect(onWork).toHaveBeenCalledTimes(3);
});

it("a broadcast nobody hears, or that cannot be sent, breaks nothing", async () => {
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(() => {
    throw new Error("no receiver");
  });
  await host.command(startSingle);
  expect(() => current().report({ single: single("extracting"), unfinished: ["job_1"] })).not.toThrow();
  expect(host.state().single?.phase).toBe("extracting");
});

it("a changed sign-in stops the document and forgets every run without cancelling a job", async () => {
  await host.command(startSingle);
  const document = current();
  document.report({ single: single("uploading"), queue: queue(false, ["queued"]), unfinished: ["job_1"] });
  host.sessionEnded();
  expect(document.posted.at(-1)).toEqual({ type: "session-ended" });
  expect(host.state()).toMatchObject({ single: null, queue: null });
  expect(broadcasts.at(-1)).toMatchObject({ single: null, queue: null });
  document.report({});
  document.drop();
  expect(cancelJob).not.toHaveBeenCalled();
});

it("finds a tab's media and hands the document a job key, never the content id", async () => {
  identifyMedia.mockResolvedValue({
    mediaUrl,
    durationS: 60,
    contentId: "0123456789abc",
    title: "가".repeat(400),
    tabId: 3,
    windowId: 1,
    documentId: "DOC1",
  });
  const reply = await host.request({ version: 1, type: "CAPTION_OFFSCREEN_MEDIA", tabId: 3 });
  expect(identifyMedia).toHaveBeenCalledWith(3);
  expect(captionJobKey).toHaveBeenCalledWith("0123456789abc");
  expect(reply).toEqual({
    status: "success",
    media: { mediaUrl, durationS: 60, key, title: "가".repeat(300), tabId: 3, documentId: "DOC1" },
  });

  identifyMedia.mockRejectedValue(new MediaSourceError("ACTIVATE_TAB"));
  expect(await host.request({ version: 1, type: "CAPTION_OFFSCREEN_MEDIA", tabId: 3 })).toEqual({
    status: "error",
    code: "ACTIVATE_TAB",
  });
});

it("answers pending until the lecture tab shows another document", async () => {
  const ask = (after: string | null) =>
    host.request({ version: 1, type: "CAPTION_OFFSCREEN_MEDIA", lectureOf: 3, after });
  const shown = (documentId: string) => ({
    mediaUrl,
    durationS: 60,
    contentId: "0123456789abc",
    title: "강의",
    tabId: 9,
    windowId: 1,
    documentId,
  });
  identifyMedia.mockResolvedValue(shown("OLD"));
  expect(await ask("OLD")).toEqual({ status: "pending" });
  expect(identifyMedia).toHaveBeenCalledWith(9);
  identifyMedia.mockResolvedValue(shown("NEW"));
  expect(await ask("OLD")).toMatchObject({ status: "success", media: { documentId: "NEW", tabId: 9 } });
  expect(await ask(null)).toMatchObject({ status: "success" });
  identifyMedia.mockRejectedValue(new MediaSourceError("UNSUPPORTED_MEDIA"));
  expect(await ask("OLD")).toEqual({ status: "pending" });
  identifyMedia.mockResolvedValue(shown("NEW"));
  captionJobKey.mockRejectedValueOnce(new Error("storage"));
  expect(await ask("OLD")).toEqual({ status: "pending" });
  lectureTab = undefined;
  identifyMedia.mockClear();
  expect(await ask("OLD")).toEqual({ status: "pending" });
  expect(identifyMedia).not.toHaveBeenCalled();
});

it("asks the list tab to open an admitted lecture and reports what the lecture tab showed before", async () => {
  const open = () =>
    host.request({ version: 1, type: "CAPTION_OFFSCREEN_OPEN", tabId: 3, batch, index: 1 });
  identifyMedia.mockResolvedValue({ documentId: "OLD" });
  tabMessage.mockResolvedValue({ status: "success", opened: true });
  expect(await open()).toEqual({ status: "success", previous: "OLD" });
  expect(tabMessage).toHaveBeenCalledExactlyOnceWith(
    3,
    { version: 1, type: "CAPTION_BATCH_OPEN", batch, index: 1 },
    { frameId: 0 },
  );

  identifyMedia.mockRejectedValue(new MediaSourceError("UNSUPPORTED_MEDIA"));
  expect(await open()).toEqual({ status: "success", previous: null });
  tabMessage.mockResolvedValue({ status: "error", code: "RATE_LIMITED" });
  expect(await open()).toEqual({ status: "error", code: "RATE_LIMITED" });
  tabMessage.mockResolvedValue({ status: "success", batch });
  expect(await open()).toEqual({ status: "error", code: "INVALID_RESPONSE" });
  tabMessage.mockRejectedValue(new Error("Receiving end does not exist."));
  expect(await open()).toEqual({ status: "error", code: "RELOAD_TAB" });
});

it("opens nothing from a tab that is not an LMS page any more", async () => {
  const open = () =>
    host.request({ version: 1, type: "CAPTION_OFFSCREEN_OPEN", tabId: 3, batch, index: 0 });
  tabUrl = "https://example.com/";
  expect(await open()).toEqual({ status: "error", code: "RELOAD_TAB" });
  tabUrl = undefined;
  expect(await open()).toEqual({ status: "error", code: "RELOAD_TAB" });
  expect(tabMessage).not.toHaveBeenCalled();
});

it("stops waiting for a list tab that never answers", async () => {
  vi.useFakeTimers();
  identifyMedia.mockRejectedValue(new MediaSourceError("UNSUPPORTED_MEDIA"));
  tabMessage.mockReturnValue(new Promise(() => {}));
  const reply = host.request({ version: 1, type: "CAPTION_OFFSCREEN_OPEN", tabId: 3, batch, index: 0 });
  await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
  expect(await reply).toEqual({ status: "error", code: "TIMEOUT" });
});

it("records an accepted job and has the monitor follow it", async () => {
  const accept = { version: 1, type: "CAPTION_OFFSCREEN_ACCEPT", jobId: "job_1", key } as const;
  expect(await host.request(accept)).toEqual({ status: "success" });
  expect(saveActiveJob).toHaveBeenCalledExactlyOnceWith({ jobId: "job_1", key });
  expect(monitor.track).toHaveBeenCalledExactlyOnceWith("job_1", key);
  expect(saveActiveJob.mock.invocationCallOrder[0]!).toBeLessThan(
    monitor.track.mock.invocationCallOrder[0]!,
  );
  saveActiveJob.mockRejectedValue(new Error("quota"));
  expect(await host.request(accept)).toEqual({ status: "error", code: "STORAGE" });
  expect(monitor.track).toHaveBeenCalledOnce();
});

it("lends the document an access token and nothing else of the session", async () => {
  const stored = {
    id: "s".repeat(16),
    loginId: "l".repeat(16),
    accessToken: "a".repeat(32),
    accessExpiresAt: "2099-01-01T00:00:00Z",
    refreshToken: "r".repeat(32),
    refreshExpiresAt: "2099-02-01T00:00:00Z",
    email: "student@example.com",
  };
  const grant = { id: stored.id, loginId: stored.loginId, accessToken: stored.accessToken };
  const token = { version: 1, type: "CAPTION_OFFSCREEN_TOKEN" } as const;
  const used = { session: stored.id, loginId: stored.loginId };

  session.current.mockResolvedValue(stored);
  expect(await host.request({ ...token, action: "current" })).toEqual({ status: "success", grant });
  session.refresh.mockResolvedValue({ ...stored, accessToken: "b".repeat(32) });
  expect(await host.request({ ...token, action: "refresh", ...used })).toEqual({
    status: "success",
    grant: { ...grant, accessToken: "b".repeat(32) },
  });
  expect(session.refresh).toHaveBeenCalledWith({ id: stored.id, loginId: stored.loginId });
  session.refresh.mockResolvedValue(null);
  expect(await host.request({ ...token, action: "refresh", ...used })).toEqual({
    status: "success",
    grant: null,
  });
  expect(await host.request({ ...token, action: "reject", ...used })).toEqual({
    status: "success",
    grant: null,
  });
  expect(session.reject).toHaveBeenCalledExactlyOnceWith({ id: stored.id, loginId: stored.loginId });
  session.current.mockRejectedValue(Object.assign(new Error("x"), { code: "LOGIN_REQUIRED" }));
  expect(await host.request({ ...token, action: "current" })).toEqual({
    status: "error",
    code: "LOGIN_REQUIRED",
  });
});
