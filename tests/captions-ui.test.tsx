// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CaptionResult } from "../src/captions/service";
import { mount, click, deferred } from "./ui-helpers";
const detect = vi.hoisted(() => vi.fn());
vi.mock("../src/captions/service", () => ({ detectCaptions: detect }));
import { CaptionsPanel } from "../entrypoints/sidepanel/CaptionsPanel";
const updated = { addListener: vi.fn(), removeListener: vi.fn() };
const activated = { addListener: vi.fn(), removeListener: vi.fn() };
const removed = { addListener: vi.fn(), removeListener: vi.fn() };
let ui: Awaited<ReturnType<typeof mount>>;
const result: CaptionResult = {
  status: "success",
  blocked: false,
  captions: [
    {
      sourceUrl: "https://kucom.korea.ac.kr/em/lecture",
      pageTitle: "강의",
      extractedAt: "2026-09-12T06:00:00Z",
      label: "강의 자막",
      source: "caption_script_dom",
      itemCount: 1,
      items: [{ index: 0, time: "00:01", text: "본문" }],
    },
  ],
};
beforeEach(() => {
  vi.stubGlobal("chrome", {
    tabs: { onUpdated: updated, onActivated: activated, onRemoved: removed },
  });
  detect.mockImplementation(async (onTarget) => {
    onTarget({ tabId: 7, windowId: 1 });
    return result;
  });
});
afterEach(async () => {
  await ui?.unmount();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});
it("keeps captions across unrelated updates and activation in another window", async () => {
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  await act(async () => {
    updated.addListener.mock.calls[0]![0](999, { status: "loading" });
    updated.addListener.mock.calls[0]![0](7, {
      title: "재생 중",
      audible: true,
      status: "complete",
    });
    activated.addListener.mock.calls[0]![0]({ tabId: 999, windowId: 2 });
  });
  expect(document.querySelectorAll("li")).toHaveLength(1);
});
it.each(["reload", "url", "switch", "close"])(
  "clears captions on target %s",
  async (kind) => {
    ui = await mount(<CaptionsPanel />);
    await click("자막 감지");
    await act(async () => {
      if (kind === "reload")
        updated.addListener.mock.calls[0]![0](7, { status: "loading" });
      if (kind === "url")
        updated.addListener.mock.calls[0]![0](7, {
          url: "https://kucom.korea.ac.kr/em/other",
        });
      if (kind === "switch")
        activated.addListener.mock.calls[0]![0]({ tabId: 8, windowId: 1 });
      if (kind === "close") removed.addListener.mock.calls[0]![0](7);
    });
    expect(document.querySelectorAll("li")).toHaveLength(0);
  },
);
it("discards a late detection after its target reloads", async () => {
  const pending = deferred<CaptionResult>();
  detect.mockImplementation((onTarget) => {
    onTarget({ tabId: 7, windowId: 1 });
    return pending.promise;
  });
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  await act(async () => {
    updated.addListener.mock.calls[0]![0](7, { status: "loading" });
    pending.resolve(result);
  });
  expect(document.querySelectorAll("li")).toHaveLength(0);
});
it("expires captions after five minutes and removes listeners on unmount", async () => {
  vi.useFakeTimers();
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  await act(async () => vi.advanceTimersByTime(300000));
  expect(document.querySelectorAll("li")).toHaveLength(0);
  await ui.unmount();
  for (const event of [updated, activated, removed])
    expect(event.removeListener).toHaveBeenCalledWith(
      event.addListener.mock.calls[0]![0],
    );
});
