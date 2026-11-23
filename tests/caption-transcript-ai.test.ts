import { expect, it } from "vitest";
import {
  parseMediaScript,
  projectServerSegments,
  timedCues,
} from "../src/captions/transcript";

it("projects ms segments to timed items", () => {
  const items = projectServerSegments([
    { start_ms: 0, end_ms: 1500, text: "안녕하세요" },
    { start_ms: 65000, end_ms: 67000, text: "다음 내용" },
    { start_ms: 3600000, end_ms: 3601000, text: "한 시간 뒤" },
  ]);
  expect(items.map((item) => item.time)).toEqual(["00:00", "01:05", "01:00:00"]);
  expect(items[0]!.text).toBe("안녕하세요");
  expect(items.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
    [0, 1500],
    [65000, 67000],
    [3600000, 3601000],
  ]);
});

it("keeps a zero-length segment in the panel but not on the video", () => {
  const items = projectServerSegments([
    { start_ms: 1000, end_ms: 1000, text: "순간" },
    { start_ms: 2000, end_ms: 2500.4, text: "이어서" },
  ]);
  expect(items).toEqual([
    { index: 0, time: "00:01", text: "순간" },
    { index: 1, time: "00:02", text: "이어서", startMs: 2000, endMs: 2500 },
  ]);
  expect(timedCues(items)).toEqual([{ start: 2000, end: 2500, text: "이어서" }]);
});

it("builds ordered video cues and drops untimed items and exact repeats", () => {
  expect(
    timedCues([
      { index: 0, time: "00:05", text: "둘", startMs: 5000, endMs: 6000 },
      { index: 1, time: "", text: "시간 없음" },
      { index: 2, time: "00:01", text: "하나", startMs: 1000, endMs: 2000 },
      { index: 3, time: "00:05", text: "둘", startMs: 5000, endMs: 6000 },
      { index: 4, time: "00:05", text: "둘", startMs: 5000, endMs: 7000 },
    ]),
  ).toEqual([
    { start: 1000, end: 2000, text: "하나" },
    { start: 5000, end: 6000, text: "둘" },
    { start: 5000, end: 7000, text: "둘" },
  ]);
});

it("never times KU wall-clock or untimed scripts", () => {
  const script = parseMediaScript("[10:00:01 ~ 10:00:04]\n첫 줄\n");
  expect(script[0]).toEqual({ index: 0, time: "10:00:01", text: "첫 줄" });
  expect(timedCues(script)).toEqual([]);
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
