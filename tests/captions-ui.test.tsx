// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CaptionResult } from "../src/captions/service";
import { mount, click, deferred } from "./ui-helpers";
const detect = vi.hoisted(() => vi.fn());
const downloadCaption = vi.hoisted(() => vi.fn());
vi.mock("../src/captions/service", () => ({ detectCaptions: detect }));
vi.mock("../src/captions/download", () => ({ downloadCaption }));
vi.mock("../entrypoints/sidepanel/AiCaptionsSection", () => ({
  AiCaptionsSection: () => "AI 자막 섹션",
}));
import { CaptionsPanel } from "../entrypoints/sidepanel/CaptionsPanel";
import { App } from "../entrypoints/sidepanel/App";
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
  downloadCaption.mockResolvedValue({ status: "complete" });
});
afterEach(async () => {
  await ui?.unmount();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});
it("keeps captions across unrelated updates and tab switches", async () => {
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  await act(async () => {
    updated.addListener.mock.calls[0]![0](999, { status: "loading" });
    updated.addListener.mock.calls[0]![0](7, {
      title: "재생 중",
      audible: true,
      status: "complete",
    });
    for (const [listener] of activated.addListener.mock.calls) {
      listener({ tabId: 999, windowId: 2 });
      listener({ tabId: 8, windowId: 1 });
      listener({ tabId: 7, windowId: 1 });
    }
  });
  expect(document.querySelectorAll("li")).toHaveLength(1);
});
it("keeps the same AI caption offer across settings, menus and browser tabs", async () => {
  // Given: no provided captions, so the panel offers AI generation.
  detect.mockResolvedValue({ status: "error", code: "NO_CAPTIONS" });
  vi.stubGlobal("chrome", {
    ...chrome,
    storage: {
      local: { get: vi.fn().mockResolvedValue({}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    downloads: {
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  ui = await mount(<App />);
  await click("자막 추출");
  await click("자막 감지");
  const offer = ui.host.querySelector(".ai-offer");
  const trigger = [...ui.host.querySelectorAll("button")].find(
    (button) => button.textContent === "AI 자막 설정",
  );
  trigger?.focus();
  // When
  await click("AI 자막 설정");
  expect(document.activeElement).toBe(ui.host.querySelector("#caption-server-title"));
  await click("← 돌아가기");
  // Then: the same offer, still mounted, and no re-detection.
  expect(document.activeElement).toBe(trigger);
  await click("내 과목");
  expect(offer?.closest("[hidden]")).not.toBeNull();
  await act(async () => {
    for (const [listener] of activated.addListener.mock.calls) {
      listener({ tabId: 8, windowId: 1 });
      listener({ tabId: 7, windowId: 1 });
    }
  });
  await click("자막 추출");
  expect(ui.host.querySelector(".ai-offer")).toBe(offer);
  expect(offer?.closest("[hidden]")).toBeNull();
  expect(detect).toHaveBeenCalledTimes(1);
  expect(ui.host.textContent).toContain("AI 자막 섹션");
});
it("offers AI settings only when the AI offer is shown", async () => {
  ui = await mount(<CaptionsPanel onConnectionSettings={() => {}} />);
  await click("자막 감지");
  const labels = () => [...ui.host.querySelectorAll("button")].map((b) => b.textContent);
  expect(labels()).not.toContain("AI 자막 설정");
  expect(ui.host.querySelector(".screen-header .btn-primary")).not.toBeNull();
  detect.mockResolvedValue({ status: "error", code: "NO_CAPTIONS" });
  await click("자막 감지");
  expect(labels()).toContain("AI 자막 설정");
  // The offer card's action is the sole primary; detection steps back.
  expect(ui.host.querySelector(".screen-header .btn-primary")).toBeNull();
  expect(ui.host.querySelector('[role="alert"]')).toBeNull();
});
it.each(["reload", "url", "close"])(
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
      if (kind === "close") removed.addListener.mock.calls[0]![0](7);
    });
    expect(document.querySelectorAll("li")).toHaveLength(0);
  },
);
it.each([
  ["NO_CAPTIONS", true],
  ["UNSAFE_CAPTION", true],
  ["ACTIVATE_TAB", false],
  ["RELOAD_TAB", false],
  ["TIMEOUT", false],
] as const)("offers AI captions after %s: %s", async (code, offered) => {
  detect.mockResolvedValue({ status: "error", code });
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  expect(ui.host.textContent?.includes("AI 자막 섹션")).toBe(offered);
});
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
it("admits only one export while its TXT request is pending", async () => {
  const pending = deferred<{ status: "complete" }>();
  downloadCaption.mockReturnValue(pending.promise);
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  await click("강의 자막");

  const button = ui.host.querySelector<HTMLButtonElement>(
    ".detail-view .btn-primary",
  )!;
  await act(async () => {
    button.click();
    button.click();
  });

  expect(downloadCaption).toHaveBeenCalledTimes(1);
  expect(button.disabled).toBe(true);
  await act(async () => pending.resolve({ status: "complete" }));
  expect(button.disabled).toBe(false);
});
it.each(["clear", "unmount"])(
  "%s cancels a pending export without publishing its late result",
  async (action) => {
    const pending = deferred<{ status: "complete" }>();
    downloadCaption.mockReturnValue(pending.promise);
    ui = await mount(<CaptionsPanel />);
    await click("자막 감지");
    await click("강의 자막");
    await click("TXT·JSON 다운로드");
    const options = downloadCaption.mock.calls[0]![1] as {
      signal: AbortSignal;
    };

    if (action === "clear") {
      await act(async () => {
        updated.addListener.mock.calls[0]![0](7, { status: "loading" });
      });
    } else {
      await ui.unmount();
    }
    expect(options.signal.aborted).toBe(true);
    await act(async () => pending.resolve({ status: "complete" }));
    expect(ui.host.textContent).not.toContain("다운로드 목록");
  },
);
it("does not let an old export notice overwrite a newer caption context", async () => {
  const pending = deferred<{ status: "partial"; accepted: 1 }>();
  downloadCaption.mockReturnValueOnce(pending.promise);
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  await click("강의 자막");
  await click("TXT·JSON 다운로드");
  await act(async () => {
    updated.addListener.mock.calls[0]![0](7, { status: "loading" });
  });
  await click("자막 감지");
  await act(async () => pending.resolve({ status: "partial", accepted: 1 }));

  expect(document.querySelectorAll("li")).toHaveLength(1);
  expect(ui.host.textContent).not.toContain("TXT 다운로드만");
});
it("reports an in-context TXT-only partial export honestly", async () => {
  downloadCaption.mockResolvedValue({ status: "partial", accepted: 1 });
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  await click("강의 자막");

  await click("TXT·JSON 다운로드");

  expect(ui.host.textContent).toContain(
    "TXT 다운로드만 요청되었습니다. JSON은 요청되지 않았습니다.",
  );
});
it("unlocks the export button after validation rejects before any download", async () => {
  downloadCaption
    .mockRejectedValueOnce(new Error("INVALID_CAPTION"))
    .mockResolvedValueOnce({ status: "complete" });
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  await click("강의 자막");

  await click("TXT·JSON 다운로드");

  const button = ui.host.querySelector<HTMLButtonElement>(
    ".detail-view .btn-primary",
  )!;
  expect(button.disabled).toBe(false);
  expect(ui.host.textContent).toContain("다운로드 요청을 완료하지 못했습니다.");
  await click("TXT·JSON 다운로드");
  expect(downloadCaption).toHaveBeenCalledTimes(2);
});
it("does not let an old rejection unlock a newer export", async () => {
  let rejectOld!: (reason: Error) => void;
  const old = new Promise<never>((_resolve, reject) => {
    rejectOld = reject;
  });
  const current = deferred<{ status: "complete" }>();
  downloadCaption.mockReturnValueOnce(old).mockReturnValueOnce(current.promise);
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  await click("강의 자막");
  await click("TXT·JSON 다운로드");
  await act(async () => {
    updated.addListener.mock.calls[0]![0](7, { status: "loading" });
  });
  await click("자막 감지");
  await click("강의 자막");
  await click("TXT·JSON 다운로드");

  const button = ui.host.querySelector<HTMLButtonElement>(
    ".detail-view .btn-primary",
  )!;
  await act(async () => rejectOld(new Error("INVALID_CAPTION")));
  expect(button.disabled).toBe(true);
  expect(ui.host.textContent).not.toContain("완료하지 못했습니다");

  await act(async () => current.resolve({ status: "complete" }));
  expect(button.disabled).toBe(false);
});
it("expires captions after five minutes and removes listeners on unmount", async () => {
  vi.useFakeTimers();
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  await act(async () => vi.advanceTimersByTime(300000));
  expect(document.querySelectorAll("li")).toHaveLength(0);
  await ui.unmount();
  for (const event of [updated, removed])
    expect(event.removeListener).toHaveBeenCalledWith(
      event.addListener.mock.calls[0]![0],
    );
});
