// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Result } from "../src/protocol";
import { mount, click, deferred } from "./ui-helpers";
const query = vi.hoisted(() => vi.fn());
const command = vi.hoisted(() => vi.fn());
vi.mock("../src/transport", () => ({ queryActive: query }));
vi.mock("../src/playback/bridge", () => ({ playbackCommand: command }));
vi.mock("../entrypoints/sidepanel/CaptionsPanel", () => ({
  CaptionsPanel: () => <p>자막 화면</p>,
}));
import { App } from "../entrypoints/sidepanel/App";
let ui: Awaited<ReturnType<typeof mount>>;
const courseSelector = "00000000-0000-4000-8000-000000000012";
const recordingTarget = {
  id: 7,
  url: "https://mylms.korea.ac.kr/courses/1/modules",
};
const courseQuery = async (
  _request: unknown,
  options: { onTarget: (target: typeof recordingTarget) => void },
) => {
  options.onTarget(recordingTarget);
  return {
    status: "success" as const,
    courses: [{ name: "과목", courseSelector }],
  };
};
beforeEach(() => {
  command.mockResolvedValue({
    status: "success",
    snapshot: {
      courses: [{ id: "12", name: "Course" }],
      labels: {},
      current: null,
      queue: [],
      status: "idle",
    },
  });
  vi.stubGlobal("chrome", {
    downloads: {
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
});
it("shares the query gate across main and playback navigation", async () => {
  const held = deferred<Result>();
  query
    .mockReturnValueOnce(held.promise)
    .mockResolvedValueOnce({ status: "success", courses: [] });
  ui = await mount(<App />);
  await click("할 일·일정");
  await click("자동 재생");
  await click("영상 선택");
  expect(ui.host.querySelectorAll("select option")).toHaveLength(1);
  await click("내 과목");
  expect(query).toHaveBeenCalledTimes(1);

  await act(async () => held.resolve({ status: "success", todo: [] }));

  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[1]?.[0]).toEqual({
    version: 1,
    type: "COURSES_LIST",
  });
  expect(
    query.mock.calls.some(([request]) => request.type === "RECORDINGS_LIST"),
  ).toBe(false);
});
afterEach(async () => {
  await ui?.unmount();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
it("waits for the pending request then loads the last selected menu automatically", async () => {
  // Given
  const first = deferred<Result>();
  query
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ status: "success", todo: [] });
  ui = await mount(<App />);
  // When
  await click("할 일·일정");
  await click("일정");
  await click("내 과목");
  await click("할 일·일정");
  await click("할 일");
  expect(query).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("조회 중…");
  await act(async () => first.resolve({ status: "success", todo: [] }));
  // Then
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[1]?.[0]).toEqual({ version: 1, type: "TODO_LIST" });
  expect(document.body.textContent).toContain("조회된 항목이 없습니다");
  expect(document.body.textContent).not.toContain(
    "이전 조회를 처리하고 있습니다",
  );
});
it("drops queued requests after switching to captions or unmounting", async () => {
  // Given
  const first = deferred<Result>();
  query.mockReturnValueOnce(first.promise);
  ui = await mount(<App />);
  // When
  await click("할 일·일정");
  await click("일정");
  await click("자막 추출");
  await act(async () => first.resolve({ status: "success", todo: [] }));
  // Then
  expect(query).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("자막 화면");
  const next = deferred<Result>();
  query.mockReturnValueOnce(next.promise);
  await click("할 일·일정");
  await click("할 일");
  await ui.unmount();
  await act(async () => next.resolve({ status: "success", upcoming: [] }));
  expect(query).toHaveBeenCalledTimes(2);
});
it("reloads courses through the content cache when returning during a pending query", async () => {
  // Given
  const pending = deferred<Result>();
  query
    .mockImplementationOnce(courseQuery)
    .mockReturnValueOnce(pending.promise)
    .mockImplementationOnce(courseQuery);
  ui = await mount(<App />);
  await click("새로고침");
  // When
  await click("할 일·일정");
  await click("일정");
  await click("내 과목");
  await act(async () => pending.resolve({ status: "success", todo: [] }));
  // Then
  expect(query).toHaveBeenCalledTimes(3);
  expect(query.mock.calls[2]?.[0]).toEqual({
    version: 1,
    type: "COURSES_LIST",
  });
  expect(ui.host.querySelector("li strong")?.textContent).toBe("과목");
});
it("runs the queued request even after the previous request fails", async () => {
  // Given
  const pending = deferred<Result>();
  query
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ status: "success", upcoming: [] });
  ui = await mount(<App />);
  // When
  await click("할 일·일정");
  await click("일정");
  await act(async () => pending.resolve({ status: "error", code: "NETWORK" }));
  // Then
  expect(query).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain("조회된 항목이 없습니다");
});
it("does not publish an old course list after a newer view is selected", async () => {
  const oldList = deferred<Result>();
  query
    .mockReturnValueOnce(oldList.promise)
    .mockResolvedValueOnce({ status: "success", todo: [] });
  ui = await mount(<App />);
  await click("새로고침");
  await click("할 일·일정");
  await act(async () =>
    oldList.resolve({
      status: "success",
      courses: [{ name: "오래된 과목", courseSelector }],
    }),
  );

  expect(document.body.textContent).not.toContain("오래된 과목");
  expect(document.body.textContent).toContain("조회된 항목이 없습니다");
});
it("opens the selected course materials view through the four-item rail", async () => {
  // Given
  query
    .mockImplementationOnce(courseQuery)
    .mockResolvedValueOnce({ status: "success", assignments: [] })
    .mockResolvedValueOnce({ status: "success", documents: [] });
  ui = await mount(<App />);
  // When
  await click("새로고침");
  await click("과목");
  await click("수업 자료");
  // Then
  expect(query).toHaveBeenLastCalledWith(
    { version: 1, type: "DOCUMENTS_LIST", courseSelector },
    expect.objectContaining({ onTarget: expect.any(Function) }),
  );
  expect(
    ui.host.querySelectorAll('nav[aria-label="주 메뉴"] button'),
  ).toHaveLength(4);
  expect(document.body.textContent).toContain(
    "모듈에서 확인 가능한 PDF가 없습니다.",
  );
});
it("selects duplicate course names by opaque selector and keeps the listing source", async () => {
  const secondSelector = "00000000-0000-4000-8000-000000000013";
  query
    .mockImplementationOnce(async (_request, options) => {
      options.onTarget(recordingTarget);
      return {
        status: "success",
        courses: [
          { name: "같은 과목", courseSelector },
          { name: "같은 과목", courseSelector: secondSelector },
        ],
      };
    })
    .mockResolvedValueOnce({ status: "success", assignments: [] });
  ui = await mount(<App />);
  await click("새로고침");
  const duplicateRows = [
    ...ui.host.querySelectorAll<HTMLButtonElement>(".list-row"),
  ].filter((button) => button.textContent?.includes("같은 과목"));
  await act(async () => duplicateRows[1]!.click());

  expect(query).toHaveBeenLastCalledWith(
    {
      version: 1,
      type: "ASSIGNMENTS_LIST",
      courseSelector: secondSelector,
    },
    { refresh: undefined, target: recordingTarget },
  );
});
const recordings = ["첫 강의", "두 번째 강의"].map((title) => ({
  module: "주차",
  title,
  type: "ExternalTool" as const,
  lmsHandle: crypto.randomUUID(),
  launchHandle: crypto.randomUUID(),
}));
async function showRecordings() {
  query
    .mockImplementationOnce(courseQuery)
    .mockResolvedValueOnce({ status: "success", assignments: [] })
    .mockImplementationOnce(async (_query, options) => {
      options.onTarget(recordingTarget);
      return { status: "success", recordings };
    });
  ui = await mount(<App />);
  await click("새로고침");
  await click("과목");
  await click("녹화 강의");
  await click("첫 강의");
}
it("keeps recordings visible and opens subsequent selections in the original LMS tab", async () => {
  // Given
  await showRecordings();
  query.mockResolvedValue({ status: "success", opened: true });
  // When
  await click("LTI 탭 열기 ↗");
  // Then
  expect(
    ui.host.querySelector<HTMLButtonElement>(".detail-view .btn-primary")
      ?.disabled,
  ).toBe(true);
  await click("← 목록");
  await click("두 번째 강의");
  expect(
    ui.host.querySelector<HTMLButtonElement>(".detail-view .btn-primary")
      ?.disabled,
  ).toBe(false);
  await click("LTI 탭 열기 ↗");
  expect(query.mock.calls.slice(3).map((call) => call[1])).toEqual([
    { target: recordingTarget },
    { target: recordingTarget },
  ]);
  expect(query).toHaveBeenCalledTimes(5);
});
it("prevents duplicate opens and preserves the list on a retryable failure", async () => {
  // Given
  await showRecordings();
  const pending = deferred<Result>();
  query.mockReturnValueOnce(pending.promise);
  // When
  await click("LTI 탭 열기 ↗");
  await click("LTI 탭 열기 ↗");
  expect(query).toHaveBeenCalledTimes(4);
  await act(async () => pending.resolve({ status: "error", code: "BUSY" }));
  // Then
  expect(document.body.textContent).toContain("두 번째 강의");
  query.mockResolvedValueOnce({ status: "error", code: "STALE_SELECTION" });
  await click("LTI 탭 열기 ↗");
  expect(document.body.textContent).toContain("선택이 만료");
  expect(
    ui.host.querySelector<HTMLButtonElement>(".detail-view .btn-primary")
      ?.disabled,
  ).toBe(true);
});
it("does not replace the next menu when an open finishes late", async () => {
  // Given
  await showRecordings();
  const pending = deferred<Result>();
  query
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ status: "success", todo: [] });
  // When
  await click("LTI 탭 열기 ↗");
  await click("할 일·일정");
  await act(async () => pending.resolve({ status: "success", opened: true }));
  // Then
  expect(document.body.textContent).toContain("조회된 항목이 없습니다");
  expect(document.body.textContent).not.toContain("새 LMS/LTI 탭을 열었습니다");
});
it("links task and schedule details to their LMS posts", async () => {
  // Given
  const html_url = "https://mylms.korea.ac.kr/courses/12/assignments/34";
  query
    .mockResolvedValueOnce({
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
    })
    .mockResolvedValueOnce({
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
  ui = await mount(<App />);
  await click("할 일·일정");
  // When / Then: each list's detail offers the same validated LMS target.
  for (const title of ["할 일 게시글", "일정 게시글"]) {
    await click(title);
    const link = ui.host.querySelector<HTMLAnchorElement>(".item-title-link");
    expect(link?.href).toBe(html_url);
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noreferrer");
    await click("← 목록");
    if (title === "할 일 게시글") await click("일정");
  }
});
