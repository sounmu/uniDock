import { expect, it } from "vitest";
import { projectServerSegments } from "../src/captions/transcript";

it("projects ms segments to timed items", () => {
  const items = projectServerSegments([
    { start_ms: 0, end_ms: 1500, text: "안녕하세요" },
    { start_ms: 65000, end_ms: 67000, text: "다음 내용" },
    { start_ms: 3600000, end_ms: 3601000, text: "한 시간 뒤" },
  ]);
  expect(items.map((item) => item.time)).toEqual(["00:00", "01:05", "01:00:00"]);
  expect(items[0]!.text).toBe("안녕하세요");
});

it("drops empty text but keeps order", () => {
  const items = projectServerSegments([
    { start_ms: 0, end_ms: 10, text: "  " },
    { start_ms: 20, end_ms: 30, text: "내용" },
  ]);
  expect(items).toHaveLength(1);
  expect(items[0]!.text).toBe("내용");
});

it("rejects reversed cues", () => {
  expect(() =>
    projectServerSegments([{ start_ms: 500, end_ms: 100, text: "x" }]),
  ).toThrow();
});

it("rejects cues going backwards", () => {
  expect(() =>
    projectServerSegments([
      { start_ms: 1000, end_ms: 2000, text: "a" },
      { start_ms: 500, end_ms: 1500, text: "b" },
    ]),
  ).toThrow();
});

it("rejects cues beyond the media duration", () => {
  expect(() =>
    projectServerSegments([{ start_ms: 20000, end_ms: 21000, text: "x" }], 1000),
  ).toThrow();
});
