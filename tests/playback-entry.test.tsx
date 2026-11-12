// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { click, mount } from "./ui-helpers";
import { PlaybackPanel } from "../entrypoints/sidepanel/PlaybackPanel";
import type { PlaybackEntry } from "../entrypoints/sidepanel/usePlaybackPanel";
import type { PlaybackSnapshot } from "../src/playback/bridge";

const command = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
vi.mock("../src/playback/bridge", () => ({ playbackCommand: command }));
vi.mock("../src/transport", () => ({ queryActive: query }));

const snapshot: PlaybackSnapshot = {
  courses: [],
  labels: {},
  current: null,
  queue: [],
  status: "idle",
};
const entry: PlaybackEntry = {
  course: {
    name: "선택한 과목",
    courseSelector: "00000000-0000-4000-8000-000000000012",
  },
  target: {
    id: 42,
    url: "https://mylms.korea.ac.kr/courses/12",
    documentToken: "00000000-0000-4000-8000-000000000099",
  },
  recordings: [1, 2, 3].map((id) => ({
    title: `영상 ${id}`,
    module: "1주",
    type: "ExternalTool",
    source: "module",
    lmsHandle: `lms-${id}`,
    launchHandle: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
  })),
  selectedHandles: [
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000001",
  ],
};
let ui: Awaited<ReturnType<typeof mount>>;
beforeEach(() => {
  command.mockResolvedValue({ status: "success", snapshot });
});
afterEach(async () => {
  await ui?.unmount();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function choices() {
  return [...ui.host.querySelectorAll<HTMLInputElement>(
    '.playback-choice input[type="checkbox"]',
  )];
}

it("opens an entry in StrictMode and starts its opaque handles in selection order against its issuing document", async () => {
  ui = await mount(
    <StrictMode><PlaybackPanel entry={entry} /></StrictMode>,
  );
  expect(choices().map((choice) => choice.checked)).toEqual([true, true, false]);
  expect(ui.host.querySelector("select")?.value).toBe(entry.course.courseSelector);
  expect(query).not.toHaveBeenCalled();

  await click("자동 재생");

  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "PLAYBACK_START",
    handles: entry.selectedHandles,
    sourceTabId: 42,
    documentToken: entry.target.documentToken,
  });
  expect(ui.host.querySelector(".detail-view")).toBeNull();
});

it("preserves edited selections when hidden and reopened with the same or absent entry", async () => {
  ui = await mount(<div hidden={false}><PlaybackPanel entry={entry} /></div>);
  const third = choices()[2];
  if (!third) throw new Error("Missing third recording");
  await act(async () => third.click());

  await ui.render(<div hidden><PlaybackPanel /></div>);
  await ui.render(<div hidden={false}><PlaybackPanel entry={entry} /></div>);

  expect(choices().map((choice) => choice.checked)).toEqual([true, true, true]);
  expect([...ui.host.querySelectorAll(".playback-order")].map((item) => item.textContent))
    .toEqual(["2", "1", "3"]);
});

it("opens a new entry object after closing the picker and replaces the old document binding", async () => {
  ui = await mount(<PlaybackPanel entry={entry} />);
  await click("← 목록");
  await ui.render(<PlaybackPanel entry={entry} />);
  expect(ui.host.querySelector(".detail-view")).toBeNull();
  const next: PlaybackEntry = {
    ...entry,
    target: { ...entry.target, id: 77, documentToken: "00000000-0000-4000-8000-000000000077" },
    selectedHandles: [entry.selectedHandles[0] ?? ""],
  };

  await ui.render(<PlaybackPanel entry={next} />);
  await click("자동 재생");

  expect(command).toHaveBeenCalledWith({
    version: 1,
    type: "PLAYBACK_START",
    handles: next.selectedHandles,
    sourceTabId: 77,
    documentToken: next.target.documentToken,
  });
});

it("does not restore spent entry handles after a failed start and a hidden reopen", async () => {
  ui = await mount(<div><PlaybackPanel entry={entry} /></div>);
  command.mockResolvedValueOnce({ status: "error", code: "TIMEOUT" });
  await click("자동 재생");

  await ui.render(<div hidden><PlaybackPanel /></div>);
  await ui.render(<div><PlaybackPanel entry={entry} /></div>);

  expect(choices()).toHaveLength(0);
  const start = [...ui.host.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "자동 재생");
  expect(start?.disabled).toBe(true);
  expect(command.mock.calls.filter(([request]) => request.type === "PLAYBACK_START"))
    .toHaveLength(1);
});

it("bounds imported selections to 100 and excludes board and unknown handles", async () => {
  const recordings = Array.from({ length: 102 }, (_, id) => ({
    title: `영상 ${id}`,
    module: "1주",
    type: "ExternalTool" as const,
    lmsHandle: `lms-${id}`,
    launchHandle: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    source: id === 0 ? "board" as const : "module" as const,
  }));
  ui = await mount(<PlaybackPanel entry={{
    ...entry,
    recordings,
    selectedHandles: ["unknown", ...recordings.map((item) => item.launchHandle)],
  }} />);

  expect(choices().filter((choice) => choice.checked)).toHaveLength(100);
  expect(choices()[0]?.disabled).toBe(true);
  expect(choices()[101]?.disabled).toBe(true);
  await click("자동 재생");
  expect(command).toHaveBeenCalledWith(expect.objectContaining({
    handles: recordings.slice(1, 101).map((item) => item.launchHandle),
  }));
});

it("cannot start imported handles without a document token", async () => {
  ui = await mount(<PlaybackPanel entry={{
    ...entry,
    target: { id: 42, url: entry.target.url },
  }} />);

  await click("자동 재생");

  expect(command.mock.calls.filter(([request]) => request.type === "PLAYBACK_START"))
    .toHaveLength(0);
  expect(ui.host.querySelector(".detail-view")).not.toBeNull();
});

it("loads the full course list for an explicit new picker after an imported entry", async () => {
  ui = await mount(<PlaybackPanel entry={entry} />);
  await click("← 목록");
  query.mockImplementationOnce(async (_request, options) => {
    options.onTarget(entry.target);
    return {
      status: "success",
      courses: [
        entry.course,
        { name: "다른 과목", courseSelector: "00000000-0000-4000-8000-000000000088" },
      ],
    };
  });
  await click("영상 선택");
  expect([...ui.host.querySelectorAll("select option")].map((option) => option.textContent))
    .toEqual(["과목 선택", "선택한 과목", "다른 과목"]);
  expect(choices()).toHaveLength(0);
});
