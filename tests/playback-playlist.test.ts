import { afterEach, describe, expect, it, vi } from "vitest";
import { isDiscovery, isPlaybackCommand, playbackCommand } from "../src/playback/bridge";

afterEach(() => vi.unstubAllGlobals());

it.each([
  [{}, true],
  [{ nativeResumeAvailable: true }, true],
  [{ nativeResumeAvailable: false }, true],
  [{ nativeResumeAvailable: "true" }, false],
  [{ nativeResumeAvailable: null }, false],
  [{ nativeResumeAvailable: true, mediaUrl: "https://example.invalid/media" }, false],
] as const)("validates optional native resume availability %j", async (availability, accepted) => {
  const snapshot = {
    courses: [], labels: {}, queue: [], current: null, status: "paused", ...availability,
  };
  vi.stubGlobal("chrome", {
    runtime: { sendMessage: vi.fn().mockResolvedValue({ status: "success", snapshot }) },
  });
  const result = await playbackCommand({ version: 1, type: "PLAYBACK_STATUS" });
  if (accepted) expect(result).toEqual({ status: "success", snapshot });
  else expect(result).toEqual({ status: "error", code: "INVALID_RESPONSE" });
});

const handle = (suffix: string) =>
  `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const source = { sourceTabId: 7, documentToken: handle("99") };

describe("ordered playlist boundary", () => {
  it("accepts only 1-100 distinct opaque handles in click order", () => {
    expect(
      isPlaybackCommand({
        version: 1,
        type: "PLAYBACK_START",
        ...source,
        handles: [handle("1"), handle("2")],
      }),
    ).toBe(true);
    expect(
      isPlaybackCommand({
        version: 1,
        type: "PLAYBACK_START",
        ...source,
        handles: [handle("1"), handle("1")],
      }),
    ).toBe(false);
    expect(
      isPlaybackCommand({
        version: 1,
        type: "PLAYBACK_START",
        ...source,
        handles: [],
      }),
    ).toBe(false);
    expect(
      isPlaybackCommand({
        version: 1,
        type: "PLAYBACK_START",
        ...source,
        handles: Array.from({ length: 101 }, (_, i) => handle(String(i + 1))),
      }),
    ).toBe(false);
    expect(
      isPlaybackCommand({
        version: 1,
        type: "PLAYBACK_START",
        ...source,
        handles: [handle("1")],
        unexpected: true,
      }),
    ).toBe(false);
    expect(
      isPlaybackCommand({
        version: 1,
        type: "PLAYBACK_START",
        handles: [handle("1")],
        sourceTabId: -1,
        documentToken: "invalid",
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
