import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CaptionWorkState } from "../src/captions/work-protocol";

const instance = "00000000-0000-4000-8000-000000000001";
const restarted = "00000000-0000-4000-8000-000000000002";
const run = "00000000-0000-4000-8000-0000000000c1";
const state = (revision: number, phase: "identifying" | "uploading" = "uploading", of = instance) =>
  ({
    version: 1,
    type: "CAPTION_WORK_STATE",
    instance: of,
    revision,
    single: {
      run,
      tabId: 3,
      documentId: null,
      phase,
      jobId: null,
      key: null,
      errorCode: null,
      title: "",
      durationS: 0,
    },
    queue: null,
  }) satisfies CaptionWorkState;
const worker = { id: "ext" };
const get = { version: 1, type: "CAPTION_WORK_GET" } as const;

type Listener = (message: unknown, sender: chrome.runtime.MessageSender) => void;
let listeners: Listener[];
const sendMessage = vi.fn();
const client = () => import("../src/captions/work-client");

beforeEach(() => {
  vi.resetModules();
  listeners = [];
  sendMessage.mockResolvedValue(undefined);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "ext",
      getURL: (path: string) => `chrome-extension://ext/${path}`,
      sendMessage,
      onMessage: {
        addListener: (listener: Listener) => listeners.push(listener),
        removeListener: (listener: Listener) => listeners.splice(listeners.indexOf(listener), 1),
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("asks the worker once when a page starts listening, so work that began without it shows", async () => {
  const { subscribeWork, workState } = await client();
  expect(workState()).toMatchObject({ single: null, queue: null });
  sendMessage.mockResolvedValue({ status: "success", state: state(4), accepted: null });
  const changed = vi.fn();
  const second = vi.fn();
  subscribeWork(changed);
  subscribeWork(second);
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(get);
  expect(listeners).toHaveLength(1);
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(second).toHaveBeenCalledOnce();
  expect(workState()).toEqual(state(4));
});

it("takes the worker's broadcasts and nobody else's", async () => {
  const { subscribeWork, workState } = await client();
  const changed = vi.fn();
  subscribeWork(changed);
  listeners[0]!(state(1), worker);
  expect(workState()).toEqual(state(1));
  expect(changed).toHaveBeenCalledOnce();

  listeners[0]!(state(2), { id: "ext", url: "chrome-extension://ext/offscreen.html" });
  listeners[0]!(state(2), { id: "ext", tab: { id: 5 } as chrome.tabs.Tab });
  listeners[0]!(state(2), { id: "other" });
  listeners[0]!({ ...state(2), extra: true }, worker);
  listeners[0]!({ version: 1, type: "PROGRESS_STATE", items: [] }, worker);
  expect(workState()).toEqual(state(1));
  expect(changed).toHaveBeenCalledOnce();
});

it("never lets a late copy replace a newer state, but follows a restarted worker", async () => {
  const { subscribeWork, workState } = await client();
  subscribeWork(() => {});
  listeners[0]!(state(5), worker);
  listeners[0]!(state(4, "identifying"), worker);
  listeners[0]!(state(5, "identifying"), worker);
  expect(workState()).toEqual(state(5));
  listeners[0]!(state(1, "identifying", restarted), worker);
  expect(workState()).toEqual(state(1, "identifying", restarted));
});

it("takes the state in a command's answer and reports failures as error replies", async () => {
  const { workCommand, workState } = await client();
  const start = { version: 1, type: "CAPTION_WORK_START", kind: "single", run, tabId: 3 } as const;
  sendMessage.mockResolvedValueOnce({ status: "success", state: state(2), accepted: null });
  expect(await workCommand(start)).toEqual({ status: "success", state: state(2), accepted: null });
  expect(sendMessage).toHaveBeenLastCalledWith(start);
  expect(workState()).toEqual(state(2));

  sendMessage.mockResolvedValueOnce({ status: "error", code: "UNAVAILABLE" });
  expect(await workCommand(start)).toEqual({ status: "error", code: "UNAVAILABLE" });
  sendMessage.mockResolvedValueOnce({ status: "success", state: { ...state(3), revision: -1 } });
  expect(await workCommand(start)).toEqual({ status: "error", code: "UNKNOWN" });
  sendMessage.mockRejectedValueOnce(new Error("Could not establish connection."));
  expect(await workCommand(start)).toEqual({ status: "error", code: "UNKNOWN" });
  expect(workState()).toEqual(state(2));
});

it("stops listening when the last subscriber leaves and asks again for the next one", async () => {
  const { subscribeWork } = await client();
  const first = subscribeWork(() => {});
  const second = subscribeWork(() => {});
  first();
  expect(listeners).toHaveLength(1);
  second();
  expect(listeners).toHaveLength(0);
  second();
  subscribeWork(() => {});
  expect(listeners).toHaveLength(1);
  expect(sendMessage).toHaveBeenCalledTimes(2);
});

it("does nothing where the extension runtime is missing", async () => {
  vi.stubGlobal("chrome", undefined);
  const { subscribeWork, workCommand, workState } = await client();
  const leave = subscribeWork(() => {});
  expect(() => leave()).not.toThrow();
  expect(await workCommand(get)).toEqual({ status: "error", code: "UNKNOWN" });
  expect(workState().single).toBeNull();
});
