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
it("aborts a cleared detection and lets only a fresh replacement finish", async () => {
  const first = deferred<CaptionResult>();
  const second = deferred<CaptionResult>();
  const signals: AbortSignal[] = [];
  detect
    .mockImplementationOnce((onTarget, signal) => {
      signals.push(signal);
      onTarget({ tabId: 7, windowId: 1 });
      return first.promise;
    })
    .mockImplementationOnce((onTarget, signal) => {
      signals.push(signal);
      onTarget({ tabId: 8, windowId: 1 });
      return second.promise;
    });
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");

  await act(async () => {
    updated.addListener.mock.calls[0]![0](7, { status: "loading" });
  });
  expect(signals[0]?.aborted).toBe(true);
  await click("자막 감지");
  expect(signals[1]).not.toBe(signals[0]);
  expect(signals[1]?.aborted).toBe(false);

  await act(async () => first.resolve(result));
  expect(ui.host.querySelector("button")?.textContent).not.toContain(
    "자막 감지",
  );
  expect(ui.host.textContent).toContain("감지 중…");
  expect(document.querySelectorAll("li")).toHaveLength(0);

  await act(async () => second.resolve(result));
  expect(document.querySelectorAll("li")).toHaveLength(1);
});
it("aborts an in-flight detection on unmount", async () => {
  const pending = deferred<CaptionResult>();
  let signal: AbortSignal | undefined;
  detect.mockImplementation((_onTarget, nextSignal) => {
    signal = nextSignal;
    return pending.promise;
  });
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");

  await ui.unmount();
  expect(signal?.aborted).toBe(true);
});
it("moves caption tools into a detail view while preserving the list", async () => {
  // Given
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  // When
  await click("강의 자막");
  // Then
  expect(ui.host.querySelector(".detail-view dl")).not.toBeNull();
  expect(ui.host.querySelector(".detail-view .btn-primary")?.textContent).toBe(
    "TXT·JSON 다운로드",
  );
  expect(ui.host.querySelector("li")?.closest("[hidden]")).not.toBeNull();
  await click("← 목록");
  expect(ui.host.querySelector("li")?.closest("[hidden]")).toBeNull();
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
