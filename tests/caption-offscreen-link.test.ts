import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkerLink } from "../src/captions/work-runner";

const runner = vi.hoisted(() => ({
  link: undefined as unknown,
  command: vi.fn(),
  snapshot: vi.fn(),
  busy: vi.fn(),
  sessionEnded: vi.fn(),
}));
vi.mock("../src/captions/work-runner", () => ({
  CaptionWorkRunner: class {
    constructor(link: unknown) {
      runner.link = link;
    }
    command = runner.command;
    snapshot = runner.snapshot;
    busy = runner.busy;
    sessionEnded = runner.sessionEnded;
  },
}));

import { authorizedFetch } from "../src/caption-server-settings";
import { startCaptionWork } from "../src/captions/offscreen-link";
import { CAPTION_WORK_ALIVE_MS } from "../src/captions/work-protocol";

const run = "00000000-0000-4000-8000-000000000001";
const batch = "00000000-0000-4000-8000-0000000000b1";
const key = `unidock-${"a".repeat(40)}`;
const mediaUrl =
  "https://korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/0123456789abc/contents/media_files/screen.mp4";
const idle = { single: null, queue: null, unfinished: [] };
const grant = (token: string) => ({ id: "s".repeat(16), loginId: "l".repeat(16), accessToken: token });

interface Port {
  name: string;
  posted: unknown[];
  closed: boolean;
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  receive(message: unknown): void;
  drop(): void;
}
let ports: Port[];
const sendMessage = vi.fn();
const link = () => runner.link as WorkerLink;
const port = () => ports.at(-1)!;
/** Runs every promise continuation queued so far without moving the clock. */
const settled = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  ports = [];
  runner.snapshot.mockReturnValue(idle);
  runner.busy.mockReturnValue(false);
  runner.command.mockResolvedValue({ status: "success", accepted: null });
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: undefined,
      sendMessage,
      connect: vi.fn(({ name }: { name: string }) => {
        const messages: ((message: unknown) => void)[] = [];
        const disconnects: (() => void)[] = [];
        const created: Port = {
          name,
          posted: [],
          closed: false,
          postMessage(message) {
            if (created.closed) throw new Error("Attempting to use a disconnected port object");
            created.posted.push(message);
          },
          onMessage: { addListener: (listener) => messages.push(listener) },
          onDisconnect: { addListener: (listener) => disconnects.push(listener) },
          receive: (message) => messages.forEach((listener) => listener(message)),
          drop: () => {
            created.closed = true;
            disconnects.forEach((listener) => listener());
          },
        };
        ports.push(created);
        return created;
      }),
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("opens the work port and tells a ready worker its runs", () => {
  startCaptionWork();
  expect(ports).toHaveLength(1);
  expect(port().name).toBe("unidock-caption-work");
  expect(port().posted).toEqual([]);
  port().receive({ type: "ready" });
  expect(port().posted).toEqual([{ type: "work", ...idle }]);
});

it("reports every change of the runs on the port", () => {
  startCaptionWork();
  const work = { ...idle, unfinished: ["job_1"] };
  link().publish(work);
  expect(port().posted).toEqual([{ type: "work", ...work }]);
});

it("asks the worker for the Referer rule and waits for its answer", async () => {
  startCaptionWork();
  const added = vi.fn();
  void link().rule.add(1947001, mediaUrl).then(added);
  expect(port().posted).toEqual([{ type: "rule", id: 1947001, mediaUrl }]);
  await settled();
  expect(added).not.toHaveBeenCalled();
  port().receive({ type: "rule", id: 1947001, ok: true });
  await settled();
  expect(added).toHaveBeenCalledExactlyOnceWith(true);

  const removed = vi.fn();
  void link().rule.remove(1947001).then(removed);
  expect(port().posted.at(-1)).toEqual({ type: "unrule", id: 1947001 });
  await settled();
  expect(removed).not.toHaveBeenCalled();
  port().receive({ type: "unrule", id: 1947001 });
  await settled();
  expect(removed).toHaveBeenCalledOnce();
});

it("tells a restarted worker the rule in use and the removal it never confirmed", async () => {
  startCaptionWork();
  void link().rule.add(1947001, mediaUrl);
  port().receive({ type: "rule", id: 1947001, ok: true });
  void link().rule.add(1947002, mediaUrl);
  port().receive({ type: "rule", id: 1947002, ok: true });
  const removed = vi.fn();
  void link().rule.remove(1947002).then(removed);
  runner.snapshot.mockReturnValue({ ...idle, unfinished: ["job_1"] });

  port().drop();
  expect(ports).toHaveLength(2);
  // Nothing is sent before the new worker says it listens.
  expect(port().posted).toEqual([]);
  port().receive({ type: "ready" });
  expect(port().posted).toEqual([
    { type: "work", ...idle, unfinished: ["job_1"] },
    { type: "rule", id: 1947001, mediaUrl },
    { type: "unrule", id: 1947002 },
  ]);
  port().receive({ type: "unrule", id: 1947002 });
  await settled();
  expect(removed).toHaveBeenCalledOnce();
});

