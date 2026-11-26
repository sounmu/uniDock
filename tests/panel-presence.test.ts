import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  announcePanel,
  PANEL_ALIVE_MS,
  PanelPresence,
  panelPortWindow,
} from "../src/panel-presence";
import { CAPTION_JOB_PORT } from "../src/captions/job-monitor";

function fakePort(name: string, tabId?: number) {
  const closed: (() => void)[] = [];
  const received: ((message: unknown) => void)[] = [];
  const post = vi.fn();
  const port = {
    name,
    sender: tabId === undefined ? {} : { tab: { id: tabId } },
    postMessage: post,
    onDisconnect: { addListener: (listener: () => void) => closed.push(listener) },
    onMessage: { addListener: (listener: (message: unknown) => void) => received.push(listener) },
  } as unknown as chrome.runtime.Port;
  return {
    port,
    post,
    close: () => closed.forEach((listener) => listener()),
    receive: (message: unknown) => received.forEach((listener) => listener(message)),
  };
}

let windowId: number | undefined;
let getCurrent: ReturnType<typeof vi.fn>;
let connect: ReturnType<typeof vi.fn>;
let ports: ReturnType<typeof fakePort>[];
beforeEach(() => {
  vi.useFakeTimers();
  windowId = 7;
  ports = [];
  getCurrent = vi.fn(async () => ({ id: windowId }));
  connect = vi.fn(({ name }: { name: string }) => {
    const created = fakePort(name);
    ports.push(created);
    return created.port;
  });
  vi.stubGlobal("chrome", { runtime: { connect }, windows: { getCurrent } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Resolves after the page acted on its latest window lookup. */
const looked = () => getCurrent.mock.results.at(-1)!.value as Promise<unknown>;

it("reads a window id only from a panel port name", () => {
  expect(panelPortWindow("unidock-panel:12")).toBe(12);
  for (const name of ["unidock-panel", "unidock-panel:", "unidock-panel:-1", "unidock-panel:1x", CAPTION_JOB_PORT])
    expect(panelPortWindow(name)).toBeNull();
});

it("counts a window until its last panel page closes", () => {
  const seen: number[][] = [];
  const presence = new PanelPresence((windows) => seen.push([...windows].sort()));
  const first = fakePort("unidock-panel:1");
  const second = fakePort("unidock-panel:1");
  const other = fakePort("unidock-panel:2");
  presence.connect(first.port, 1);
  presence.connect(second.port, 1);
  presence.connect(other.port, 2);
  expect(first.post).toHaveBeenCalledWith({ type: "ready" });
  expect(seen.at(-1)).toEqual([1, 2]);

  first.close();
  expect(seen.at(-1)).toEqual([1, 2]);
  second.close();
  expect(seen.at(-1)).toEqual([2]);
  other.close();
  expect(seen.at(-1)).toEqual([]);
});

it("counts a panel page whose port already closed until its disconnect arrives", () => {
  const seen: number[][] = [];
  const presence = new PanelPresence((windows) => seen.push([...windows]));
  const closing = fakePort("unidock-panel:1");
  closing.post.mockImplementation(() => {
    throw new Error("Attempting to use a disconnected port object");
  });
  presence.connect(closing.port, 1);
  expect(seen.at(-1)).toEqual([1]);
  closing.close();
  expect(seen.at(-1)).toEqual([]);
});

it("follows a panel page in a tab to the window its tab moved to", () => {
  const seen: number[][] = [];
  const presence = new PanelPresence((windows) => seen.push([...windows].sort()));
  presence.connect(fakePort("unidock-panel:1").port, 1);
  presence.connect(fakePort("unidock-panel:1", 8).port, 1);
  const reports = seen.length;

  presence.tabMoved(99, 3);
  presence.tabMoved(8, 1);
  expect(seen).toHaveLength(reports);

  presence.tabMoved(8, 2);
  expect(seen.at(-1)).toEqual([1, 2]);
});

it("names the port after the page's window and keeps the worker awake once accepted", async () => {
  announcePanel();
  await looked();
  expect(connect.mock.calls).toEqual([[{ name: "unidock-panel:7" }]]);

  vi.advanceTimersByTime(PANEL_ALIVE_MS);
  expect(ports[0]!.post).not.toHaveBeenCalled();

  ports[0]!.receive({ type: "ready" });
  vi.advanceTimersByTime(PANEL_ALIVE_MS);
  expect(ports[0]!.post.mock.calls).toEqual([[{ type: "alive" }]]);

  ports[0]!.post.mockImplementation(() => {
    throw new Error("Attempting to use a disconnected port object");
  });
  expect(() => vi.advanceTimersByTime(PANEL_ALIVE_MS)).not.toThrow();
});

it("reopens an accepted port under the window the page is in now", async () => {
  announcePanel();
  await looked();
  ports[0]!.receive({ type: "ready" });

  windowId = 9;
  ports[0]!.close();
  await looked();
  expect(connect.mock.calls.at(-1)).toEqual([{ name: "unidock-panel:9" }]);

  vi.advanceTimersByTime(PANEL_ALIVE_MS);
  expect(ports[0]!.post).not.toHaveBeenCalled();
});

it("does not retry a port the worker never accepted", async () => {
  announcePanel();
  await looked();
  ports[0]!.close();
  expect(getCurrent).toHaveBeenCalledOnce();
  expect(connect).toHaveBeenCalledOnce();
});

it("opens no port without a usable window or a live extension", async () => {
  for (const id of [undefined, -1]) {
    windowId = id;
    announcePanel();
    await looked();
  }
  expect(connect).not.toHaveBeenCalled();

  windowId = 7;
  connect.mockImplementation(() => {
    throw new Error("Extension context invalidated.");
  });
  announcePanel();
  await looked();
  expect(connect).toHaveBeenCalledOnce();
});
