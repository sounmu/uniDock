// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ResultList } from "../entrypoints/sidepanel/ResultList";
import type { Result } from "../src/protocol";
import { mount, click } from "./ui-helpers";
let ui: Awaited<ReturnType<typeof mount>>;
afterEach(async () => {
  await ui?.unmount();
  vi.unstubAllGlobals();
});
const deadlines = Array.from({ length: 205 }, (_, i) => ({
  title: `과제 ${i}`,
  due_at: "2026-09-12T00:00:00Z",
  remaining_candidate: false,
}));
it("bounds rendered rows and preserves all deadline rows and API order across pages", async () => {
  ui = await mount(
    <ResultList
      result={{ status: "success", deadlines }}
      onCourse={() => {}}
    />,
  );
  await click("보기 설정");
  await act(async () => {
    (
      document.querySelector('input[type="checkbox"]') as HTMLInputElement
    ).click();
  });
  const titles = () =>
    [...document.querySelectorAll("li strong")].map((node) => node.textContent);
  expect(titles()).toEqual(deadlines.slice(0, 100).map((row) => row.title));
  expect(document.body.textContent).toContain("1–100 / 205개");
  await click("이전");
  expect(titles()).toHaveLength(100);
  await click("다음");
  expect(titles()).toEqual(deadlines.slice(100, 200).map((row) => row.title));
  await click("다음");
  expect(titles()).toEqual(deadlines.slice(200).map((row) => row.title));
  await click("다음");
  expect(titles()).toHaveLength(5);
  await click("이전");
  expect(titles()[0]).toBe("과제 100");
  await ui.render(
    <ResultList
      result={{ status: "success", deadlines: [deadlines[0]!] }}
      onCourse={() => {}}
    />,
  );
  expect(titles()).toEqual(["과제 0"]);
  expect(document.querySelector("nav")).toBeNull();
});
it("keeps course selection callbacks correct beyond the first page", async () => {
  const onCourse = vi.fn();
  const courses = Array.from({ length: 101 }, (_, i) => ({
    name: `과목 ${i}`,
    courseSelector: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  }));
  ui = await mount(
    <ResultList result={{ status: "success", courses }} onCourse={onCourse} />,
  );
  await click("다음");
  await click("과목 100");
  expect(onCourse).toHaveBeenCalledExactlyOnceWith(courses[100]);
});
it("keeps the recording page while an open completes and resets on refresh", async () => {
  const onRecording = vi.fn();
  const recordings = Array.from({ length: 101 }, (_, i) => ({
    title: `강의 ${i}`,
    module: "주차",
    type: "ExternalTool" as const,
    lmsHandle: crypto.randomUUID(),
    launchHandle: crypto.randomUUID(),
  }));
  const render = (rows = recordings, used = new Set<string>()) => (
    <ResultList
      result={{ status: "success", recordings: rows }}
      onCourse={() => {}}
      onRecording={onRecording}
      usedRecordingHandles={used}
    />
  );
  ui = await mount(render());
  await click("다음");
  await click("강의 100");
  await click("LTI 탭 열기 ↗");
  expect(onRecording).toHaveBeenCalledExactlyOnceWith(
    recordings[100]!.launchHandle,
  );
  await ui.render(render(recordings, new Set([recordings[100]!.launchHandle])));
  expect(document.body.textContent).toContain("101–101 / 101개");
  expect(
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "LTI 탭 열기 ↗",
    )!.disabled,
  ).toBe(true);
  await click("← 목록");
  await ui.render(render([...recordings]));
  expect(document.body.textContent).toContain("1–100 / 101개");
});
it.each(["assignments", "deadlines", "upcoming", "todo"] as const)(
  "renders at most 100 of 10000 %s rows",
  async (key) => {
    const row = {
      ...deadlines[0]!,
      title: "항목",
      date: "",
      type: "",
      course: "",
      submitted: false,
      new_activity: false,
      ignore: false,
      submission_workflow_state: "",
      published: true,
      locked_for_user: false,
      missing: false,
      late: false,
      unlock_at: "",
      lock_at: "",
      submitted_at: "",
      points_possible: null,
      submission_types: [],
    };
    const values = Array.from({ length: 10000 }, () => row);
    const result: Extract<Result, { status: "success" }> =
      key === "assignments"
        ? { status: "success", assignments: values }
        : key === "deadlines"
          ? { status: "success", deadlines: values }
          : key === "upcoming"
            ? { status: "success", upcoming: values }
            : { status: "success", todo: values };
    ui = await mount(<ResultList result={result} onCourse={() => {}} />);
    if (key === "assignments" || key === "deadlines") {
      await click("보기 설정");
      await act(async () => {
        (
          document.querySelector('input[type="checkbox"]') as HTMLInputElement
        ).click();
      });
    }
    expect(document.querySelectorAll("li")).toHaveLength(100);
    expect(document.body.textContent).toContain("1–100 / 10000개");
  },
);
it("opens LTI straight from a recording row and only for launchable rows", async () => {
  const onRecording = vi.fn();
  const recordings = [
    {
      title: "강의 A",
      module: "주차",
      type: "ExternalTool" as const,
      lmsHandle: crypto.randomUUID(),
      launchHandle: crypto.randomUUID(),
    },
    {
      title: "강의 B",
      module: "주차",
      type: "ExternalTool" as const,
      lmsHandle: crypto.randomUUID(),
      launchHandle: "",
    },
  ];
  const render = (used = new Set<string>(), opened = new Set<string>()) => (
    <ResultList
      result={{ status: "success", recordings }}
      onCourse={() => {}}
      onRecording={onRecording}
      usedRecordingHandles={used}
      openedRecordingHandles={opened}
    />
  );
  ui = await mount(render());
  const actions = () => [
    ...document.querySelectorAll<HTMLButtonElement>(".row-action"),
  ];
  expect(actions().map((b) => b.getAttribute("aria-label"))).toEqual([
    "강의 A LTI 열기 (새 탭)",
  ]);
  expect(document.body.textContent).toContain("LMS에서 확인");
  await act(async () => actions()[0]!.click());
  expect(onRecording).toHaveBeenCalledExactlyOnceWith(
    recordings[0]!.launchHandle,
  );
  expect(document.querySelector(".detail-view")).toBeNull();
  const consumed = new Set([recordings[0]!.launchHandle]);
  // Consumed by an expired, timed-out or failed open: not a success.
  await ui.render(render(consumed));
  expect(actions()[0]!.disabled).toBe(true);
  expect(actions()[0]!.textContent).toBe("새로고침 필요");
  expect(actions()[0]!.getAttribute("aria-label")).toBe(
    "강의 A LTI 열 수 없음, 목록을 새로고침하세요",
  );
  await ui.render(render(consumed, consumed));
  expect(actions()[0]!.disabled).toBe(true);
  expect(actions()[0]!.textContent).toBe("열었음");
  expect(actions()[0]!.classList.contains("opened")).toBe(true);
});
