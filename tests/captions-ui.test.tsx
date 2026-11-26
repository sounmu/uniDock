// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CaptionResult } from "../src/captions/service";
import { mount, click, deferred } from "./ui-helpers";
const detect = vi.hoisted(() => vi.fn());
const downloadCaption = vi.hoisted(() => vi.fn());
vi.mock("../src/captions/service", () => ({ detectCaptions: detect }));
vi.mock("../src/captions/download", () => ({ downloadCaption }));
// Like the real section, the mock publishes its finished AI delivery on mount.
const aiDelivery = vi.hoisted(() => ({
  current: null as VideoCaptionDelivery | null,
}));
vi.mock("../entrypoints/sidepanel/CaptionQueue", () => ({
  CaptionQueue: ({ picking, onPick }: { picking: boolean; onPick: () => void }) =>
    picking ? <p>강의 고르는 화면</p> : <button onClick={onPick}>강의 고르기</button>,
}));
vi.mock("../entrypoints/sidepanel/AiCaptionsSection", async () => {
  const { useEffect } = await import("react");
  return {
    AiCaptionsSection: ({
      onSettings,
      restoreOnly,
      onVideoCaptions,
    }: {
      onSettings?: () => void;
      restoreOnly?: boolean;
      onVideoCaptions?: (delivery: VideoCaptionDelivery | null) => void;
    }) => {
      useEffect(() => {
        if (aiDelivery.current) onVideoCaptions?.(aiDelivery.current);
      }, [onVideoCaptions]);
      return restoreOnly ? null : (
        <section className="ai-offer">
          AI 자막 섹션
          {onSettings && <button onClick={onSettings}>AI 자막 설정</button>}
        </section>
      );
    },
  };
});
import { CaptionsPanel } from "../entrypoints/sidepanel/CaptionsPanel";
import type { VideoCaptionDelivery } from "../entrypoints/sidepanel/useVideoCaptions";
import { App } from "../entrypoints/sidepanel/App";
const updated = { addListener: vi.fn(), removeListener: vi.fn() };
const activated = { addListener: vi.fn(), removeListener: vi.fn() };
const removed = { addListener: vi.fn(), removeListener: vi.fn() };
let ui: Awaited<ReturnType<typeof mount>>;
const screenCaption = {
  sourceUrl: "https://kucom.korea.ac.kr/em/lecture",
  pageTitle: "강의",
  extractedAt: "2026-09-12T06:00:00Z",
  label: "강의 자막",
  source: "caption_script_dom",
  itemCount: 1,
  items: [{ index: 0, time: "00:01", text: "본문" }],
  documentId: "player",
};
const result: CaptionResult = { status: "success", blocked: false, captions: [screenCaption] };
const sendMessage = vi.fn();
const storageChanged = { addListener: vi.fn(), removeListener: vi.fn() };
let preferences: Record<string, unknown>;
beforeEach(() => {
  preferences = {};
  aiDelivery.current = null;
  sendMessage.mockResolvedValue({ ok: true });
  vi.stubGlobal("chrome", {
    runtime: { sendMessage },
    tabs: { onUpdated: updated, onActivated: activated, onRemoved: removed },
    storage: {
      local: { get: vi.fn(async (name: string) => ({ [name]: preferences[name] })) },
      onChanged: storageChanged,
    },
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
const officialTrack: CaptionResult = {
  status: "success",
  blocked: false,
  captions: [
    {
      ...screenCaption,
      source: "player_vtt",
      itemCount: 2,
      items: [
        { index: 0, time: "00:01", text: "첫 자막", startMs: 1000, endMs: 2500 },
        { index: 1, time: "00:03", text: "둘째 자막", startMs: 3000, endMs: 4000 },
      ],
    },
  ],
};
const trackMessages = () =>
  sendMessage.mock.calls.map(([message]) => ({
    tabId: message.tabId,
    documentId: message.documentId,
    cues: message.cues.map((cue: { text: string }) => cue.text),
  }));
it("shows an official track on the lecture video and removes it when the setting goes off", async () => {
  // Given: the lecture's own VTT track was detected in the player document.
  detect.mockImplementation(async (onTarget) => {
    onTarget({ tabId: 7, windowId: 1 });
    return officialTrack;
  });
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  // Then: the worker is asked to forward the timed cues to exactly that document once.
  expect(trackMessages()).toEqual([
    { tabId: 7, documentId: "player", cues: ["첫 자막", "둘째 자막"] },
  ]);
  expect(sendMessage.mock.calls[0]![0]).toEqual({
    version: 1,
    type: "PLAYBACK_CAPTION_FORWARD",
    tabId: 7,
    documentId: "player",
    cues: [{ start: 1000, end: 2500, text: "첫 자막" }, { start: 3000, end: 4000, text: "둘째 자막" }],
  });
  // When: the user turns on-video captions off.
  await act(async () => {
    for (const [listener] of storageChanged.addListener.mock.calls)
      listener({ "unidock.video-captions.v1": { newValue: false } }, "local");
  });
  // Then: the same document is told to clear its track.
  expect(trackMessages()[1]).toEqual({ tabId: 7, documentId: "player", cues: [] });
});

it("lets go of the previous lecture's video when the next detection finds no track", async () => {
  // Given: lecture A's official track is on its video.
  detect.mockImplementation(async (onTarget) => {
    onTarget({ tabId: 7, windowId: 1 });
    return officialTrack;
  });
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  // When: the next detection finds no captions.
  detect.mockResolvedValue({ status: "error", code: "NO_CAPTIONS" });
  await click("자막 감지");
  // Then: A's subtitles are cleared instead of outranking the next delivery.
  expect(trackMessages()).toEqual([
    { tabId: 7, documentId: "player", cues: ["첫 자막", "둘째 자막"] },
    { tabId: 7, documentId: "player", cues: [] },
  ]);
});
it("lets go of the previous lecture's AI subtitles when the next detection finds only a script", async () => {
  // Given: lecture A had no captions and its AI transcript is on its video.
  detect.mockResolvedValue({ status: "error", code: "NO_CAPTIONS" });
  ui = await mount(<CaptionsPanel />);
  aiDelivery.current = {
    target: { tabId: 7, documentId: "lecture-a" },
    cues: [{ start: 0, end: 1000, text: "AI 자막" }],
  };
  await click("자막 감지");
  aiDelivery.current = null;
  // When: lecture B's detection returns an untimed script.
  detect.mockImplementation(async (onTarget) => {
    onTarget({ tabId: 7, windowId: 1 });
    return result;
  });
  await click("자막 감지");
  // Then: A's AI subtitles are cleared and never delivered again.
  expect(trackMessages()).toEqual([
    { tabId: 7, documentId: "lecture-a", cues: ["AI 자막"] },
    { tabId: 7, documentId: "lecture-a", cues: [] },
  ]);
});
it("retries a refused delivery with backoff until the player accepts it, and counts it shown only then", async () => {
  vi.useFakeTimers();
  // Given: the player listener is not ready for the first two deliveries.
  sendMessage
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValue({ ok: true });
  detect.mockImplementation(async (onTarget) => {
    onTarget({ tabId: 7, windowId: 1 });
    return officialTrack;
  });
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  expect(sendMessage).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(499));
  expect(sendMessage).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(1));
  expect(sendMessage).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTime(1000));
  // Then: the third attempt lands, and nothing more is sent.
  await act(async () => vi.advanceTimersByTime(60000));
  expect(trackMessages()).toEqual([
    { tabId: 7, documentId: "player", cues: ["첫 자막", "둘째 자막"] },
    { tabId: 7, documentId: "player", cues: ["첫 자막", "둘째 자막"] },
    { tabId: 7, documentId: "player", cues: ["첫 자막", "둘째 자막"] },
  ]);
});
it("gives up after a bounded number of refused deliveries", async () => {
  vi.useFakeTimers();
  sendMessage.mockResolvedValue({ ok: false });
  detect.mockImplementation(async (onTarget) => {
    onTarget({ tabId: 7, windowId: 1 });
    return officialTrack;
  });
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  // The async variant lets each refusal settle and schedule the next retry.
  await act(() => vi.advanceTimersByTimeAsync(600000));
  // The first attempt plus retries after 0.5, 1, 2 and 4 seconds.
  expect(sendMessage).toHaveBeenCalledTimes(5);
});
it.each(["unmount", "target change"])(
  "stops retrying a refused delivery on %s",
  async (action) => {
    vi.useFakeTimers();
    sendMessage.mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    detect.mockImplementation(async (onTarget) => {
      onTarget({ tabId: 7, windowId: 1 });
      return officialTrack;
    });
    ui = await mount(<CaptionsPanel />);
    await click("자막 감지");
    if (action === "unmount") await ui.unmount();
    else
      await act(async () => {
        updated.addListener.mock.calls[0]![0](7, { status: "loading" });
      });
    await act(async () => vi.advanceTimersByTime(60000));
    // Only the refused delivery, then the clear a target change sends; no retry.
    expect(trackMessages()).toEqual(
      action === "unmount"
        ? [{ tabId: 7, documentId: "player", cues: ["첫 자막", "둘째 자막"] }]
        : [
            { tabId: 7, documentId: "player", cues: ["첫 자막", "둘째 자막"] },
            { tabId: 7, documentId: "player", cues: [] },
          ],
    );
  },
);
it("saves the setting as a plain storage write and leaves clearing videos to the worker", async () => {
  const set = vi.fn(async () => {});
  (chrome.storage.local as unknown as { set: typeof set }).set = set;
  const { saveVideoCaptions } = await import("../src/video-captions");
  await saveVideoCaptions(false);
  expect(set).toHaveBeenCalledWith({ "unidock.video-captions.v1": false });
  expect(sendMessage).not.toHaveBeenCalled();
});
it("never puts screen-script captions on the video", async () => {
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  expect(sendMessage).not.toHaveBeenCalled();
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
  await click("홈");
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
it("clears a previous lecture result when a newly opened lecture enters the caption tool", async () => {
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  expect(ui.host.querySelectorAll(".list-row")).toHaveLength(1);
  await ui.render(<CaptionsPanel entry={{ title: "다음 샘플 강의" }} />);
  expect(ui.host.querySelectorAll(".list-row")).toHaveLength(0);
  expect(ui.host.textContent).toContain("다음 샘플 강의 강의를 열었습니다");
  expect(detect).toHaveBeenCalledTimes(1);
  await click("자막 감지");
  expect(ui.host.querySelectorAll(".list-row")).toHaveLength(1);
  expect(detect).toHaveBeenCalledTimes(2);
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
  ui = await mount(<CaptionsPanel />);
  await click("자막 감지");
  await click("강의 자막");
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

it("starts each outside entry fresh, closing a picker opened earlier", async () => {
  const { CaptionsPanel } = await import("../entrypoints/sidepanel/CaptionsPanel");
  ui = await mount(<CaptionsPanel visit={1} />);
  await click("강의 고르기");
  expect(ui.host.textContent).toContain("강의 고르는 화면");
  await ui.render(<CaptionsPanel visit={2} />);
  expect(ui.host.textContent).not.toContain("강의 고르는 화면");
  expect(ui.host.querySelector("button")?.closest("[hidden]")).toBeNull();
  const queueEntry = { course: { id: "1", name: "과목" }, recordings: [], target: { id: 1, url: "https://mylms.korea.ac.kr/" }, selectedHandles: [] } as never;
  await ui.render(<CaptionsPanel visit={3} queueEntry={queueEntry} />);
  expect(ui.host.textContent).toContain("강의 고르는 화면");
});

it("closes an open transcript when captions is entered again", async () => {
  detect.mockImplementation(async (onTarget) => {
    onTarget({ tabId: 7, windowId: 1 });
    return officialTrack;
  });
  ui = await mount(<CaptionsPanel visit={1} />);
  await click("자막 감지");
  const label = officialTrack.status === "success" ? officialTrack.captions[0]!.label : "";
  await act(async () =>
    [...ui.host.querySelectorAll("button")].find((button) => button.textContent?.includes(label))!.click(),
  );
  expect(ui.host.querySelector(".detail-view")).not.toBeNull();
  await ui.render(<CaptionsPanel visit={2} />);
  expect(ui.host.querySelector(".detail-view")).toBeNull();
});