it("fails a rule request that is withdrawn before the worker answered", async () => {
  startCaptionWork();
  const added = vi.fn();
  void link().rule.add(1947001, mediaUrl).then(added);
  void link().rule.remove(1947001);
  await settled();
  expect(added).toHaveBeenCalledExactlyOnceWith(false);
});

it("runs the worker's command and answers on the port with its id", async () => {
  startCaptionWork();
  const command = { version: 1, type: "CAPTION_WORK_CANCEL", kind: "single", run };
  runner.command.mockResolvedValueOnce({ status: "success", accepted: "job_1" });
  port().receive({ type: "command", id: 7, command });
  await settled();
  expect(runner.command).toHaveBeenCalledExactlyOnceWith(command);
  expect(port().posted).toEqual([{ type: "reply", id: 7, status: "success", accepted: "job_1" }]);

  runner.command.mockRejectedValueOnce(new Error("boom"));
  port().receive({ type: "command", id: 8, command });
  await settled();
  expect(port().posted.at(-1)).toEqual({ type: "reply", id: 8, status: "error", code: "UNKNOWN" });
});

it("ends its runs when the worker says the sign-in changed, and ignores anything malformed", () => {
  startCaptionWork();
  port().receive({ type: "session-ended" });
  expect(runner.sessionEnded).toHaveBeenCalledOnce();
  port().receive({ type: "session-ended", extra: true });
  port().receive({ type: "command", id: 1, command: { version: 1, type: "CAPTION_WORK_GET" } });
  port().receive("ready");
  expect(runner.sessionEnded).toHaveBeenCalledOnce();
  expect(runner.command).not.toHaveBeenCalled();
  expect(port().posted).toEqual([]);
});

it("keeps the worker running only while work is in flight", async () => {
  startCaptionWork();
  await vi.advanceTimersByTimeAsync(CAPTION_WORK_ALIVE_MS * 2);
  expect(port().posted).toEqual([]);
  runner.busy.mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(CAPTION_WORK_ALIVE_MS - 1);
  expect(port().posted).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(port().posted).toEqual([{ type: "alive" }]);
  await vi.advanceTimersByTimeAsync(CAPTION_WORK_ALIVE_MS);
  expect(port().posted).toHaveLength(2);
  expect(CAPTION_WORK_ALIVE_MS).toBeLessThan(30_000);
});

it("reconnects across any number of worker restarts while each new worker answers", () => {
  startCaptionWork();
  for (let restart = 0; restart < 30; restart++) {
    port().drop();
    port().receive({ type: "ready" });
  }
  expect(ports).toHaveLength(31);
});

it("stops reconnecting after five drops in a row with no answer and lets waiting rule requests go", async () => {
  startCaptionWork();
  const added = vi.fn();
  const removed = vi.fn();
  void link().rule.add(1947001, mediaUrl).then(added);
  void link().rule.remove(1947002).then(removed);
  for (let drop = 0; drop < 10; drop++) port().drop();
  expect(ports).toHaveLength(6);
  await settled();
  expect(added).toHaveBeenCalledExactlyOnceWith(false);
  expect(removed).toHaveBeenCalledOnce();
  // Reporting on a port that is gone must not throw into the run.
  expect(() => link().publish(idle)).not.toThrow();
  // A request made after giving up ends at once instead of waiting for a worker.
  expect(await link().rule.add(1947003, mediaUrl)).toBe(false);
  await expect(link().rule.remove(1947003)).resolves.toBeUndefined();
});

it("gives up quietly when the extension context is gone", async () => {
  vi.mocked(chrome.runtime.connect).mockImplementation(() => {
    throw new Error("Extension context invalidated.");
  });
  expect(() => startCaptionWork()).not.toThrow();
  expect(await link().rule.add(1947001, mediaUrl)).toBe(false);
  await expect(link().rule.remove(1947001)).resolves.toBeUndefined();
});

