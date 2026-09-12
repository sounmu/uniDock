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

const recordingTarget = {
  id: 7,
  url: "https://mylms.korea.ac.kr/courses/1/modules",
};
const recordings = ["첫 강의", "두 번째 강의"].map((title) => ({
  module: "주차",
  title,
  type: "ExternalTool" as const,
  lmsHandle: crypto.randomUUID(),
  launchHandle: crypto.randomUUID(),
}));
async function showRecordings() {
  query
    .mockResolvedValueOnce({ status: "success", courses: [{ name: "과목" }] })
    .mockImplementationOnce(async (_query, options) => {
      options.onTarget(recordingTarget);
      return { status: "success", recordings };
    });
  ui = await mount(<App />);
  await click("조회");
  await click("녹화 보기");
}
it("keeps recordings visible and opens subsequent selections in the original LMS tab", async () => {
  await showRecordings();
  query.mockResolvedValue({ status: "success", opened: true });
  await click("LTI 탭 열기 ↗");
  expect(document.body.textContent).toContain("두 번째 강의");
  const buttons = [...document.querySelectorAll("button")].filter(
    (b) => b.textContent === "LTI 탭 열기 ↗",
  );
  expect(buttons[0]!.disabled).toBe(true);
  expect(buttons[1]!.disabled).toBe(false);
  await click("LTI 탭 열기 ↗", 1);
  expect(query.mock.calls.slice(2).map((call) => call[1])).toEqual([
    { target: recordingTarget },
    { target: recordingTarget },
  ]);
  expect(query).toHaveBeenCalledTimes(4);
});
it("prevents duplicate opens and preserves the list on a retryable failure", async () => {
  await showRecordings();
  const pending = deferred<Result>();
  query.mockReturnValueOnce(pending.promise);
  await click("LTI 탭 열기 ↗");
  await click("LTI 탭 열기 ↗");
  expect(query).toHaveBeenCalledTimes(3);
  await act(async () => pending.resolve({ status: "error", code: "BUSY" }));
  expect(document.body.textContent).toContain("두 번째 강의");
  query.mockResolvedValueOnce({ status: "error", code: "STALE_SELECTION" });
  await click("LTI 탭 열기 ↗");
  expect(document.body.textContent).toContain("선택이 만료");
  expect(
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "LTI 탭 열기 ↗",
    )!.disabled,
  ).toBe(true);
});
it("does not replace the next menu when an open finishes late", async () => {
  await showRecordings();
  const pending = deferred<Result>();
  query
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ status: "success", todo: [] });
  await click("LTI 탭 열기 ↗");
  await click("Todo");
  await act(async () => pending.resolve({ status: "success", opened: true }));
  expect(document.body.textContent).toContain("조회된 항목이 없습니다");
  expect(document.body.textContent).not.toContain("새 LMS/LTI 탭을 열었습니다");
});

it("links schedule and Todo titles to their LMS posts", async () => {
  const html_url = "https://mylms.korea.ac.kr/courses/12/assignments/34";
  query.mockResolvedValueOnce({
    status: "success",
    upcoming: [
      {
        title: "일정 게시글",
        date: "",
        course: "",
        type: "assignment",
        submitted: false,
        new_activity: false,
        html_url,
      },
    ],
  });
  query.mockResolvedValueOnce({
    status: "success",
    todo: [
      {
        title: "할 일 게시글",
        due_at: "",
        course: "",
        type: "submitting",
        ignore: false,
        html_url,
      },
    ],
  });
  ui = await mount(<App />);
  for (const [menu, title] of [
    ["전체 일정", "일정 게시글"],
    ["Todo", "할 일 게시글"],
  ]) {
    await click(menu!);
    const link = ui.host.querySelector<HTMLAnchorElement>(".item-title-link");
    expect(link?.textContent).toBe(title);
    expect(link?.href).toBe(html_url);
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noreferrer");
  }
});
