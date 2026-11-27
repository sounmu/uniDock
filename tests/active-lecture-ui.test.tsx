// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { click, mount } from "./ui-helpers";
import { isLecturePage } from "../src/captions/media-source";

let activeTab: { url: string; title: string; id?: number } | undefined;
let activated: (() => void) | undefined;
let updated:
  | ((tabId: number, change: { url?: string }, tab: { active: boolean }) => void)
  | undefined;
let ui: Awaited<ReturnType<typeof mount>>;
const executeScript = vi.fn();

beforeEach(() => {
  activated = undefined;
  updated = undefined;
  activeTab = undefined;
  vi.stubGlobal("chrome", {
    tabs: {
      query: vi.fn(async () => (activeTab ? [activeTab] : [])),
      onActivated: {
        addListener: (listener: () => void) => (activated = listener),
        removeListener: vi.fn(),
      },
      onUpdated: {
        addListener: (listener: typeof updated) => (updated = listener),
        removeListener: vi.fn(),
      },
    },
    scripting: { executeScript },
  });
});
afterEach(async () => {
  await ui?.unmount();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function render(onOpen = vi.fn()) {
  const { useActiveLecture } = await import("../entrypoints/sidepanel/useActiveLecture");
  const { ActiveLectureCard } = await import("../entrypoints/sidepanel/ActiveLectureCard");
  function Harness() {
    const lecture = useActiveLecture(true);
    return lecture ? <ActiveLectureCard lecture={lecture} onOpen={onOpen} /> : null;
  }
  ui = await mount(<Harness />);
  return onOpen;
}

it.each([
  ["https://kucom.korea.ac.kr/em/lecture", true],
  ["https://mylms.korea.ac.kr/courses/1/modules/items/2", true],
  ["https://canvas.korea.ac.kr/courses/1/modules/items/2?return=1", true],
  ["https://mylms.korea.ac.kr/courses/1/assignments", false],
  ["https://kucom.korea.ac.kr/other", false],
  ["https://example.com/courses/1/modules/items/2", false],
  ["not a url", false],
])("treats %s as a lecture page: %s", (url, expected) => {
  expect(isLecturePage(url)).toBe(expected);
});

it("offers the lecture open in the active tab without injecting into it", async () => {
  activeTab = { url: "https://mylms.korea.ac.kr/courses/1/modules/items/2", title: "3주차 강의" };
  const onOpen = await render();
  expect(ui.host.textContent).toContain("3주차 강의");
  await click("지금 보는 강의 자막 추출");
  expect(onOpen).toHaveBeenCalledOnce();
  expect(executeScript).not.toHaveBeenCalled();
});

it("hides the card while audio is being prepared anywhere or that tab's lecture is in work", async () => {
  const { lectureBusy } = await import("../entrypoints/sidepanel/progress-activity");
  const run = (phase: "extracting" | "uploading" | "queued" | "running" | "succeeded") => ({
    caption: { kind: "captions" as const, id: "job", phase, percent: null, workerOffline: false },
    source: 3,
    preparing: false,
  });
  const idle = { caption: null, source: null, preparing: false };
  expect(lectureBusy(run("extracting"), 9)).toBe(true);
  expect(lectureBusy(run("uploading"), 9)).toBe(true);
  expect(lectureBusy(run("queued"), 3)).toBe(true);
  expect(lectureBusy(run("running"), 3)).toBe(true);
  expect(lectureBusy(run("running"), 9)).toBe(false);
  expect(lectureBusy(run("succeeded"), 3)).toBe(false);
  expect(lectureBusy({ ...idle, preparing: true }, 9)).toBe(true);
  expect(lectureBusy({ ...run("succeeded"), preparing: true }, 9)).toBe(true);
  expect(lectureBusy(idle, 9)).toBe(false);
  expect(lectureBusy(run("running"), undefined)).toBe(false);
});

it("names the active tab with the lecture so the run can be matched to it", async () => {
  activeTab = { url: "https://kucom.korea.ac.kr/em/lecture", title: "3주차 강의", id: 7 };
  const { useActiveLecture } = await import("../entrypoints/sidepanel/useActiveLecture");
  let seen: unknown;
  function Probe() {
    seen = useActiveLecture(true);
    return null;
  }
  ui = await mount(<Probe />);
  expect(seen).toEqual({ title: "3주차 강의", tabId: 7 });
});

it("rechecks when the active tab moves to a lecture within the page", async () => {
  activeTab = { url: "https://mylms.korea.ac.kr/courses/1/assignments", title: "과제" };
  await render();
  expect(ui.host.querySelector(".progress-row")).toBeNull();
  activeTab = { url: "https://mylms.korea.ac.kr/courses/1/modules/items/2", title: "과제" };
  await act(async () => updated?.(7, { url: activeTab!.url }, { active: true }));
  expect(ui.host.querySelector(".progress-row")).not.toBeNull();
});

it("hides the card after switching to a tab that is not a lecture", async () => {
  activeTab = { url: "https://kucom.korea.ac.kr/em/lecture", title: "3주차 강의" };
  await render();
  expect(ui.host.querySelector(".progress-row")).not.toBeNull();
  activeTab = { url: "https://mylms.korea.ac.kr/courses/1/assignments", title: "과제" };
  await act(async () => activated?.());
  expect(ui.host.querySelector(".progress-row")).toBeNull();
});
