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
  documentToken: "00000000-0000-4000-8000-000000000099",
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
    storage: {
      local: { get: vi.fn().mockResolvedValue({}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
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
    .mockResolvedValue({ status: "success", courses: [] });
  ui = await mount(<App />);
  await click("일정");
  await click("홈");
  await click("자동 재생");
  await click("영상 선택");
  expect(ui.host.querySelectorAll("select option")).toHaveLength(1);
  await click("내 과목");
  expect(query).toHaveBeenCalledTimes(1);

  await act(async () => held.resolve({ status: "success", todo: [] }));

  expect(query).toHaveBeenCalledTimes(3);
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
it("returns keyboard focus to the information trigger when closing it", async () => {
  ui = await mount(<App />);
  const trigger = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "설정",
  );
  trigger?.focus();
  await click("설정");
  expect(trigger?.getAttribute("aria-current")).toBe("page");
  expect([...ui.host.querySelectorAll('nav [aria-current="page"]')]).toEqual([
    trigger,
  ]);
  await click("← 돌아가기");
  expect(document.activeElement).toBe(trigger);
  expect(trigger?.hasAttribute("aria-current")).toBe(false);
});
it("waits for the pending request then loads the last selected menu automatically", async () => {
  // Given
  const first = deferred<Result>();
  query
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ status: "success", todo: [] });
  ui = await mount(<App />);
  // When
  await click("일정");
  await click("일정 목록 보기");
  await click("내 과목");
  await click("일정");
  await click("할 일");
  expect(query).toHaveBeenCalledTimes(1);
  expect(ui.host.querySelector('button[aria-label="새로고침"]')?.getAttribute("aria-busy")).toBe("true");
  await act(async () => first.resolve({ status: "success", todo: [] }));
  // Then
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[1]?.[0]).toEqual({ version: 1, type: "TODO_LIST" });
  expect(document.body.textContent).toContain("조회된 항목이 없습니다");
  expect(document.body.textContent).not.toContain(
    "이전 조회를 처리하고 있습니다",
  );
});
it("keeps background results behind captions and drops requests after unmounting", async () => {
  // Given
  const first = deferred<Result>();
  query.mockReturnValueOnce(first.promise).mockResolvedValue({ status: "success", todo: [] });
  ui = await mount(<App />);
  // When
  await click("일정");
  await click("일정 목록 보기");
  await click("홈");
  await click("자막 추출");
  await act(async () => first.resolve({ status: "success", todo: [] }));
  // Then
  expect(query).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).toContain("자막 화면");
  const next = deferred<Result>();
  query.mockReturnValueOnce(next.promise);
  await click("일정");
  await click("할 일");
  await ui.unmount();
  await act(async () => next.resolve({ status: "success", upcoming: [] }));
  expect(query).toHaveBeenCalledTimes(3);
});
it("reloads courses through the content cache when returning during a pending query", async () => {
  // Given
  const pending = deferred<Result>();
  query
    .mockImplementationOnce(courseQuery)
    .mockReturnValueOnce(pending.promise)
    .mockImplementationOnce(courseQuery);
  ui = await mount(<App />);
  await click("내 과목");
  // When
  await click("일정");
  await click("일정 목록 보기");
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
  await click("일정");
  await click("일정 목록 보기");
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
  await click("내 과목");
  await click("일정");
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
  await click("내 과목");
  await click("과목");
  await click("강의 자료");
  // Then
  expect(query).toHaveBeenLastCalledWith(
    { version: 1, type: "DOCUMENTS_LIST", courseSelector },
    expect.objectContaining({ onTarget: expect.any(Function) }),
  );
  expect(
    ui.host.querySelectorAll('nav[aria-label="주 메뉴"] button'),
  ).toHaveLength(4);
  expect(document.body.textContent).toContain(
    "주차학습·게시판에서 확인 가능한 강의 자료가 없습니다.",
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
  await click("내 과목");
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
  source: "module" as const,
  lmsHandle: crypto.randomUUID(),
  launchHandle: crypto.randomUUID(),
}));
const rowActionLabels = () =>
  [...ui.host.querySelectorAll(".row-action")].map((b) => b.textContent);
