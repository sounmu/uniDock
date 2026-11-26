// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { click, mount } from "./ui-helpers";
import { isLecturePage } from "../src/captions/media-source";

let activeTab: { url: string; title: string } | undefined;
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
