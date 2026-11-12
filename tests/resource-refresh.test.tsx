// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Result } from "../src/protocol";
import type { queryActive as QueryActive } from "../src/transport";
import { mount, click, deferred } from "./ui-helpers";
const query = vi.hoisted(() => vi.fn<typeof QueryActive>());
const playback = vi.hoisted(() => vi.fn());
vi.mock("../src/transport", () => ({ queryActive: query }));
vi.mock("../src/playback/bridge", () => ({ playbackCommand: playback }));
vi.mock("../entrypoints/sidepanel/CaptionsPanel", () => ({
  CaptionsPanel: () => <p>자막 화면</p>,
}));
import { App } from "../entrypoints/sidepanel/App";

const now = Date.parse("2026-11-08T00:00:00Z");
const courseSelector = "00000000-0000-4000-8000-000000000012";
const target = { id: 7, url: "https://mylms.korea.ac.kr/courses/101/modules" };
let ui: Awaited<ReturnType<typeof mount>>;
function recordings(prefix: string): Extract<Result, { recordings: unknown }> {
  return {
    status: "success",
    recordings: ["1차시", "2차시"].map((title) => ({
      module: "1주차", title: `${prefix} ${title}`, type: "ExternalTool",
      source: "module", lmsHandle: crypto.randomUUID(), launchHandle: crypto.randomUUID(),
    })),
  };
}
function documents(prefix: string): Extract<Result, { documents: unknown }> {
  return {
    status: "success",
    documents: ["one.pdf", "two.pdf"].map((title) => ({
      module: "Week 1", title: `${prefix} ${title}`, filename: title, type: "File",
      lmsHandle: crypto.randomUUID(), downloadHandle: crypto.randomUUID(),
    })),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal("chrome", {
    storage: {
      local: { get: vi.fn().mockResolvedValue({}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    downloads: {
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  playback.mockResolvedValue({
    status: "success",
    snapshot: { courses: [], labels: {}, current: null, queue: [], status: "idle" },
  });
  query.mockImplementation(async (request, options) => {
    if (request.type === "COURSES_LIST") {
      options?.onTarget?.(target);
      return { status: "success", courses: [{ name: "과목 A", courseSelector }] };
    }
    if (request.type === "ASSIGNMENTS_LIST") return { status: "success", assignments: [] };
    if (request.type === "RECORDINGS_LIST") {
      options?.onTarget?.(target);
      return recordings("A");
    }
    if (request.type === "DOCUMENTS_LIST") {
      options?.onTarget?.(target);
      return documents("A");
    }
    return { status: "error", code: "POLICY" };
  });
});
afterEach(async () => {
  await ui?.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
async function openTab(label: "녹화 강의" | "강의 자료") {
  ui = await mount(<App />);
  await click("내 과목");
  await click("과목 A");
  await click(label);
}
async function refresh(label: string) {
  const button = ui.host.querySelector<HTMLButtonElement>(`button[aria-label="${label} 새로고침"]`);
  if (!button) throw new Error(`Missing refresh: ${label}`);
  await act(async () => button.click());
}
const timestamp = () =>
  ui.host.querySelector(".assignment-freshness time")?.getAttribute("datetime");
const freshness = () => ui.host.querySelector(".assignment-freshness")?.textContent;
const disabled = (selector: string) =>
  [...ui.host.querySelectorAll<HTMLButtonElement | HTMLInputElement>(selector)]
    .map((element) => element.disabled);

it("keeps recording rows with their launch actions disabled while refreshing, then shows the fresh list", async () => {
  await openTab("녹화 강의");
  expect(ui.host.textContent).toContain("A 1차시");
  expect(timestamp()).toBe(new Date(now).toISOString());
  expect(disabled(".row-action")).toEqual([false, false]);
  const held = deferred<Result>();
  query.mockReturnValueOnce(held.promise);

  await refresh("녹화 강의");

  expect(ui.host.textContent).toContain("A 2차시");
  expect(disabled(".row-action")).toEqual([true, true]);
  expect(freshness()).toBe("업데이트 중");
  expect(ui.host.querySelector(".assignment-refresh")?.getAttribute("aria-disabled")).toBe("true");
  vi.setSystemTime(now + 60000);
  await act(async () => held.resolve(recordings("갱신")));
  expect(ui.host.textContent).not.toContain("A 1차시");
  expect(ui.host.textContent).toContain("갱신 2차시");
  expect(disabled(".row-action")).toEqual([false, false]);
  expect(timestamp()).toBe(new Date(now + 60000).toISOString());
  expect(query.mock.calls.at(-1)?.[1]).toMatchObject({ refresh: true, target });
});

it("keeps material rows unselectable while refreshing and clears them after a network failure, keeping the time", async () => {
  await openTab("강의 자료");
  const first = ui.host.querySelector<HTMLInputElement>('input[aria-label="A one.pdf 선택"]');
  if (!first) throw new Error("Missing checkbox");
  await act(async () => first.click());
  expect(ui.host.querySelector(".material-actions .btn-primary")?.textContent).toBe("선택 다운로드 (1)");
  const held = deferred<Result>();
  query.mockReturnValueOnce(held.promise);

  await refresh("강의 자료");

  expect(ui.host.textContent).toContain("A two.pdf");
  expect(disabled('input[type="checkbox"]')).toEqual([true, true, true]);
  const primary = ui.host.querySelector<HTMLButtonElement>(".material-actions .btn-primary");
  expect(primary?.textContent).toBe("자료 전체 다운로드");
  expect(primary?.disabled).toBe(true);
  expect(freshness()).toBe("업데이트 중");
  vi.setSystemTime(now + 180000);
  await act(async () => held.resolve({ status: "error", code: "NETWORK" }));
  expect(ui.host.textContent).not.toContain("A one.pdf");
  expect(ui.host.querySelector('[role="alert"]')).not.toBeNull();
  expect(timestamp()).toBe(new Date(now).toISOString());

  await refresh("강의 자료");

  expect(ui.host.textContent).toContain("A one.pdf");
  expect(disabled('input[type="checkbox"]')).toEqual([false, false, false]);
  expect(timestamp()).toBe(new Date(now + 180000).toISOString());
});