async function showRecordings() {
  query
    .mockImplementationOnce(courseQuery)
    .mockResolvedValueOnce({ status: "success", assignments: [] })
    .mockImplementationOnce(async (_query, options) => {
      options.onTarget(recordingTarget);
      return { status: "success", recordings };
    });
  ui = await mount(<App />);
  await click("내 과목");
  await click("과목");
  await click("녹화 강의");
  await click("첫 강의");
}
it("keeps recordings visible and opens subsequent selections in the original LMS tab", async () => {
  // Given
  await showRecordings();
  query.mockResolvedValue({ status: "success", opened: true });
  // When
  await click("강의 열기 ↗");
  // Then
  expect(
    ui.host.querySelector<HTMLButtonElement>(".detail-view .btn-primary")
      ?.disabled,
  ).toBe(true);
  await click("← 목록");
  expect(rowActionLabels()).toEqual(["열었음", "강의 열기 "]);
  await click("두 번째 강의");
  expect(
    ui.host.querySelector<HTMLButtonElement>(".detail-view .btn-primary")
      ?.disabled,
  ).toBe(false);
  await click("강의 열기 ↗");
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
  await click("강의 열기 ↗");
  await click("강의 열기 ↗");
  expect(query).toHaveBeenCalledTimes(4);
  await act(async () => pending.resolve({ status: "error", code: "BUSY" }));
  // Then
  expect(document.body.textContent).toContain("두 번째 강의");
  query.mockResolvedValueOnce({ status: "error", code: "STALE_SELECTION" });
  await click("강의 열기 ↗");
  expect(document.body.textContent).toContain("선택이 만료");
  expect(
    ui.host.querySelector<HTMLButtonElement>(".detail-view .btn-primary")
      ?.disabled,
  ).toBe(true);
  // A consumed but failed handle must not read as a successful open.
  await click("← 목록");
  expect(rowActionLabels()).toEqual(["새로고침 필요", "강의 열기 "]);
});
it("does not replace the next menu when an open finishes late", async () => {
  // Given
  await showRecordings();
  const pending = deferred<Result>();
  query
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ status: "success", todo: [] });
  // When
  await click("강의 열기 ↗");
  await click("일정");
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
  await click("일정");
  // When / Then: each list's detail offers the same validated LMS target.
  for (const title of ["할 일 게시글", "일정 게시글"]) {
    await click(title);
    const link = ui.host.querySelector<HTMLAnchorElement>(".item-title-link");
    expect(link?.href).toBe(html_url);
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noreferrer");
    await click("← 목록");
    if (title === "할 일 게시글") await click("일정 목록 보기");
  }
});
function noticeMessages(notice: "first_run" | "changed") {
  return vi.fn(async (message: { type: string; enabled?: boolean }) =>
    message.type === "ANALYTICS_STATUS"
      ? { available: true, enabled: true, notice }
      : message.type === "ANALYTICS_SET"
        ? { available: true, enabled: message.enabled, notice: null }
        : { available: true, enabled: true, notice: null },
  );
}
it("shows the first-run statistics notice, marks it shown, and dismisses it without changing the setting", async () => {
  // Given: a fresh install whose statistics are on by default.
  const sendMessage = noticeMessages("first_run");
  vi.stubGlobal("chrome", {
    runtime: { sendMessage },
    storage: {
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    downloads: {
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  ui = await mount(<App />);
  await act(async () => {});
  const notice = () =>
    document.querySelector('[aria-label="사용 통계 안내"]');
  expect(notice()?.textContent).toContain("기본 켜짐");
  expect(notice()?.textContent).toContain("설정 → 사용");
  expect(sendMessage).toHaveBeenCalledWith({
    version: 1,
    type: "ANALYTICS_NOTICE_SHOWN",
  });
  // The notice stays after the background marks it shown.
  await act(async () => {});
  expect(notice()).not.toBeNull();
  // When
  await click("확인");
  // Then
  expect(notice()).toBeNull();
  expect(sendMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "ANALYTICS_SET" }),
  );
});
it("turns statistics off from the change notice", async () => {
  const sendMessage = noticeMessages("changed");
  vi.stubGlobal("chrome", { ...chrome, runtime: { sendMessage } });
  ui = await mount(<App />);
  await act(async () => {});
  expect(
    document.querySelector('[aria-label="사용 통계 안내"]')?.textContent,
  ).toContain("방식이 바뀌었습니다");
  await click("통계 끄기");
  expect(sendMessage).toHaveBeenCalledWith({
    version: 1,
    type: "ANALYTICS_SET",
    enabled: false,
  });
});
it("focuses the analytics group and returns to its contextual trigger", async () => {
  // Given
  vi.stubGlobal("chrome", {
    ...chrome,
    runtime: { sendMessage: noticeMessages("first_run") },
  });
  ui = await mount(<App />);
  await act(async () => {});
  const trigger = [...ui.host.querySelectorAll("button")].find(
    (button) => button.textContent === "자세히",
  );
  trigger?.focus();
  // When
  await click("자세히");
  // Then
  expect(document.activeElement).toBe(ui.host.querySelector("#analytics-title"));
  await click("← 돌아가기");
  expect(document.activeElement).toBe(trigger);
});

it("starts on Home and opens a task from the nearest three future deadlines", async () => {
  const todo = [
    ["네 번째", "2099-05-04T00:00:00Z"],
    ["지난 과제", "2000-01-01T00:00:00Z"],
    ["두 번째", "2099-05-02T00:00:00Z"],
    ["첫 번째", "2099-05-01T00:00:00Z"],
    ["세 번째", "2099-05-03T00:00:00Z"],
    ["날짜 없음", ""],
  ].map(([title, due_at]) => ({
    title, due_at, course: "샘플 과목", type: "submitting", ignore: false,
    html_url: "https://mylms.korea.ac.kr/courses/12/assignments/34",
  }));
  query.mockResolvedValue({ status: "success", todo });
  ui = await mount(<App />);
  expect(ui.host.querySelector('nav [aria-current="page"]')?.textContent).toBe("홈");
  expect(query).not.toHaveBeenCalled();
  await click("새로고침");
  expect([...ui.host.querySelectorAll(".list-row strong")].map((row) => row.textContent))
    .toEqual(["첫 번째", "두 번째", "세 번째"]);
  await click("첫 번째");
  expect(ui.host.querySelector(".detail-view h2")?.textContent).toBe("첫 번째");
  expect(ui.host.querySelector(".item-title-link")?.getAttribute("href"))
    .toBe("https://mylms.korea.ac.kr/courses/12/assignments/34");
  await click("← 목록");
  await click("전체 할 일");
  expect(ui.host.textContent).toContain("날짜 없음");
  expect(ui.host.textContent).toContain("지난 과제");
});

it("returns from playback to the same recording detail and focused entry control", async () => {
  await showRecordings();
  const entry = [...ui.host.querySelectorAll<HTMLButtonElement>(".detail-view button")]
    .find((button) => button.textContent === "자동 재생");
  entry?.focus();
  await click("자동 재생");
  const picker = ui.host.querySelector(".playback-panel");
  expect(picker?.closest("[hidden]")).toBeNull();
  expect(picker?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  expect(query).toHaveBeenCalledTimes(3);
  await click("← 돌아가기");
  expect(picker?.closest("[hidden]")).not.toBeNull();
  expect(ui.host.querySelector(".course-context h2")?.textContent).toBe("과목");
  expect(document.activeElement).toBe(entry);
  expect(ui.host.querySelector(".course-context")?.closest("[hidden]")).toBeNull();
});

it("opens the selected lecture before entering captions and keeps its return context", async () => {
  await showRecordings();
  query.mockResolvedValueOnce({ status: "error", code: "BUSY" });
  await click("강의 열고 자막 추출");
  expect(ui.host.textContent).not.toContain("자막 화면");
  query.mockResolvedValueOnce({ status: "success", opened: true });
  await click("강의 열고 자막 추출");
  expect(ui.host.textContent).toContain("자막 화면");
  expect(query).toHaveBeenLastCalledWith(
    { version: 1, type: "RECORDING_OPEN", handle: recordings[0]?.launchHandle },
    { target: recordingTarget },
  );
  await click("← 돌아가기");
  expect(ui.host.querySelector(".course-context")?.closest("[hidden]")).toBeNull();
  expect(ui.host.querySelector(".detail-view h2")?.textContent).toBe("첫 강의");
});

it("keeps a chosen playback draft mounted when visiting another main menu", async () => {
  await showRecordings();
  await click("자동 재생");
  const picker = ui.host.querySelector(".playback-panel");
  query.mockResolvedValue({ status: "success", todo: [] });
  await click("일정");
  expect(picker?.closest("[hidden]")).not.toBeNull();
  await click("홈");
  await click("자동 재생");
  expect(ui.host.querySelector(".playback-panel")).toBe(picker);
  expect(picker?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
});

it("does not replace settings when a previously requested lecture finishes opening", async () => {
  await showRecordings();
  const opened = deferred<Result>();
  query.mockReturnValueOnce(opened.promise);
  await click("강의 열고 자막 추출");
  await click("설정");
  await act(async () => opened.resolve({ status: "success", opened: true }));
  expect(ui.host.querySelector('nav [aria-current="page"]')?.textContent).toBe("설정");
  expect(ui.host.textContent).not.toContain("자막 화면");
  await click("← 돌아가기");
  expect(ui.host.querySelector(".course-context")?.closest("[hidden]")).toBeNull();
});
