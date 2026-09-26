import { describe, expect, it } from "vitest";
import { isDiscovery, isPlaybackCommand } from "../src/playback/bridge";

const handle = (suffix: string) =>
  `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

describe("ordered playlist boundary", () => {
  it("accepts only 1-100 distinct opaque handles in click order", () => {
    expect(
      isPlaybackCommand({
        version: 1,
        type: "PLAYBACK_START",
        handles: [handle("1"), handle("2")],
      }),
    ).toBe(true);
    expect(
      isPlaybackCommand({
        version: 1,
        type: "PLAYBACK_START",
        handles: [handle("1"), handle("1")],
      }),
    ).toBe(false);
    expect(
      isPlaybackCommand({ version: 1, type: "PLAYBACK_START", handles: [] }),
    ).toBe(false);
    expect(
      isPlaybackCommand({
        version: 1,
        type: "PLAYBACK_START",
        handles: Array.from({ length: 101 }, (_, i) => handle(String(i + 1))),
      }),
    ).toBe(false);
  });

  it("allows no scheduling, duration, completion, or credit fields in discovery", () => {
    const base = {
      accountKey: "a".repeat(64),
      origin: "https://mylms.korea.ac.kr",
      courses: [{ id: "101", name: "Course" }],
      candidates: [{ id: "101:501", courseId: "101", title: "Lecture" }],
    };
    expect(isDiscovery(base)).toBe(true);
    expect(
      isDiscovery({
        ...base,
        candidates: [{ ...base.candidates[0], durationMinutes: 10 }],
      }),
    ).toBe(false);
  });
});
