// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ResultList } from "../entrypoints/sidepanel/ResultList";
import { mount, click } from "./ui-helpers";
import * as deadlineView from "../src/deadline-view";
let ui: Awaited<ReturnType<typeof mount>>;
async function openAssignmentView() {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[aria-label="보기 변경"]',
  );
  expect(trigger).not.toBeNull();
  await act(async () => trigger?.click());
}
afterEach(async () => {
  await ui?.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it.each(["todo", "upcoming"] as const)(
  "does not repeat %s sorting on clock ticks while hidden",
  async (type) => {
    // Given: use the real sorter and hide the mounted list as settings does.
    vi.useFakeTimers();
    const now = Date.parse("2026-10-12T00:00:00Z");
    vi.setSystemTime(now);
    const sorter = vi.spyOn(
      deadlineView,
      type === "todo" ? "sortByDue" : "sortByDateDesc",
    );
    const common = { title: "경계 항목", course: "A", type: "assignment" };
    const date = new Date(now + 1000).toISOString();
    const result =
      type === "todo"
        ? { status: "success" as const, todo: [{ ...common, due_at: date, ignore: false }] }
        : { status: "success" as const, upcoming: [{ ...common, date, submitted: false, new_activity: false }] };
    ui = await mount(
      <div hidden><ResultList result={result} onCourse={() => {}} /></div>,
    );
    const calls = sorter.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    // When
    await act(async () => vi.advanceTimersByTime(2000));
    // Then: clock-dependent status still crosses its boundary.
    expect(sorter).toHaveBeenCalledTimes(calls);
    if (type === "todo")
      expect(document.querySelector(".overdue-group li")).not.toBeNull();
    else
      expect(document.querySelector(".status-chip")?.textContent).toMatch(/^지남/);
  },
);
it("resets pagination on filter changes, preserves it on ticks, and expires candidates", async () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-09-12T00:00:00Z");
  vi.setSystemTime(now);
  const deadlines = Array.from({ length: 105 }, (_, i) => ({
    title: `과제 ${i}`,
    due_at: new Date(now + 60000).toISOString(),
    remaining_candidate: true,
  }));
  ui = await mount(
    <ResultList
      result={{ status: "success", deadlines }}
      onCourse={() => {}}
    />,
  );
  await openAssignmentView();
  expect(
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "남은 과제")
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
  await click("105개 과제 보기");
  await click("다음");
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  expect(document.body.textContent).toContain("101–105 / 105개");
  await openAssignmentView();
  await click("전체");
  await click("105개 과제 보기");
  expect(document.body.textContent).toContain("1–100 / 105개");
  await openAssignmentView();
  await click("남은 과제");
  await click("105개 과제 보기");
  await act(async () => {
    vi.advanceTimersByTime(59000);
  });
  expect(document.body.textContent).toContain("조건에 맞는 과제가 없습니다.");
  expect(document.querySelectorAll("li")).toHaveLength(0);
});
it("sorts the whole response before pagination and returns to LMS order", async () => {
  const deadlines = Array.from({ length: 105 }, (_, i) => ({
    title: `과제 ${i}`,
    due_at: new Date(Date.UTC(2027, 0, 1) - i * 60000).toISOString(),
    remaining_candidate: false,
  }));
  ui = await mount(
    <ResultList
      result={{ status: "success", deadlines }}
      onCourse={() => {}}
    />,
  );
  expect(document.querySelectorAll("li")).toHaveLength(0);
  await act(async () =>
    document.querySelector<HTMLButtonElement>(".assignment-all-link")?.click(),
  );
  expect(document.querySelectorAll("li")).toHaveLength(100);
  await openAssignmentView();
  const select = document.querySelectorAll("select")[1]!;
  await act(async () => {
    select.value = "due";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("105개 과제 보기");
  expect(document.querySelector("li strong")?.textContent).toBe("과제 104");
  await openAssignmentView();
  await act(async () => {
    const order = document.querySelectorAll("select")[1]!;
    order.value = "original";
    order.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("105개 과제 보기");
  expect(document.querySelector("li strong")?.textContent).toBe("과제 0");
});
it("sorts Todo latest due first by default and offers other orders", async () => {
  ui = await mount(
    <ResultList
      result={{
        status: "success",
        todo: [
          {
            title: "마감 없음",
            due_at: "",
            type: "unsubmitted",
            course: "A",
            ignore: false,
          },
          {
            title: "늦은 마감",
            due_at: "2027-02-01T00:00:00Z",
            type: "unsubmitted",
            course: "B",
            ignore: false,
          },
          {
            title: "빠른 마감",
            due_at: "2027-01-01T00:00:00Z",
            type: "unsubmitted",
            course: "A",
            ignore: false,
          },
        ],
      }}
      onCourse={() => {}}
    />,
  );
  expect(
    [...document.querySelectorAll("li strong")].map((node) => node.textContent),
  ).toEqual(["늦은 마감", "빠른 마감", "마감 없음"]);
  await click("보기 설정");
  const select = document.querySelector("select")!;
  expect(select.value).toBe("due-desc");
  await act(async () => {
    select.value = "original";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(
    [...document.querySelectorAll("li strong")].map((node) => node.textContent),
  ).toEqual(["마감 없음", "늦은 마감", "빠른 마감"]);
  await act(async () => {
    select.value = "due";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(
    [...document.querySelectorAll("li strong")].map((node) => node.textContent),
  ).toEqual(["빠른 마감", "늦은 마감", "마감 없음"]);
});
it("collapses unsubmitted overdue Todo rows into a trailing group", async () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-10-12T00:00:00Z");
  vi.setSystemTime(now);
  const todo = (title: string, offset: number, type = "unsubmitted") => ({
    title,
    due_at: new Date(now + offset).toISOString(),
    type,
    course: "A",
    ignore: false,
  });
  ui = await mount(
    <ResultList
      result={{
        status: "success",
        todo: [
          todo("오래 지남", -2 * 86400000),
          todo("남은 과제", 86400000 * 3),
          todo("방금 지남", -60000),
          todo("제출 완료", -86400000, "submitted"),
        ],
      }}
      onCourse={() => {}}
    />,
  );
  const group = document.querySelector<HTMLDetailsElement>(".overdue-group")!;
  expect(group.open).toBe(false);
  expect(group.querySelector("summary")?.textContent).toBe("마감 지남2개");
  const titles = (root: ParentNode) =>
    [...root.querySelectorAll("li strong")].map((node) => node.textContent);
  expect(titles(group)).toEqual(["방금 지남", "오래 지남"]);
  expect(
    titles(document).filter((title) => !titles(group).includes(title)),
  ).toEqual(["남은 과제", "제출 완료"]);
  await act(async () => group.querySelector("summary")!.click());
  expect(group.open).toBe(true);
  await act(async () => vi.advanceTimersByTime(3 * 86400000));
  expect(titles(group)).toEqual(["남은 과제", "방금 지남", "오래 지남"]);
});
interface StatusRow {
  row: HTMLElement;
  icon: HTMLElement | null;
}
function rowsByTitle(): Record<string, StatusRow> {
  const rows: Record<string, StatusRow> = {};
  for (const row of document.querySelectorAll<HTMLElement>(".list-row"))
    rows[row.querySelector("strong")?.textContent ?? ""] = {
      row,
      icon: row.querySelector<HTMLElement>(".row-status"),
    };
  return rows;
}
function expectIconIsDecoration(row: HTMLElement, icon: HTMLElement) {
  expect(row.className).toBe("list-row has-status");
  expect(row.firstElementChild).toBe(icon);
  expect(icon.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(row.textContent).toBe(
    (row.querySelector("strong")?.textContent ?? "") +
      (row.querySelector(".row-meta")?.textContent ?? ""),
  );
}
it("marks Todo rows with a read-only status icon that adds no text", async () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-10-12T00:00:00Z");
  vi.setSystemTime(now);
  const todo = (title: string, offset: number, type = "unsubmitted") => ({
    title,
    due_at: new Date(now + offset).toISOString(),
    type,
    course: "A",
    ignore: false,
  });
  ui = await mount(
    <ResultList
      result={{
        status: "success",
        todo: [
          todo("남은 과제", 3 * 86400000),
          todo("지난 과제", -60000),
          todo("제출 완료 과제", -86400000, "submitted"),
        ],
      }}
      onCourse={() => {}}
    />,
  );
  const byTitle = rowsByTitle();
  expect(
    Object.fromEntries(
      Object.entries(byTitle).map(([title, { icon }]) => [
        title,
        icon?.getAttribute("data-status"),
      ]),
    ),
  ).toEqual({
    "남은 과제": "open",
    "지난 과제": "overdue",
    "제출 완료 과제": "done",
  });
  for (const { row, icon } of Object.values(byTitle))
    expectIconIsDecoration(row, icon!);
  expect(byTitle["지난 과제"]!.row.textContent).toBe("지난 과제A마감 지남");
});
it("marks locked and submitted assignments and leaves notices without an icon", async () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-10-12T00:00:00Z");
  vi.setSystemTime(now);
  const assignment = (title: string, state: string, locked: boolean) => ({
    title,
    due_at: new Date(now + 3 * 86400000).toISOString(),
    remaining_candidate: true,
    unlock_at: "",
    lock_at: "",
    points_possible: null,
    published: true,
    locked_for_user: locked,
    submission_workflow_state: state,
    submitted_at: "",
    missing: false,
    late: false,
    submission_types: [],
  });
  ui = await mount(
    <ResultList
      result={{
        status: "success",
        deadlines: [
          assignment("잠긴 과제", "unsubmitted", true),
          assignment("채점된 과제", "graded", false),
        ],
      }}
      onCourse={() => {}}
    />,
  );
  const rows = rowsByTitle();
  expect(rows["잠긴 과제"]!.icon?.getAttribute("data-status")).toBe("locked");
  expect(rows["채점된 과제"]!.icon?.getAttribute("data-status")).toBe("done");
  for (const { row, icon } of Object.values(rows))
    expectIconIsDecoration(row, icon!);
  await ui.render(
    <ResultList
      result={{
        status: "success",
        upcoming: [
          {
            title: "휴강 안내",
            date: new Date(now - 86400000).toISOString(),
            type: "announcement",
            course: "A",
            submitted: false,
            new_activity: false,
          },
          {
            title: "지난 일정",
            date: new Date(now - 86400000).toISOString(),
            type: "assignment",
            course: "A",
            submitted: false,
            new_activity: false,
          },
        ],
      }}
      onCourse={() => {}}
    />,
  );
  const schedule = rowsByTitle();
  expect(schedule["휴강 안내"]!.icon).toBeNull();
  expect(schedule["휴강 안내"]!.row.className).toBe("list-row");
  expect(schedule["지난 일정"]!.icon?.getAttribute("data-status")).toBe("overdue");
});
it("separates schedule rows into tasks and notices with counts and type labels", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T03:00:00Z"));
  const row = (title: string, type: string, date = "2026-10-22T06:00:00Z") => ({
    title,
    date,
    type,
    course: "확률및랜덤과정",
    submitted: false,
    new_activity: false,
  });
  ui = await mount(
    <ResultList
      result={{
        status: "success",
        upcoming: [
          row("과제 3", "assignment"),
          row("휴강 안내", "announcement"),
          row("퀴즈 2", "quiz"),
          row("토론", "discussion_topic"),
          row("학과 행사", "calendar_event"),
        ],
      }}
      onCourse={() => {}}
    />,
  );
  const filters = () =>
    [...document.querySelectorAll(".kind-filter button")].map((b) => [
      b.textContent,
      b.getAttribute("aria-pressed"),
    ]);
  const titles = () =>
    [...document.querySelectorAll(".list-row strong")].map(
      (e) => e.textContent,
    );
  const subtitles = () =>
    [...document.querySelectorAll(".row-course")].map((e) => e.textContent);
  expect(filters()).toEqual([
    ["전체5", "true"],
    ["과제3", "false"],
    ["공지1", "false"],
    ["기타1", "false"],
  ]);
  expect(titles()).toEqual([
    "과제 3",
    "휴강 안내",
    "퀴즈 2",
    "토론",
    "학과 행사",
  ]);
  expect(subtitles()).toEqual([
    "확률및랜덤과정 · 과제",
    "확률및랜덤과정 · 공지",
    "확률및랜덤과정 · 퀴즈",
    "확률및랜덤과정 · 토론",
    "확률및랜덤과정 · 일정",
  ]);
  const press = async (label: string) => {
    const button = [
      ...document.querySelectorAll<HTMLElement>(".kind-filter button"),
    ].find((b) => b.textContent?.startsWith(label));
    await act(async () => button!.click());
  };
  await press("공지");
  expect(titles()).toEqual(["휴강 안내"]);
  expect(document.querySelector(".count")?.textContent).toContain(
    "5개 항목 중 1개 표시",
  );
  await press("과제");
  expect(titles()).toEqual(["과제 3", "퀴즈 2", "토론"]);
  await press("기타");
  expect(titles()).toEqual(["학과 행사"]);
  await press("전체");
  expect(titles()).toHaveLength(5);
  // Detail shows the Korean kind next to the raw Canvas type.
  await click("휴강 안내");
  expect(document.body.textContent).toContain("공지 (announcement)");
});
it("hides the other-kind filter when every schedule row is a task or notice", async () => {
  ui = await mount(
    <ResultList
      result={{
        status: "success",
        upcoming: [
          {
            title: "과제",
            date: "",
            type: "assignment",
            course: "",
            submitted: false,
            new_activity: false,
          },
        ],
      }}
      onCourse={() => {}}
    />,
  );
  expect(
    [...document.querySelectorAll(".kind-filter button")].map(
      (b) => b.textContent,
    ),
  ).toEqual(["전체1", "과제1", "공지0"]);
  expect(document.querySelector(".row-course")?.textContent).toBe("과제");
});
it("keeps the selected other-kind filter visible when a new result has none", async () => {
  const row = (title: string, type: string) => ({
    title,
    date: "",
    type,
    course: "",
    submitted: false,
    new_activity: false,
  });
  const list = (upcoming: ReturnType<typeof row>[]) => (
    <ResultList result={{ status: "success", upcoming }} onCourse={() => {}} />
  );
  ui = await mount(
    list([row("과제", "assignment"), row("행사", "calendar_event")]),
  );
  const other = () =>
    [...document.querySelectorAll<HTMLElement>(".kind-filter button")].find(
      (b) => b.textContent?.startsWith("기타"),
    );
  await act(async () => other()!.click());
  await ui.render(list([row("다른 과제", "assignment")]));
  expect(other()?.getAttribute("aria-pressed")).toBe("true");
  expect(other()?.textContent).toBe("기타0");
  expect(document.body.textContent).toContain("선택한 종류의 일정이 없습니다.");
});
