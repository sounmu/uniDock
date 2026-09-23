import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultList, dateLabel } from "../entrypoints/sidepanel/ResultList";
import fixture from "./fixtures/python-contract.json";
import type { Result } from "../src/protocol";
afterEach(() => vi.useRealTimers());
it.each(["assignments", "deadlines", "upcoming"] as const)(
  "renders the %s Python contract without raw identifiers",
  (key) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:00:00Z"));
    const result = {
      status: "success",
      [key]: fixture.expected[key],
    } as Extract<Result, { status: "success" }>;
    const html = renderToStaticMarkup(
      <ResultList result={result} onCourse={() => {}} />,
    );
    expect(html).toContain(fixture.expected[key][0]!.title);
    expect(html).not.toMatch(/11111111|html_url|course_id|online_upload/);
  },
);
it("renders unfinished all-course Todo assignments including undated rows", () => {
  const html = renderToStaticMarkup(
    <ResultList
      result={{
        status: "success",
        todo: [
          {
            title: "마감 없는 과제",
            due_at: "",
            course: "국제법",
            type: "unsubmitted",
            ignore: false,
          },
        ],
      }}
      onCourse={() => {}}
    />,
  );
  expect(html).toContain("마감 없는 과제");
  expect(html).toContain("미제출 과제");
});
it("hides completed/non-candidate deadline rows by default", () => {
  const html = renderToStaticMarkup(
    <ResultList
      result={{ status: "success", deadlines: fixture.edge.expected.deadlines }}
      onCourse={() => {}}
    />,
  );
  expect(html).not.toContain("채점됨");
  expect(html).not.toContain("남은 과제 후보 아님");
});
it("shows empty result and never renders API markup as HTML", () => {
  expect(
    renderToStaticMarkup(
      <ResultList
        result={{ status: "success", todo: [] }}
        onCourse={() => {}}
      />,
    ),
  ).toContain("조회된 항목이 없습니다");
  const result = {
    status: "success",
    todo: [
      {
        title: "<script>bad()</script>",
        due_at: "",
        course: "",
        type: "",
        ignore: false,
      },
    ],
  } as const;
  const html = renderToStaticMarkup(
    <ResultList
      result={{ ...result, todo: [...result.todo] }}
      onCourse={() => {}}
    />,
  );
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});
it("formats dates consistently in Korea time", () => {
  expect(dateLabel("")).toBe("일정 없음");
  expect(dateLabel("invalid")).toBe("날짜 확인 필요");
  expect(dateLabel("2026-09-11T00:00:00Z")).toContain("9:00");
});
it("renders recording actions without URLs or internal IDs in the DOM", () => {
  const html = renderToStaticMarkup(
    <ResultList
      result={{
        status: "success",
        recordings: [
          {
            module: "1주차",
            title: "1차시",
            type: "ExternalTool",
            lmsHandle: crypto.randomUUID(),
            launchHandle: crypto.randomUUID(),
          },
        ],
      }}
      onCourse={() => {}}
      onRecording={() => {}}
    />,
  );
  expect(html).toContain("LMS에서 보기");
  expect(html).toContain("LTI 탭 열기");
  expect(html).not.toMatch(/href=|https:|\/courses\//);
});
