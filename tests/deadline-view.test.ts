import { expect, it } from "vitest";
import { filterDeadlines, remainingLabel } from "../src/deadline-view";
const now = Date.parse("2026-09-13T14:00:00Z"); // Sunday 23:00 KST
const row = (title: string, due_at: string, remaining_candidate = true) => ({
  title,
  due_at,
  remaining_candidate,
});
const options = { remainingOnly: false, period: "all" as const, sort: false };
it("uses Korean Monday boundaries and excludes the following Monday", () => {
  const items = [
    row("before", "2026-09-06T14:59:59Z"),
    row("monday", "2026-09-06T15:00:00Z"),
    row("sunday", "2026-09-13T14:59:59Z"),
    row("next", "2026-09-13T15:00:00Z"),
    row("invalid", "bad"),
  ];
  expect(
    filterDeadlines(items, { ...options, period: "week" }, now).map(
      (x) => x.title,
    ),
  ).toEqual(["monday", "sunday"]);
});
it("combines candidate and rolling 24-hour filters with precise boundaries", () => {
  const items = [
    row("now", new Date(now).toISOString()),
    row("end", new Date(now + 86400000).toISOString()),
    row("after", new Date(now + 86400001).toISOString()),
    row("submitted", new Date(now + 1000).toISOString(), false),
  ];
  expect(
    filterDeadlines(
      items,
      { ...options, period: "day", remainingOnly: true },
      now,
    ).map((x) => x.title),
  ).toEqual(["end"]);
});
it("preserves API order by default and stably sorts missing dates last without mutation", () => {
  const items = [
    row("missing", ""),
    row("later", "2026-09-15"),
    row("earlier", "2026-09-14"),
    row("tie", "2026-09-14"),
    row("invalid", "bad"),
  ];
  expect(filterDeadlines(items, options, now)).toEqual(items);
  expect(
    filterDeadlines(items, { ...options, sort: true }, now).map((x) => x.title),
  ).toEqual(["earlier", "tie", "later", "missing", "invalid"]);
  expect(items[0]!.title).toBe("missing");
});
it("labels unknown, expired and near deadlines without misleading rounding", () => {
  expect(remainingLabel("", now)).toBe("마감일 없음");
  expect(remainingLabel("bad", now)).toBe("마감일 확인 필요");
  expect(remainingLabel(new Date(now).toISOString(), now)).toBe("마감 지남");
  expect(remainingLabel(new Date(now + 59999).toISOString(), now)).toBe(
    "1분 미만 남음",
  );
  expect(remainingLabel(new Date(now + 3660000).toISOString(), now)).toBe(
    "1시간 1분 남음",
  );
});
