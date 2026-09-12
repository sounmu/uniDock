// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Result } from "../src/protocol";
import { mount, click, deferred } from "./ui-helpers";
const query = vi.hoisted(() => vi.fn());
vi.mock("../src/transport", () => ({ queryActive: query }));
vi.mock("../entrypoints/sidepanel/CaptionsPanel", () => ({
  CaptionsPanel: () => <p>자막 화면</p>,
}));
import { App } from "../entrypoints/sidepanel/App";
let ui: Awaited<ReturnType<typeof mount>>;
afterEach(async () => {
  await ui?.unmount();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
it("waits for the pending request then loads the last selected menu automatically", async () => {
  const first = deferred<Result>();
  query
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ status: "success", todo: [] });
  ui = await mount(<App />);
  await click("전체 일정");
  await click("내 과목");
  await click("Todo");
  expect(query).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("조회 중…");
  await act(async () => first.resolve({ status: "success", upcoming: [] }));
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[1]![0]).toEqual({ version: 1, type: "TODO_LIST" });
  expect(document.body.textContent).toContain("조회된 항목이 없습니다");
  expect(document.body.textContent).not.toContain(
    "이전 조회를 처리하고 있습니다",
  );
});
it("drops queued requests after switching to captions or unmounting", async () => {
  const first = deferred<Result>();
  query.mockReturnValueOnce(first.promise);
  ui = await mount(<App />);
  await click("전체 일정");
  await click("Todo");
  await click("자막 추출");
  await act(async () => first.resolve({ status: "success", upcoming: [] }));
  expect(query).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("자막 화면");
  const next = deferred<Result>();
  query.mockReturnValueOnce(next.promise);
  await click("Todo");
  await click("전체 일정");
  await ui.unmount();
  await act(async () => next.resolve({ status: "success", todo: [] }));
  expect(query).toHaveBeenCalledTimes(2);
});
it("keeps cached courses visible when returning while another query is pending", async () => {
  const pending = deferred<Result>();
  query
    .mockResolvedValueOnce({ status: "success", courses: [{ name: "과목" }] })
    .mockReturnValueOnce(pending.promise);
  ui = await mount(<App />);
  await click("조회");
  await click("전체 일정");
  await click("Todo");
  await click("내 과목");
  await act(async () => pending.resolve({ status: "success", upcoming: [] }));
  expect(query).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain("과제 보기");
});
it("runs the queued request even after the previous request fails", async () => {
  const pending = deferred<Result>();
  query
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ status: "success", todo: [] });
  ui = await mount(<App />);
  await click("전체 일정");
  await click("Todo");
  await act(async () => pending.resolve({ status: "error", code: "NETWORK" }));
  expect(query).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain("조회된 항목이 없습니다");
});
