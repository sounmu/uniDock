// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Recording } from "../src/recordings";
import { ResultList } from "../entrypoints/sidepanel/ResultList";
import { mount, click } from "./ui-helpers";
const query = vi.hoisted(() => vi.fn());
vi.mock("../src/transport", () => ({ queryActive: query }));
import { App } from "../entrypoints/sidepanel/App";

let ui: Awaited<ReturnType<typeof mount>>;
beforeEach(() => {
  vi.stubGlobal("chrome", {
    runtime: { id: "test" },
    downloads: {
      onCreated: { addListener: vi.fn(), removeListener: vi.fn() },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      search: vi.fn(),
    },
    storage: {
      local: { get: vi.fn().mockResolvedValue({}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
});
afterEach(async () => {
  await ui?.unmount();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
const recording = (
  title: string,
  module: string,
  source: Recording["source"] = "module",
): Recording => ({
  module,
  title,
  type: "ExternalTool",
  source,
  lmsHandle: crypto.randomUUID(),
  launchHandle: crypto.randomUUID(),
});
const recordings = [
  recording("1차시", "1주차"),
  recording("2차시", "2주차"),
  recording("3차시", "2주차"),
  recording("보강 영상", "게시판 · 공지", "board"),
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
function moduleSelect() {
  const field = [...document.querySelectorAll("label")]
    .find((candidate) => candidate.textContent === "모듈");
  const select = field?.control;
  if (!(select instanceof HTMLSelectElement)) throw new Error("Missing module select");
  return select;
}
async function chooseModule(value: string) {
  await act(async () => {
    const select = moduleSelect();
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const titles = () =>
  [...document.querySelectorAll(".list-row strong")].map((node) => node.textContent);
const heading = () => document.querySelector("h1")?.textContent;
const summary = () => document.querySelector(".assignment-view-summary")?.textContent;

it("previews the recording source and module, applying them only on confirmation", async () => {
  ui = await mount(
    <ResultList result={{ status: "success", recordings }} onCourse={() => {}} />,
  );
  expect(heading()).toBe("녹화 강의 4개");
  await press("보기 변경");
  expect(document.activeElement).toBe(button("전체"));
  expect([...moduleSelect().options].map((option) => option.textContent))
    .toEqual(["전체 모듈", "1주차", "2주차", "게시판 · 공지"]);

  await press("게시판");

  expect(document.querySelector('[role="status"]')?.textContent).toBe("1개 강의가 있어요");
  expect([...moduleSelect().options].map((option) => option.textContent))
    .toEqual(["전체 모듈", "게시판 · 공지"]);
  expect(heading()).toBe("녹화 강의 4개");
  expect(titles()).toHaveLength(4);

  await press("1개 강의 보기");

  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(button("보기 변경"));
  expect(heading()).toBe("녹화 강의 1개");
  expect(titles()).toEqual(["보강 영상"]);
  expect(summary()).toBe("게시판");
});

it("keeps a module view until a refreshed list no longer has that module", async () => {
  const render = (rows: Recording[]) => (
    <ResultList result={{ status: "success", recordings: rows }} onCourse={() => {}} />
  );
  ui = await mount(render(recordings));
  await press("보기 변경");
  await chooseModule("1");
  await press("2개 강의 보기");
  expect(titles()).toEqual(["2차시", "3차시"]);
  expect(summary()).toBe("2주차");

  await ui.render(render([recording("4차시", "2주차"), recording("1차시", "1주차")]));
  expect(titles()).toEqual(["4차시"]);
  expect(heading()).toBe("녹화 강의 1개");

  await ui.render(render([recording("1차시", "1주차")]));
  expect(titles()).toEqual(["1차시"]);
  expect(heading()).toBe("녹화 강의 1개");
  expect(summary()).toBeUndefined();
});

it("downloads only the materials of the applied module", async () => {
  const target = { id: 7, url: "https://mylms.korea.ac.kr/" };
  const documents = [
    ["a.pdf", "Week 1"],
    ["b.pdf", "Week 1"],
    ["c.pdf", "Week 2"],
  ].map(([title, module]) => ({
    module,
    title,
    filename: title,
    type: "File" as const,
    lmsHandle: crypto.randomUUID(),
    downloadHandle: crypto.randomUUID(),
  }));
  query
    .mockImplementationOnce(async (_request, options) => {
      options.onTarget(target);
      return {
        status: "success",
        courses: [{ name: "Course", courseSelector: "00000000-0000-4000-8000-000000000001" }],
      };
    })
    .mockResolvedValueOnce({ status: "success", assignments: [] })
    .mockImplementationOnce(async (_request, options) => {
      options.onTarget(target);
      return { status: "success", documents };
    })
    .mockResolvedValue({ status: "success", downloaded: true });
  ui = await mount(<App />);
  await click("내 과목");
  await click("Course");
  await click("강의 자료");
  expect(heading()).toBe("강의 자료 3개");
  await press("보기 변경");
  await chooseModule("1");
  await press("1개 자료 보기");
  expect(heading()).toBe("강의 자료 1개");
  expect(summary()).toBe("Week 2");
  expect(titles()).toEqual(["c.pdf"]);

  await click("자료 전체 다운로드");

  expect(
    query.mock.calls
      .filter(([request]) => request.type === "DOCUMENT_DOWNLOAD")
      .map(([request]) => request.handle),
  ).toEqual([documents[2]?.downloadHandle]);
});
