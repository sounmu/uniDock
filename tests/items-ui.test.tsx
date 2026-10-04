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
  expect(html).toContain("미제출");
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
  expect(html).toContain("1차시");
  expect(html).toContain("LTI 열기 가능");
  expect(html).not.toMatch(/href=|https:|\/courses\//);
});
it("labels schedule chips as past, today, upcoming, or submitted in Korea time", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T03:00:00Z")); // 12:00 KST
  const row = (title: string, date: string, submitted = false) => ({
    title,
    date,
    type: "assignment",
    course: "국제법",
    submitted,
    new_activity: false,
  });
  const html = renderToStaticMarkup(
    <ResultList
      result={{
        status: "success",
        upcoming: [
          row("지난 일정", "2026-09-22T12:53:00Z"),
          row("오늘 일정", "2026-10-04T12:53:00Z"),
          row("다음 일정", "2026-10-08T12:53:00Z"),
          row("제출한 일정", "2026-09-22T12:53:00Z", true),
          row("날짜 없음", ""),
        ],
      }}
      onCourse={() => {}}
    />,
  );
  const chips = [...html.matchAll(/status-chip[^>]*>([^<]*)</g)].map(
    (m) => m[1],
  );
  expect(chips).toEqual([
    "예정 10. 8. 21:53",
    "오늘 21:53",
    "지남 9. 22. 21:53",
    "제출됨 9. 22. 21:53",
    "예정",
  ]);
});
