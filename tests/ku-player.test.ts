// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { initializeKuLecture } from "../src/playback/ku-player";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture() {
  document.body.innerHTML =
    '<div class="vc-vplay-container"><video class="vc-vplay-video1"></video></div><button class="vc-front-screen-play-btn">Play</button>';
  const video = document.querySelector("video")!;
  const button = document.querySelector("button")!;
  let source = "placeholder";
  Object.defineProperty(video, "currentSrc", { get: () => source });
  Object.defineProperty(video, "readyState", { value: 4 });
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
    width: 100,
  } as DOMRect);
  const click = vi.spyOn(button, "click");
  const pause = vi.spyOn(video, "pause").mockImplementation(() => undefined);
  return {
    video,
    button,
    click,
    pause,
    load() {
      source = "lecture";
      video.dispatchEvent(new Event("loadedmetadata"));
    },
  };
}
it("clicks once and waits for actual source replacement, not placeholder readiness", async () => {
  const f = fixture();
  const done = vi.fn();
  const result = initializeKuLecture(f.video, () => true).then((ready) => {
    done(ready.video);
    expect(ready.handoff()).toBe(true);
  });
  await Promise.resolve();
  expect(f.click).toHaveBeenCalledOnce();
  expect(done).not.toHaveBeenCalled();
  f.load();
  await result;
  expect(done).toHaveBeenCalledWith(f.video);
});
it("never initializes without authorization", async () => {
  const f = fixture();
  await expect(initializeKuLecture(f.video, () => false)).rejects.toThrow(
    "PLAYER_LOST",
  );
  expect(f.click).not.toHaveBeenCalled();
});
it("bounds initialization and rejects a placeholder that never changes", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const result = expect(
    initializeKuLecture(f.video, () => true),
  ).rejects.toThrow("PLAYER_LOST");
  await vi.advanceTimersByTimeAsync(15000);
  await result;
  expect(f.click).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects authorization loss during initialization", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let authorized = true;
  const result = expect(
    initializeKuLecture(f.video, () => authorized),
  ).rejects.toThrow("PLAYER_LOST");
  authorized = false;
  await vi.advanceTimersByTimeAsync(100);
  await result;
  expect(f.pause).toHaveBeenCalled();
});

it("cancels synchronously before the KU click when its signal is already aborted", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    initializeKuLecture(f.video, () => true, controller.signal),
  ).rejects.toThrow("PLAYER_LOST");
  expect(f.click).not.toHaveBeenCalled();
});

it("keeps a narrow event guard that pauses a page-scheduled play after cancellation", async () => {
  const f = fixture();
  const controller = new AbortController();
  const result = expect(
    initializeKuLecture(f.video, () => true, controller.signal),
  ).rejects.toThrow("PLAYER_LOST");
  controller.abort();
  await result;
  f.pause.mockClear();

  f.video.remove();
  f.video.dispatchEvent(new Event("play"));
  expect(f.pause).toHaveBeenCalledOnce();

  const helper = document.createElement("video");
  const helperPause = vi
    .spyOn(helper, "pause")
    .mockImplementation(() => undefined);
  document.body.append(helper);
  helper.dispatchEvent(new Event("play"));
  expect(helperPause).not.toHaveBeenCalled();
});

it("owns and pauses a late primary replacement after cancellation", async () => {
  const f = fixture();
  const controller = new AbortController();
  const result = expect(
    initializeKuLecture(f.video, () => true, controller.signal),
  ).rejects.toThrow("PLAYER_LOST");
  controller.abort();
  await result;

  const replacement = document.createElement("video");
  replacement.className = "vc-vplay-video1";
  const pause = vi
    .spyOn(replacement, "pause")
    .mockImplementation(() => undefined);
  document.querySelector(".vc-vplay-container")!.append(replacement);
  await Promise.resolve();
  replacement.dispatchEvent(new Event("play"));
  expect(pause).toHaveBeenCalled();
});

it("keeps ownership across every primary replacement after cancellation", async () => {
  const f = fixture();
  const controller = new AbortController();
  const result = expect(
    initializeKuLecture(f.video, () => true, controller.signal),
  ).rejects.toThrow("PLAYER_LOST");
  controller.abort();
  await result;

  const first = document.createElement("video");
  first.className = "vc-vplay-video1";
  vi.spyOn(first, "pause").mockImplementation(() => undefined);
  f.video.replaceWith(first);
  await Promise.resolve();
  const second = document.createElement("video");
  second.className = "vc-vplay-video1";
  const pauseSecond = vi
    .spyOn(second, "pause")
    .mockImplementation(() => undefined);
  first.replaceWith(second);
  await Promise.resolve();
  second.dispatchEvent(new Event("play"));
  expect(pauseSecond).toHaveBeenCalled();
});

it("retains ownership until handoff and rejects an abort after readiness", async () => {
  const f = fixture();
  const controller = new AbortController();
  const result = initializeKuLecture(f.video, () => true, controller.signal);
  f.load();
  const ready = await result;
  f.pause.mockClear();
  controller.abort();
  expect(f.pause).toHaveBeenCalled();
  expect(ready.handoff()).toBe(false);
});

it("rejects handoff when another ready KU primary appears after readiness", async () => {
  const f = fixture();
  const result = initializeKuLecture(f.video, () => true);
  f.load();
  const ready = await result;
  const second = document.createElement("video");
  second.className = "vc-vplay-video1";
  second.src = "https://kucom.korea.ac.kr/second.webm";
  Object.defineProperty(second, "readyState", { value: 4 });
  const pauseSecond = vi
    .spyOn(second, "pause")
    .mockImplementation(() => undefined);
  document.querySelector(".vc-vplay-container")!.append(second);

  expect(ready.handoff()).toBe(false);
  expect(f.pause).toHaveBeenCalled();
  expect(pauseSecond).toHaveBeenCalled();
});

it("hands off a ready replacement at normal speed and retires the old primary", async () => {
  const f = fixture();
  f.video.playbackRate = 2;
  f.video.defaultPlaybackRate = 2;
  const result = initializeKuLecture(f.video, () => true);
  const replacement = document.createElement("video");
  replacement.className = "vc-vplay-video1";
  replacement.playbackRate = 2;
  replacement.defaultPlaybackRate = 2;
  Object.defineProperty(replacement, "currentSrc", {
    get: () => "placeholder",
  });
  Object.defineProperty(replacement, "readyState", { value: 4 });
  const replacementPause = vi
    .spyOn(replacement, "pause")
    .mockImplementation(() => undefined);
  f.video.replaceWith(replacement);
  replacement.dispatchEvent(new Event("loadedmetadata"));

  const ready = await result;
  expect(ready.video).toBe(replacement);
  expect(replacement.playbackRate).toBe(1);
  expect(replacement.defaultPlaybackRate).toBe(1);
  expect(ready.handoff()).toBe(true);
  expect(f.pause).toHaveBeenCalled();

  replacementPause.mockClear();
  replacement.dispatchEvent(new Event("play"));
  expect(replacementPause).not.toHaveBeenCalled();

  f.pause.mockClear();
  f.video.className = "retired";
  f.video.dispatchEvent(new Event("play"));
  expect(f.pause).toHaveBeenCalled();
});
