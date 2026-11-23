// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CAPTION_TRACK_LABEL,
  CaptionTrackController,
  hideCaptionTrack,
  paddedCueText,
  showCaptionTrack,
} from "../src/playback/caption-track";
import { isPlayerCaptionTrack } from "../src/playback/bridge";

class FakeCue {
  constructor(
    readonly startTime: number,
    readonly endTime: number,
    readonly text: string,
  ) {}
}
// Mirrors the browser contract the controller relies on: `cues` is null while disabled.
class FakeTrack {
  mode: TextTrackMode = "hidden";
  private list: FakeCue[] = [];
  constructor(
    readonly kind: TextTrackKind,
    readonly label: string,
    readonly language: string,
  ) {}
  get cues() {
    return this.mode === "disabled" ? null : Object.assign([...this.list]);
  }
  addCue(cue: FakeCue) {
    this.list.push(cue);
  }
  removeCue(cue: FakeCue) {
    this.list = this.list.filter((entry) => entry !== cue);
  }
  get texts() {
    return this.list.map((cue) => [cue.startTime, cue.endTime, cue.text]);
  }
}
function lectureVideo(existing: FakeTrack[] = []) {
  const video = document.createElement("video");
  const tracks: FakeTrack[] = [...existing];
  Object.defineProperty(video, "textTracks", { value: tracks });
  Object.defineProperty(video, "addTextTrack", {
    value: (kind: TextTrackKind, label: string, language: string) => {
      const track = new FakeTrack(kind, label, language);
      tracks.push(track);
      return track;
    },
  });
  return { video, tracks };
}
const cues = [
  { start: 1000, end: 2500, text: "첫 자막" },
  { start: 3000, end: 4000, text: "둘째 자막" },
];

beforeEach(() => vi.stubGlobal("VTTCue", FakeCue));
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("adds one Korean subtitles track and replaces its cues on every delivery", () => {
  const { video, tracks } = lectureVideo();
  showCaptionTrack(video, cues);
  showCaptionTrack(video, [cues[1]!]);
  expect(tracks).toHaveLength(1);
  expect(tracks[0]).toMatchObject({
    kind: "subtitles",
    label: CAPTION_TRACK_LABEL,
    language: "ko",
    mode: "showing",
  });
  expect(tracks[0]!.texts).toEqual([[3, 4, "\u2002둘째 자막\u2002"]]);
  expect(paddedCueText("윗줄\n아랫줄")).toBe("\u2002윗줄\u2002\n\u2002아랫줄\u2002");
});

it("reuses a track left by an earlier script and clears it on teardown", () => {
  const leftover = new FakeTrack("subtitles", CAPTION_TRACK_LABEL, "ko");
  leftover.mode = "disabled";
  const own = new FakeTrack("captions", "강의 자막", "ko");
  const { video, tracks } = lectureVideo([own, leftover]);
  showCaptionTrack(video, cues);
  expect(tracks).toHaveLength(2);
  expect(leftover.texts).toHaveLength(2);
  hideCaptionTrack(video);
  expect(leftover.mode).toBe("disabled");
  expect(leftover.texts).toEqual([]);
  expect(own.mode).toBe("hidden");
});

it("waits for the lecture video, follows a replaced element and stops on dispose", async () => {
  const controller = new CaptionTrackController(
    () => document.querySelector("video"),
    document.body,
  );
  controller.deliver(cues);
  const first = lectureVideo();
  const appeared = new Promise<void>((resolve) =>
    new MutationObserver((_, observer) => {
      observer.disconnect();
      queueMicrotask(resolve);
    }).observe(document.body, { childList: true }),
  );
  document.body.append(first.video);
  await appeared;
  expect(first.tracks[0]?.mode).toBe("showing");

  const second = lectureVideo();
  const replaced = new Promise<void>((resolve) =>
    new MutationObserver((_, observer) => {
      observer.disconnect();
      queueMicrotask(resolve);
    }).observe(document.body, { childList: true }),
  );
  first.video.replaceWith(second.video);
  await replaced;
  expect(first.tracks[0]?.mode).toBe("disabled");
  expect(second.tracks[0]?.texts).toHaveLength(2);

  controller.dispose();
  expect(second.tracks[0]?.mode).toBe("disabled");
});

it.each([
  ["extra field", { version: 1, type: "PLAYBACK_CAPTION_TRACK", cues, url: "x" }],
  ["reversed cue", { version: 1, type: "PLAYBACK_CAPTION_TRACK", cues: [{ start: 5, end: 4, text: "a" }] }],
  ["fractional time", { version: 1, type: "PLAYBACK_CAPTION_TRACK", cues: [{ start: 0.5, end: 4, text: "a" }] }],
  ["empty text", { version: 1, type: "PLAYBACK_CAPTION_TRACK", cues: [{ start: 0, end: 4, text: "" }] }],
  ["extra cue field", { version: 1, type: "PLAYBACK_CAPTION_TRACK", cues: [{ ...cues[0], html: "<b>" }] }],
])("rejects a caption track message with %s", (_, message) =>
  expect(isPlayerCaptionTrack(message)).toBe(false),
);

it("accepts cues and the empty clear message", () => {
  expect(isPlayerCaptionTrack({ version: 1, type: "PLAYBACK_CAPTION_TRACK", cues })).toBe(true);
  expect(isPlayerCaptionTrack({ version: 1, type: "PLAYBACK_CAPTION_TRACK", cues: [] })).toBe(true);
});
