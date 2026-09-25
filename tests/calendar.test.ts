// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { listQuery } from "../src/api/client";
import { isRequest, parseResult } from "../src/protocol";
import { readUrl } from "../src/security/policy";
import {
  announcementEvents,
  assignmentEvents,
  flagRelated,
} from "../src/calendar/events";

const origin = "https://mylms.korea.ac.kr";
const query = {
  version: 1,
  type: "CALENDAR_LIST",
  start_date: "2026-08-01",
  end_date: "2026-09-30",
  month: "2026-10",
} as const;
const json = (body: unknown, link?: string) =>
  new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      ...(link ? { Link: link } : {}),
    },
  });
const course = new Map([["101", "History"]]);
const announcement = (message: string, id = 17) => ({
  id,
  title: "Exam",
  message,
  posted_at: "2026-09-10T10:00:00Z",
  context_code: "course_101",
});

it("requires a separate valid collection range and displayed month", () => {
  expect(isRequest(query)).toBe(true);
  expect(isRequest({ ...query, month: "2026-13" })).toBe(false);
  expect(isRequest({ ...query, start_date: "2026-10-01" })).toBe(false);
  expect(isRequest({ ...query, course_id: 101 })).toBe(false);
  expect(() =>
    readUrl(
      "/api/v1/announcements?context_codes%5B%5D=course_101&start_date=2026-08-01&end_date=2026-09-30",
      origin,
      "/api/v1/announcements",
    ),
  ).not.toThrow();
  expect(() =>
    readUrl(
      "/api/v1/announcements?context_codes%5B%5D=course_101&access_token=secret",
      origin,
      "/api/v1/announcements",
    ),
  ).toThrow("POLICY");
  expect(
    readUrl("/api/v1/users/self", origin, "/api/v1/users/self").pathname,
  ).toBe("/api/v1/users/self");
  expect(() =>
    readUrl("/api/v1/users/self?per_page=100", origin, "/api/v1/users/self"),
  ).toThrow("POLICY");
});
it("collects posting period announcements and displayed-month planner independently", async () => {
  const fetched: URL[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    fetched.push(url);
    if (url.pathname === "/api/v1/courses")
      return json([{ id: 101, name: "History" }]);
    if (url.pathname === "/api/v1/planner/items")
      return json([
        {
          plannable: { title: "Lab" },
          context_name: "History",
          plannable_date: "2026-10-20T09:00:00Z",
        },
      ]);
    if (url.pathname === "/api/v1/courses/101/assignments") return json([]);
    if (url.pathname === "/api/v1/announcements")
      return json([
        announcement(
          "<p>2026년 10월 21일 오전 9시 exam</p><p>2026-10-25 review</p>",
        ),
        {
          ...announcement("2026-10-29 excluded", 19),
          posted_at: "2026-11-01T00:00:00Z",
        },
      ]);
    throw new Error("unexpected endpoint");
  });
  const result = await listQuery(origin, query, fetcher);
  expect(result.status).toBe("success");
  if (result.status !== "success" || !("calendar" in result))
    throw new Error("missing calendar");
  expect(
    result.calendar.map(({ date, time, kind }) => [date, time, kind]),
  ).toEqual([
    ["2026-10-20", "18:00", "planner"],
    ["2026-10-21", "09:00", "announcement"],
    ["2026-10-25", undefined, "announcement"],
  ]);
  expect(result.calendar[2]?.status).toContain("date-only");
  expect(fetched[1]?.searchParams.get("start_date")).toBe("2026-10-01");
  expect(fetched[3]?.searchParams.get("start_date")).toBe("2026-08-01");
  expect(fetched[3]?.searchParams.get("context_codes[]")).toBe("course_101");
  expect(parseResult(result, query, origin)).toEqual(result);
});
it("includes course assignments separately and converts their instant to Seoul time", () => {
  const events = assignmentEvents(
    [
      {
        id: 77,
        name: "Report",
        due_at: "2026-10-20T18:00:00Z",
        html_url: `${origin}/courses/101/assignments/77`,
      },
      { id: 78, name: "Undated", due_at: null },
    ],
    "History",
    "101",
    origin,
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "assignment",
    date: "2026-10-21",
    time: "03:00",
    action: "제출",
    sourceUrl: `${origin}/courses/101/assignments/77`,
  });
});
it("retains uncertainty, cancellation, change, conflicts and duplicates without interpreting posted_at as a deadline", () => {
  const events = flagRelated(
    announcementEvents(
      [
        announcement(
          "<script>2026-01-01 stolen</script><p>2026-10-21 changed</p><p>2026-10-21 duplicate</p><p>2026-10-22 cancelled</p><p>10월 30일 TBD</p>",
          17,
        ),
        announcement("2026-10-21 revised", 18),
      ],
      course,
      origin,
    ),
  );
  expect(events).toHaveLength(5);
  expect(events[0]?.status).toContain("changed");
  expect(events[2]?.status).toContain("cancelled");
  expect(events[3]).not.toHaveProperty("date");
  expect(events[3]?.status).toContain("ambiguous");
  expect(
    events.every(
      (event) =>
        !event.evidence.includes("stolen") && !event.id.includes("course_101"),
    ),
  ).toBe(true);
});
it("fails the whole result on an unsafe announcement next page", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/courses") return json([{ id: 101, name: "History" }]);
    if (path === "/api/v1/planner/items") return json([]);
    if (path === "/api/v1/courses/101/assignments") return json([]);
    return json(
      [announcement("2026-10-21 exam")],
      `<https://evil.example/api/v1/announcements?page=2>; rel="next"`,
    );
  });
  expect(await listQuery(origin, query, fetcher)).toEqual({
    status: "error",
    code: "POLICY",
  });
});
it("flags repeated source records without duplicate panel keys", () => {
  const source = announcement("2026-10-21 exam");
  const events = flagRelated(
    announcementEvents([source, source], course, origin),
  );
  expect(events.map((event) => event.status)).toEqual([
    ["confirmed", "date-only", "duplicate"],
    ["confirmed", "date-only", "duplicate"],
  ]);
  expect(events[0]?.id).not.toBe(events[1]?.id);
});
it("marks contradictory deadlines for the same course and target without merging either source", () => {
  const events = flagRelated(
    announcementEvents(
      [
        announcement("2026-10-21 14시 보고서 제출", 17),
        announcement("2026-10-22 14시 보고서 제출", 18),
      ],
      course,
      origin,
    ),
  );
  expect(events).toHaveLength(2);
  expect(events.map(({ status }) => status.includes("conflict"))).toEqual([
    true,
    true,
  ]);
  expect(events.map(({ date }) => date)).toEqual(["2026-10-21", "2026-10-22"]);
});
it("flags a conflicting structured assignment without silently overriding either deadline", () => {
  const official = assignmentEvents(
    [{ id: 77, name: "보고서", due_at: "2026-10-20T14:00:00+09:00" }],
    "History",
    "101",
    origin,
  );
  const notice = announcementEvents(
    [announcement("2026년 10월 21일 14시 보고서는 제출", 18)],
    course,
    origin,
  );
  const result = flagRelated([...official, ...notice]);
  expect(result.map(({ status }) => status.includes("conflict"))).toEqual([
    true,
    true,
  ]);
  expect(result.map(({ date }) => date)).toEqual(["2026-10-20", "2026-10-21"]);
});
it("extracts two separate actions from one dated announcement without inventing a time", () => {
  const events = announcementEvents(
    [
      announcement(
        "2026년 10월 7일 14시 중간고사, 보고서는 2026년 10월 9일 23:59까지 제출",
      ),
    ],
    course,
    origin,
  );
  expect(events.map(({ date, time, action }) => [date, time, action])).toEqual([
    ["2026-10-07", "14:00", "시험"],
    ["2026-10-09", "23:59", "제출"],
  ]);
  expect(events[0]?.evidence).toContain("중간고사");
  expect(events[1]?.evidence).toContain("보고서");
});
it("treats a date change as one review candidate and retains the old evidence", () => {
  const events = announcementEvents(
    [
      announcement(
        "중간고사를 2026년 10월 7일에서 2026년 10월 8일로 변경합니다",
      ),
    ],
    course,
    origin,
  );
  expect(events).toHaveLength(1);
  expect(events[0]?.date).toBe("2026-10-08");
  expect(events[0]?.status).toContain("changed");
  expect(events[0]?.status).toContain("ambiguous");
  expect(events[0]?.evidence).toContain("10월 7일");
});
it("keeps relative and yearless dates under confirmation, and undated notices undated", () => {
  const events = announcementEvents(
    [
      announcement("다음 주 금요일 시험", 18),
      announcement("10월 9일 과제 제출", 19),
      announcement("다음 수업까지 영상을 시청하세요", 20),
      announcement("자료를 첨부합니다", 21),
    ],
    course,
    origin,
  );
  expect(events).toHaveLength(3);
  expect(events[0]).toMatchObject({
    date: "2026-09-18",
    status: ["ambiguous", "date-only"],
  });
  expect(events[1]?.date).toBeUndefined();
  expect(events[1]?.status).toContain("ambiguous");
  expect(events[2]?.date).toBeUndefined();
  expect(events[2]?.action).toBe("수업");
  expect(events.every(({ time }) => time === undefined)).toBe(true);
});
it("does not confirm impossible dates and crosses a year boundary for relative review", () => {
  const events = announcementEvents(
    [
      announcement("2026년 2월 30일 시험", 30),
      {
        ...announcement("다음 주 금요일 시험", 31),
        posted_at: "2026-12-30T15:00:00Z",
      },
    ],
    course,
    origin,
  );
  expect(events[0]?.date).toBeUndefined();
  expect(events[0]?.status).toContain("ambiguous");
  expect(events[1]?.date).toBe("2027-01-08");
  expect(events[1]?.status).toContain("ambiguous");
});
it("rejects raw HTML, malformed status and unsafe links at panel boundary", () => {
  const event = announcementEvents(
    [announcement("2026-10-21 exam")],
    course,
    origin,
  )[0]!;
  expect(
    parseResult(
      { status: "success", calendar: [{ ...event, evidence: "<img>" }] },
      query,
      origin,
    ),
  ).toEqual({ status: "error", code: "INVALID_RESPONSE" });
  expect(
    parseResult(
      {
        status: "success",
        calendar: [{ ...event, sourceUrl: "https://evil.example/" }],
      },
      query,
      origin,
    ),
  ).toEqual({ status: "error", code: "INVALID_RESPONSE" });
  expect(
    parseResult(
      {
        status: "success",
        calendar: [
          {
            ...event,
            sourceUrl: `${origin}/courses/101/discussion_topics/17?token=secret`,
          },
        ],
      },
      query,
      origin,
    ),
  ).toEqual({ status: "error", code: "INVALID_RESPONSE" });
});
it("links back to the approved announcement page without a query token", () => {
  const source = announcement("2026-10-21 시험");
  const events = announcementEvents(
    [
      { ...source, html_url: `${origin}/courses/101/discussion_topics/17` },
      {
        ...source,
        id: 18,
        html_url: `${origin}/courses/101/discussion_topics/18?token=secret`,
      },
    ],
    course,
    origin,
  );
  expect(events[0]?.sourceUrl).toBe(
    `${origin}/courses/101/discussion_topics/17`,
  );
  expect(events[1]?.sourceUrl).toBe(
    `${origin}/courses/101/discussion_topics/18`,
  );
});