it("asks the worker for a lecture's media and repeats the question once if the worker stopped", async () => {
  startCaptionWork();
  const media = { mediaUrl, durationS: 60, key, title: "강의", tabId: 9, documentId: "DOC1" };
  sendMessage.mockResolvedValueOnce({ status: "success", media });
  expect(await link().media({ tabId: 3 })).toEqual({ status: "success", media });
  expect(sendMessage).toHaveBeenLastCalledWith({ version: 1, type: "CAPTION_OFFSCREEN_MEDIA", tabId: 3 });

  sendMessage
    .mockRejectedValueOnce(new Error("The message port closed before a response was received."))
    .mockResolvedValueOnce({ status: "pending" });
  expect(await link().media({ lectureOf: 3, after: "OLD" })).toEqual({ status: "pending" });
  expect(sendMessage).toHaveBeenCalledTimes(3);
  expect(sendMessage).toHaveBeenLastCalledWith({
    version: 1,
    type: "CAPTION_OFFSCREEN_MEDIA",
    lectureOf: 3,
    after: "OLD",
  });

  sendMessage.mockRejectedValue(new Error("gone"));
  await expect(link().media({ tabId: 3 })).rejects.toMatchObject({ code: "UNKNOWN" });
  sendMessage.mockReset().mockResolvedValue({ status: "success", media: { ...media, mediaUrl: "https://evil.example.com/a.mp4" } });
  await expect(link().media({ tabId: 3 })).rejects.toMatchObject({ code: "UNKNOWN" });
});

it("never asks twice to open a lecture", async () => {
  startCaptionWork();
  sendMessage.mockResolvedValueOnce({ status: "success", previous: "OLD" });
  expect(await link().open(3, batch, 1)).toEqual({ status: "success", previous: "OLD" });
  expect(sendMessage).toHaveBeenLastCalledWith({
    version: 1,
    type: "CAPTION_OFFSCREEN_OPEN",
    tabId: 3,
    batch,
    index: 1,
  });
  sendMessage.mockReset().mockRejectedValue(new Error("worker stopped"));
  await expect(link().open(3, batch, 1)).rejects.toMatchObject({ code: "UNKNOWN" });
  expect(sendMessage).toHaveBeenCalledOnce();
});

it("hands an accepted job to the worker and fails with the worker's code", async () => {
  startCaptionWork();
  sendMessage.mockRejectedValueOnce(new Error("worker stopped")).mockResolvedValueOnce({ status: "success" });
  await expect(link().accept("job_1", key)).resolves.toBeUndefined();
  expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(sendMessage).toHaveBeenLastCalledWith({
    version: 1,
    type: "CAPTION_OFFSCREEN_ACCEPT",
    jobId: "job_1",
    key,
  });
  sendMessage.mockResolvedValue({ status: "error", code: "STORAGE" });
  await expect(link().accept("job_1", key)).rejects.toMatchObject({ code: "STORAGE" });
});

it("sends every server request with an access token borrowed from the worker", async () => {
  startCaptionWork();
  const requests: { url: string; authorization: string | null }[] = [];
  const answers = [
    new Response(JSON.stringify({ error: { code: "TOKEN_EXPIRED" } }), { status: 401 }),
    new Response("{}", { status: 200 }),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, authorization: new Headers(init.headers).get("Authorization") });
      return answers.shift()!;
    }),
  );
  const token = { version: 1, type: "CAPTION_OFFSCREEN_TOKEN" };
  const used = { session: "s".repeat(16), loginId: "l".repeat(16) };
  sendMessage.mockImplementation(async (request: { action: string }) =>
    request.action === "current"
      ? { status: "success", grant: grant("a".repeat(32)) }
      : { status: "success", grant: grant("b".repeat(32)) },
  );

  const response = await authorizedFetch("/v1/me", { method: "GET" });
  expect(response.status).toBe(200);
  expect(requests).toEqual([
    { url: "https://captions.test/v1/me", authorization: `Bearer ${"a".repeat(32)}` },
    { url: "https://captions.test/v1/me", authorization: `Bearer ${"b".repeat(32)}` },
  ]);
  expect(sendMessage.mock.calls.map(([request]) => request)).toEqual([
    { ...token, action: "current" },
    { ...token, action: "refresh", ...used },
  ]);
});

it("reports a sign-in the worker no longer has, and tells the worker of a token the server refused", async () => {
  startCaptionWork();
  sendMessage.mockResolvedValue({ status: "error", code: "LOGIN_REQUIRED" });
  await expect(authorizedFetch("/v1/me", { method: "GET" })).rejects.toMatchObject({
    code: "LOGIN_REQUIRED",
  });
  sendMessage.mockResolvedValue({ status: "success", grant: null });
  await expect(authorizedFetch("/v1/me", { method: "GET" })).rejects.toMatchObject({
    code: "LOGIN_REQUIRED",
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }), { status: 401 })),
  );
  sendMessage.mockReset().mockImplementation(async (request: { action: string }) => ({
    status: "success",
    grant: request.action === "current" ? grant("a".repeat(32)) : null,
  }));
  await expect(authorizedFetch("/v1/me", { method: "GET" })).rejects.toMatchObject({
    code: "LOGIN_REQUIRED",
  });
  expect(sendMessage.mock.calls.at(-1)![0]).toEqual({
    version: 1,
    type: "CAPTION_OFFSCREEN_TOKEN",
    action: "reject",
    session: "s".repeat(16),
    loginId: "l".repeat(16),
  });
});
