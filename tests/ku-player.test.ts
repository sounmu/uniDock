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
  return {
    video,
    button,
    click,
    load() {
      source = "lecture";
      video.dispatchEvent(new Event("loadedmetadata"));
    },
  };
}
it("clicks once and waits for actual source replacement, not placeholder readiness", async () => {
  const f = fixture();
  const done = vi.fn();
  const result = initializeKuLecture(f.video, () => true).then(done);
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
});
