// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Result } from "../src/protocol";
import type { queryActive as QueryActive } from "../src/transport";
import { projectAssignments } from "../src/domain-items";
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
const firstCourse = "00000000-0000-4000-8000-000000000012";
const secondCourse = "00000000-0000-4000-8000-000000000013";
const target = { id: 7, url: "https://mylms.korea.ac.kr/courses/101/modules" };
let ui: Awaited<ReturnType<typeof mount>>;
function result(prefix: string): Extract<Result, { assignments: unknown }> {
  return {
    status: "success",
    assignments: projectAssignments([
      { name: `${prefix} 첫 과제`, due_at: new Date(now + 3600000).toISOString() },
      { name: `${prefix} 다음 과제`, due_at: new Date(now + 86400000).toISOString() },
      { name: `${prefix} 제출 과제`, due_at: new Date(now + 86400000).toISOString(),
        submission: { workflow_state: "submitted", submitted_at: new Date(now).toISOString() } },
    ], now),
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
      return { status: "success", courses: [
        { name: "과목 A", courseSelector: firstCourse },
        { name: "과목 B", courseSelector: secondCourse },
      ] };
    }
    if (request.type === "ASSIGNMENTS_LIST")
      return result(request.courseSelector === secondCourse ? "B" : "A");
    if (request.type === "TODO_LIST") return { status: "success", todo: [] };
    return { status: "error", code: "POLICY" };
  });
});
afterEach(async () => {
  await ui?.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
async function loadCourse() {
  ui = await mount(<App />);
  await click("내 과목");
  await click("과목 A");
}
async function refresh() {
  const button = ui.host.querySelector<HTMLButtonElement>('button[aria-label="과제 새로고침"]');
  expect(button).not.toBeNull();
  if (!button) throw new Error("Missing assignment refresh");
  await act(async () => button.click());
}
function timestamp() {
  return ui.host.querySelector(".assignment-freshness time")?.getAttribute("datetime");
}
it("retains the same assignment view and filters while refreshing, then replaces it on success", async () => {
  await loadCourse();
  const all = ui.host.querySelector<HTMLButtonElement>(".assignment-all-link");
  expect(all).not.toBeNull();
  await act(async () => all?.click());
  expect(ui.host.textContent).toContain("A 제출 과제");
  const held = deferred<Result>();
  query.mockReturnValueOnce(held.promise);
  await refresh();
  expect(ui.host.textContent).toContain("A 첫 과제");
  expect(ui.host.textContent).toContain("A 제출 과제");
  expect(ui.host.querySelector(".assignment-freshness")?.textContent).toBe("업데이트 중");
  expect(ui.host.querySelector(".assignment-refresh")?.getAttribute("aria-disabled")).toBe("true");
  vi.setSystemTime(now + 60000);
  await act(async () => held.resolve(result("갱신")));
  expect(ui.host.textContent).not.toContain("A 첫 과제");
  expect(ui.host.textContent).toContain("갱신 제출 과제");
  expect(timestamp()).toBe(new Date(now + 60000).toISOString());
  expect(query.mock.calls.at(-1)?.[1]).toMatchObject({ refresh: true, target });
});
it.each(["NETWORK", "TIMEOUT"] as const)("keeps only the last successful time after %s and retries with a real refresh", async (code) => {
  await loadCourse();
  const previous = timestamp();
  vi.setSystemTime(now + 180000);
  query.mockResolvedValueOnce({ status: "error", code });
  await refresh();
  expect(ui.host.querySelector('[role="alert"]')).not.toBeNull();
  expect(ui.host.textContent).not.toContain("A 첫 과제");
  expect(timestamp()).toBe(previous);
  query.mockResolvedValueOnce(result("재시도"));
  await refresh();
  expect(ui.host.textContent).toContain("재시도 첫 과제");
  expect(timestamp()).toBe(new Date(now + 180000).toISOString());
  expect(query.mock.calls.at(-1)?.[1]).toMatchObject({ refresh: true, target });
});
it.each(["LOGIN_REQUIRED", "FORBIDDEN", "RELOAD_TAB", "STALE_SELECTION"] as const)(
  "clears old assignment rows, details and time on %s", async (code) => {
    await loadCourse();
    await click("A 첫 과제");
    expect(ui.host.textContent).toContain("제출 상태");
    query.mockResolvedValueOnce({ status: "error", code });
    await refresh();
    expect(ui.host.textContent).not.toContain("A 첫 과제");
    expect(ui.host.textContent).not.toContain("제출 상태");
    expect(timestamp()).toBeUndefined();
  },
);
it("does not publish an old assignment result after switching to tasks", async () => {
  await loadCourse();
  const held = deferred<Result>();
  query.mockReturnValueOnce(held.promise);
  await refresh();
  await click("일정");
  expect(ui.host.textContent).not.toContain("A 첫 과제");
  expect(timestamp()).toBeUndefined();
  await act(async () => held.resolve(result("늦은 응답")));
  expect(ui.host.textContent).not.toContain("늦은 응답");
  expect(timestamp()).toBeUndefined();
  expect(query.mock.calls.at(-1)?.[0].type).toBe("TODO_LIST");
});
it("does not carry the previous course snapshot into another course", async () => {
  await loadCourse();
  const held = deferred<Result>();
  query.mockReturnValueOnce(held.promise);
  await refresh();
  await click("← 과목 선택");
  expect(ui.host.textContent).not.toContain("A 첫 과제");
  await act(async () => held.resolve(result("늦은 A")));
  await click("과목 B");
  expect(ui.host.textContent).toContain("B 첫 과제");
  expect(ui.host.textContent).not.toContain("늦은 A");
  expect(query.mock.calls.at(-1)?.[0]).toMatchObject({ courseSelector: secondCourse });
});
