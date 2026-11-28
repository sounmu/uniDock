// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useActivity } from "../entrypoints/sidepanel/progress-activity";
import { announcePanel } from "../src/panel-presence";
import { deferred, mount } from "./ui-helpers";

const running = {
  version: 1,
  type: "PROGRESS_STATE",
  items: [{ kind: "captions", id: "job_1", phase: "running", percent: null, workerOffline: false }],
};
const empty = { ...running, items: [] };

function Activity() {
  const items = useActivity(true);
  return <output>{items.map(({ item }) => item.id).join(",")}</output>;
}

function setup() {
  const listeners = new Set<(message: unknown) => void>();
  const ports: { receive: (message: unknown) => void; close: () => void }[] = [];
  const sendMessage = vi.fn(async () => running);
  vi.stubGlobal("chrome", {
    windows: { getCurrent: async () => ({ id: 1 }) },
    runtime: {
      sendMessage,
      onMessage: {
        addListener: (listener: (message: unknown) => void) => listeners.add(listener),
        removeListener: (listener: (message: unknown) => void) => listeners.delete(listener),
      },
      connect: () => {
        let receive: (message: unknown) => void = () => {};
        let close = () => {};
        ports.push({ receive: (message) => receive(message), close: () => close() });
        return {
          postMessage: () => {},
          onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
          onDisconnect: { addListener: (listener: typeof close) => { close = listener; } },
        };
      },
    },
  });
  return { sendMessage, ports, publish: (message: unknown) => listeners.forEach((listener) => listener(message)) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps a newer completion when the initial progress reply arrives late", async () => {
  const worker = setup();
  const initial = deferred<typeof running>();
  worker.sendMessage.mockReturnValueOnce(initial.promise);
  const view = await mount(<Activity />);
  try {
    await act(async () => worker.publish(empty));
    await act(async () => initial.resolve(running));
    expect(view.host.textContent).toBe("");
  } finally {
    await view.unmount();
  }
});

it("reads empty progress after an accepted panel port reconnects", async () => {
  vi.useFakeTimers();
  const worker = setup();
  const view = await mount(<Activity />);
  try {
    announcePanel();
    await act(async () => {});
    await act(async () => worker.ports[0]?.receive({ type: "ready" }));
    expect(view.host.textContent).toBe("job_1");
    worker.sendMessage.mockResolvedValue(empty);
    await act(async () => worker.ports[0]?.close());
    await act(async () => worker.ports[1]?.receive({ type: "ready" }));
    expect(view.host.textContent).toBe("");
  } finally {
    await view.unmount();
  }
});
