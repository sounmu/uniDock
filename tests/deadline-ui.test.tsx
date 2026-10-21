// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ResultList } from "../entrypoints/sidepanel/ResultList";
import { mount, click } from "./ui-helpers";
let ui: Awaited<ReturnType<typeof mount>>;
afterEach(async () => {
  await ui?.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
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
  await click("보기 설정");
  expect(
    (document.querySelector('input[type="checkbox"]') as HTMLInputElement)
      .checked,
  ).toBe(true);
  await click("다음");
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  expect(document.body.textContent).toContain("101–105 / 105개");
  await act(async () => {
    (
      document.querySelector('input[type="checkbox"]') as HTMLInputElement
    ).click();
  });
  expect(document.body.textContent).toContain("1–100 / 105개");
  await act(async () => {
    (
      document.querySelector('input[type="checkbox"]') as HTMLInputElement
    ).click();
  });
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
  await click("보기 설정");
  await act(async () => {
    (
      document.querySelector('input[type="checkbox"]') as HTMLInputElement
    ).click();
  });
  expect(document.querySelectorAll("li")).toHaveLength(100);
  const select = document.querySelectorAll("select")[1]!;
  await act(async () => {
    select.value = "due";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.querySelector("li strong")?.textContent).toBe("과제 104");
  await act(async () => {
    select.value = "original";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
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
    ["전체4", "true"],
    ["과제2", "false"],
    ["공지1", "false"],
    ["기타1", "false"],
  ]);
  expect(titles()).toEqual(["과제 3", "휴강 안내", "퀴즈 2", "토론"]);
  expect(subtitles()).toEqual([
    "확률및랜덤과정 · 과제",
    "확률및랜덤과정 · 공지",
    "확률및랜덤과정 · 퀴즈",
    "확률및랜덤과정 · 토론",
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
    "4개 항목 중 1개 표시",
  );
  await press("과제");
  expect(titles()).toEqual(["과제 3", "퀴즈 2"]);
  await press("기타");
  expect(titles()).toEqual(["토론"]);
  await press("전체");
  expect(titles()).toHaveLength(4);
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
