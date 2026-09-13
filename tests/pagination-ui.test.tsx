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
  }));
  ui = await mount(
    <ResultList result={{ status: "success", courses }} onCourse={onCourse} />,
  );
  await click("다음");
  await click("과제 보기");
  expect(onCourse).toHaveBeenCalledExactlyOnceWith("과목 100");
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
