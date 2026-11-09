// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  AssignmentControls,
  type AssignmentFilters,
} from "../entrypoints/sidepanel/ui/AssignmentControls";
import { ResultList } from "../entrypoints/sidepanel/ResultList";
import { mount } from "./ui-helpers";

let ui: Awaited<ReturnType<typeof mount>>;
afterEach(async () => {
  await ui?.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const now = Date.parse("2026-09-13T14:00:00Z"); // Sunday 23:00 KST
const initial: AssignmentFilters = {
  remainingOnly: true,
  period: "all",
  sort: "due",
};
const items = [
  { title: "오늘 마감", due_at: "2026-09-13T14:30:00Z", remaining_candidate: true },
  { title: "다음 주 마감", due_at: "2026-09-15T14:00:00Z", remaining_candidate: true },
  { title: "다음 7일 이후", due_at: "2026-09-21T14:00:00Z", remaining_candidate: true },
  { title: "제출함", due_at: "2026-09-13T14:30:00Z", remaining_candidate: false },
  { title: "날짜 없음", due_at: "", remaining_candidate: false },
  { title: "기한 지남", due_at: "2026-09-12T14:00:00Z", remaining_candidate: false },
];
function button(name: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) =>
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent === name || candidate.firstChild?.textContent === name,
    );
  expect(element).toBeDefined();
  if (!element) throw new Error(`Missing button: ${name}`);
  return element;
}
async function press(name: string) {
  await act(async () => button(name).click());
}
async function choose(label: string, value: string) {
  const field = [...document.querySelectorAll("label")]
    .find((candidate) => candidate.textContent === label);
  const select = field?.control;
  expect(select).toBeInstanceOf(HTMLSelectElement);
  if (!(select instanceof HTMLSelectElement))
    throw new Error(`Missing select: ${label}`);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function heading() {
  return document.querySelector("h1")?.textContent;
}

it.each(["escape", "outside", "trigger"] as const)(
  "discards the draft when the view closes by %s",
  async (method) => {
    const onApply = vi.fn();
    ui = await mount(
      <AssignmentControls items={items} filters={initial} now={now} onApply={onApply} />,
    );
    await press("보기 변경");
    expect(document.activeElement).toBe(button("남은 과제"));
    await press("전체");
    await choose("마감 기간", "day");
    await choose("정렬", "due-desc");
    expect(onApply).not.toHaveBeenCalled();
    expect(heading()).toBe("남은 과제 3개");

    await act(async () => {
      switch (method) {
        case "escape":
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          break;
        case "outside":
          document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
          break;
        case "trigger":
          button("보기 변경").click();
          break;
      }
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
    if (method === "escape")
      expect(document.activeElement).toBe(button("보기 변경"));
    await press("보기 변경");
    expect(button("남은 과제").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector<HTMLSelectElement>("select")?.value).toBe("all");
    expect(document.querySelectorAll("select")[1]?.value).toBe("due");
    expect(button("3개 과제 보기").disabled).toBe(false);
  },
);

it("applies the previewed scope, period and order only on confirmation", async () => {
  const onApply = vi.fn();
  ui = await mount(
    <AssignmentControls items={items} filters={initial} now={now} onApply={onApply} />,
  );
  await press("보기 변경");
  await press("전체");
  await choose("마감 기간", "day");
  await choose("정렬", "due-desc");
  expect(document.querySelector('[role="status"]')?.textContent).toContain("2개 과제가 있어요");
  expect(heading()).toBe("남은 과제 3개");
  expect(onApply).not.toHaveBeenCalled();

  await press("2개 과제 보기");

  expect(onApply).toHaveBeenCalledExactlyOnceWith({
    remainingOnly: false, period: "day", sort: "due-desc",
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(button("보기 변경"));
});

it.each([
  ["all", 3],
  ["today", 1],
  ["week", 1],
  ["day", 1],
  ["next7", 2],
] as const)("previews %s from all rows without applying the draft", async (period, count) => {
  const onApply = vi.fn();
  ui = await mount(
    <AssignmentControls items={items} filters={initial} now={now} onApply={onApply} />,
  );
  await press("보기 변경");

  await choose("마감 기간", period);

  expect(button(`${count}개 과제 보기`).disabled).toBe(false);
  expect(document.querySelector('[role="status"]')?.textContent)
    .toContain(`${count}개 과제가 있어요`);
  expect(heading()).toBe("남은 과제 3개");
  expect(onApply).not.toHaveBeenCalled();
});

it("resets the draft without applying it until confirmation", async () => {
  const onApply = vi.fn();
  const filters: AssignmentFilters = {
    remainingOnly: false, period: "day", sort: "original",
  };
  ui = await mount(
    <AssignmentControls items={items} filters={filters} now={now} onApply={onApply} />,
  );
  expect(heading()).toBe("과제 2개");
  await press("보기 변경");

  await press("초기화");

  expect(button("남은 과제").getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector<HTMLSelectElement>("select")?.value).toBe("all");
  expect(document.querySelectorAll("select")[1]?.value).toBe("due");
  expect(onApply).not.toHaveBeenCalled();
  expect(heading()).toBe("과제 2개");
  await press("3개 과제 보기");
  expect(onApply).toHaveBeenCalledExactlyOnceWith(initial);
});

it("lets an empty preview be applied as an empty result", async () => {
  const onApply = vi.fn();
  ui = await mount(
    <AssignmentControls items={[]} filters={initial} now={now} onApply={onApply} />,
  );
  await press("보기 변경");
  await press("전체");
  expect(button("결과 확인하기").disabled).toBe(false);

  await press("결과 확인하기");

  expect(onApply).toHaveBeenCalledExactlyOnceWith({ ...initial, remainingOnly: false });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("switches the actual course assignment list to all rows and back", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const assignments = items.map((item) => ({
    ...item,
    unlock_at: "", lock_at: "", points_possible: null,
    published: true, locked_for_user: false,
    submission_workflow_state: item.title === "제출함" ? "submitted" : "unsubmitted",
    submitted_at: "", missing: false, late: false, submission_types: [],
  }));
  ui = await mount(
    <ResultList result={{ status: "success", assignments }} onCourse={() => {}} />,
  );
  const titles = () => [...document.querySelectorAll(".list-row strong")]
    .map((node) => node.textContent);
  expect(titles()).toEqual(["오늘 마감", "다음 주 마감", "다음 7일 이후"]);

  await press("전체 과제 6개 보기");

  expect(titles()).toEqual([
    "기한 지남", "오늘 마감", "제출함", "다음 주 마감", "다음 7일 이후", "날짜 없음",
  ]);
  await press("남은 과제만 보기");
  expect(titles()).toEqual(["오늘 마감", "다음 주 마감", "다음 7일 이후"]);
});
