import { expect, it } from "vitest";
import { filterDeadlines } from "../src/deadline-view";
import type { Deadline } from "../src/domain-items";

function item(title: string, time: number): Deadline {
  return { title, due_at: new Date(time).toISOString(), remaining_candidate: true };
}
it("uses the Korean calendar day for today's assignments", () => {
  const start = Date.parse("2026-11-07T15:00:00Z");
  const now = Date.parse("2026-11-08T14:59:00Z");
  const end = Date.parse("2026-11-08T15:00:00Z");
  const rows = [
    item("이전 날짜", start - 1),
    item("오늘 시작", start),
    item("오늘 마지막", end - 1),
    item("다음 날짜", end),
  ];
  expect(filterDeadlines(rows, {
    remainingOnly: false, period: "today", sort: false,
  }, now).map((row) => row.title)).toEqual(["오늘 시작", "오늘 마지막"]);
});
it("includes the seven-day boundary and excludes past or later assignments", () => {
  const now = Date.parse("2026-11-08T00:00:00Z");
  const end = now + 7 * 86400000;
  const rows = [
    item("이미 마감", now),
    item("곧 마감", now + 1),
    item("7일 경계", end),
    item("7일 이후", end + 1),
  ];
  expect(filterDeadlines(rows, {
    remainingOnly: false, period: "next7", sort: false,
  }, now).map((row) => row.title)).toEqual(["곧 마감", "7일 경계"]);
  expect(rows.map((row) => row.title)).toEqual(["이미 마감", "곧 마감", "7일 경계", "7일 이후"]);
});
