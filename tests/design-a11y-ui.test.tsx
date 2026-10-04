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
const now = Date.parse("2026-09-12T00:00:00Z");
function assignment(title: string, dueIn: number, state = "unsubmitted") {
  return {
    title,
    due_at: new Date(now + dueIn).toISOString(),
    remaining_candidate: state === "unsubmitted",
    unlock_at: "",
    lock_at: "",
    points_possible: null,
    published: true,
    locked_for_user: false,
    submission_workflow_state: state,
    submitted_at: "",
    missing: false,
    late: false,
    submission_types: [],
  };
}
function chips() {
  return [...document.querySelectorAll(".status-chip")].map((chip) => [
    chip.textContent,
    chip.className,
  ]);
}
it("states urgency in words and marks submitted rows with the done tone", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  ui = await mount(
    <ResultList
      result={{
        status: "success",
        assignments: [
          assignment("곧 마감", 3 * 3600000 - 1000),
          assignment("제출함", 3600000, "submitted"),
          assignment("여유", 3 * 86400000),
        ],
      }}
      onCourse={() => {}}
    />,
  );
  await click("보기 설정");
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  // Due-date order: the submitted row is due first.
  expect(chips()).toEqual([
    ["제출됨", "status-chip done"],
    ["3시간 남음", "status-chip urgent"],
    ["남은 과제", "status-chip"],
  ]);
});
it("keeps focus on a pagination button that reaches the last page", async () => {
  const deadlines = Array.from({ length: 105 }, (_, i) => ({
    title: `과제 ${i}`,
    due_at: "",
    remaining_candidate: false,
  }));
  ui = await mount(
    <ResultList
      result={{ status: "success", deadlines }}
      onCourse={() => {}}
    />,
  );
  await click("보기 설정");
  await act(async () =>
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  const next = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "다음",
  )!;
  next.focus();
  await click("다음");
  expect(document.activeElement).toBe(next);
  expect(next.getAttribute("aria-disabled")).toBe("true");
  expect(next.disabled).toBe(false);
  await click("다음");
  expect(document.body.textContent).toContain("101–105 / 105개");
});
it("falls back to the screen heading when the opened row disappears", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  ui = await mount(
    <main>
      <h1>과제</h1>
      <ResultList
        result={{
          status: "success",
          deadlines: [
            {
              title: "곧 지남",
              due_at: new Date(now + 2000).toISOString(),
              remaining_candidate: true,
            },
            {
              title: "나중",
              due_at: new Date(now + 86400000 * 3).toISOString(),
              remaining_candidate: true,
            },
          ],
        }}
        onCourse={() => {}}
      />
    </main>,
  );
  const row = [
    ...document.querySelectorAll<HTMLButtonElement>(".list-row"),
  ].find((button) => button.textContent?.includes("곧 지남"))!;
  row.focus();
  await act(async () => row.click());
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
  await click("← 목록");
  expect(row.isConnected).toBe(false);
  expect(document.activeElement?.tagName).toBe("H1");
});
it("restores focus to the same item after rows above it expire", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  ui = await mount(
    <ResultList
      result={{
        status: "success",
        deadlines: [
          {
            title: "곧 지남",
            due_at: new Date(now + 2000).toISOString(),
            remaining_candidate: true,
          },
          {
            title: "나중",
            due_at: new Date(now + 86400000 * 3).toISOString(),
            remaining_candidate: true,
          },
        ],
      }}
      onCourse={() => {}}
    />,
  );
  const row = [
    ...document.querySelectorAll<HTMLButtonElement>(".list-row"),
  ].find((button) => button.textContent?.includes("나중"))!;
  row.focus();
  await act(async () => row.click());
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
  await click("← 목록");
  expect(document.activeElement).toBe(row);
  expect(row.textContent).toContain("나중");
});
it("announces new-tab actions without reading the arrow glyph", async () => {
  ui = await mount(
    <ResultList
      result={{
        status: "success",
        recordings: [
          {
            title: "강의",
            module: "1주차",
            type: "ExternalTool" as const,
            lmsHandle: "a",
            launchHandle: "b",
          },
        ],
      }}
      onCourse={() => {}}
      onRecording={() => {}}
    />,
  );
  await click("강의");
  const launch = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "LTI 탭 열기 ↗",
  )!;
  expect(launch.getAttribute("aria-label")).toBe("LTI 탭 열기 (새 탭)");
  expect(launch.querySelector('[aria-hidden="true"]')?.textContent).toBe("↗");
});
