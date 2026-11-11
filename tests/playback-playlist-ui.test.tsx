// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mount } from "./ui-helpers";
import type { PlaybackSnapshot } from "../src/playback/bridge";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/playback/bridge", () => ({ playbackCommand: command }));
import { PlaybackPanel } from "../entrypoints/sidepanel/PlaybackPanel";

let ui: Awaited<ReturnType<typeof mount>>;
afterEach(async () => {
  await ui?.unmount();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const snapshot: PlaybackSnapshot = {
  courses: [
    { id: "12", name: "262R (서울-학부)운영체제(영강)(Operating Systems)-00분반" },
    { id: "13", name: "262R (서울-학부)자료구조(Data Structures)-02분반" },
  ],
  labels: { "12:34": "프로세스와 스레드", "13:35": "트리 순회" },
  current: { id: "12:34", courseId: "12" },
  queue: [{ id: "13:35", courseId: "13" }],
  status: "playing",
};

it.each([
  ["playing", "재생 중"],
  ["paused", "일시정지"],
  ["stopped", "중지됨"],
] as const)("keeps the current video first in one ordered playlist while %s", async (status, label) => {
  command.mockResolvedValue({ status: "success", snapshot: { ...snapshot, status } });
  ui = await mount(<PlaybackPanel />);

  const list = ui.host.querySelector('ol[aria-label="재생목록"]');
  const rows = [...(list?.querySelectorAll("li") ?? [])];
  expect(rows.map((row) => row.querySelector("strong")?.textContent))
    .toEqual(["프로세스와 스레드", "트리 순회"]);
  expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual(["true", null]);
  expect(rows[0]?.querySelector("small")?.textContent).toBe(`운영체제 · ${label}`);
  expect(rows[1]?.querySelector("small")?.textContent).toBe("자료구조");
  expect(rows[1]?.querySelector(".playback-position")?.textContent).toBe("2");
});

it("retains a queued video without marking it current while login is blocked", async () => {
  command.mockResolvedValue({
    status: "success",
    snapshot: { ...snapshot, status: "blocked-login", current: null },
  });
  ui = await mount(<PlaybackPanel />);

  const list = ui.host.querySelector('ol[aria-label="재생목록"]');
  expect(list?.querySelectorAll("li")).toHaveLength(1);
  expect(list?.querySelector("strong")?.textContent).toBe("트리 순회");
  expect(list?.querySelector("[aria-current]")).toBeNull();
  expect(list?.querySelector(".playback-position")?.textContent).toBe("1");
});

it("shows one empty state when no current or queued videos remain", async () => {
  command.mockResolvedValue({
    status: "success",
    snapshot: { ...snapshot, status: "idle", current: null, queue: [] },
  });
  ui = await mount(<PlaybackPanel />);

  expect(ui.host.querySelector(".playback-playlist")?.textContent)
    .toContain("재생목록이 비어 있습니다.");
  expect(ui.host.querySelector('ol[aria-label="재생목록"]')).toBeNull();
});
