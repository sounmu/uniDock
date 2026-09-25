// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { PlaybackPlayer } from "../src/playback/player";

const players: PlaybackPlayer[] = [];
afterEach(() => {
  for (const player of players) player.stop();
  players.length = 0;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(
  options: ConstructorParameters<typeof PlaybackPlayer>[1] = {},
) {
  const video = document.createElement("video");
  document.body.append(video);
  const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
  const player = new PlaybackPlayer(video, options);
  players.push(player);
  return { video, play, pause, player };
}

// jsdom cannot produce trusted media events. Capture the handler registered on a
// real <video> and deliver a native-event-shaped signal for that branch only.
function nativeSignals(video: HTMLVideoElement, names: readonly string[]) {
  const handlers = new Map(names.map((name) => [name, [] as EventListener[]]));
  vi.spyOn(video, "addEventListener").mockImplementation(
    (type, handler, options) => {
      if (typeof handler === "function") handlers.get(type)?.push(handler);
      EventTarget.prototype.addEventListener.call(
        video,
        type,
        handler,
        options,
      );
    },
  );
  return (name: string) => {
    for (const handler of handlers.get(name) ?? [])
      handler({ isTrusted: true } as Event);
  };
}
function nativeSignal(video: HTMLVideoElement, name: string) {
  const notify = nativeSignals(video, [name]);
  return () => notify(name);
}

it("starts at normal native speed, pauses, resumes and stops without seeking", async () => {
  const { video, play, pause, player } = fixture();
  video.playbackRate = 2;
  const seek = vi.spyOn(video, "currentTime", "set");
  expect(await player.start()).toEqual({ state: "playing" });
  expect(video.playbackRate).toBe(1);
  expect(play).toHaveBeenCalledTimes(1);
  expect(player.pause()).toEqual({ state: "paused" });
  expect(await player.resume()).toEqual({ state: "playing" });
  expect(play).toHaveBeenCalledTimes(2);
  expect(player.stop()).toEqual({ state: "stopped" });
  expect(pause).toHaveBeenCalledTimes(2);
  expect(await player.start()).toEqual({ state: "stopped" });
  expect(seek).not.toHaveBeenCalled();
});

it("reads metadata without playing or loading, rejecting nonfinite durations and forged events", async () => {
  vi.useFakeTimers();
  const { video, play, player } = fixture({ timeoutMs: 100 });
  const load = vi.spyOn(video, "load");
  Object.defineProperty(video, "readyState", { configurable: true, value: 1 });
  Object.defineProperty(video, "duration", { configurable: true, value: 42 });
  expect(await player.readDuration()).toBe(42);
  expect(play).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  Object.defineProperty(video, "readyState", { configurable: true, value: 0 });
  const notify = nativeSignal(video, "loadedmetadata");
  const pending = player.readDuration();
  video.dispatchEvent(new Event("loadedmetadata"));
  Object.defineProperty(video, "readyState", { configurable: true, value: 1 });
  notify();
  expect(await pending).toBe(42);
  Object.defineProperty(video, "duration", {
    configurable: true,
    value: Infinity,
  });
  const unknown = player.readDuration();
  await vi.advanceTimersByTimeAsync(100);
  expect(await unknown).toBeNull();
});

it("only a trusted native ended event with ended=true completes playback, never credit", async () => {
  const { video, player } = fixture();
  const notify = nativeSignal(video, "ended");
  await player.start();
  video.dispatchEvent(new Event("ended"));
  expect(player.status.state).toBe("playing");
  notify();
  expect(player.status.state).toBe("playing");
  Object.defineProperty(video, "ended", { configurable: true, value: true });
  notify();
  expect(player.status).toEqual({ state: "ended" });
  expect(await player.resume()).toEqual({ state: "ended" });
});

it("stops playback if the native player changes away from normal speed", async () => {
  const { video, player, pause } = fixture();
  await player.start();
  video.dispatchEvent(new Event("ratechange"));
  expect(player.status.state).toBe("playing");
  video.playbackRate = 1.5;
  expect(player.status).toEqual({ state: "failed", reason: "rate" });
  expect(pause).toHaveBeenCalledOnce();
});

it("does not misclassify the native pause that precedes ended as a user pause", async () => {
  const states: string[] = [];
  const { video, player } = fixture({
    onStateChange: ({ state }) => states.push(state),
  });
  const notify = nativeSignals(video, ["pause", "ended"]);
  await player.start();
  Object.defineProperty(video, "paused", { configurable: true, value: true });
  Object.defineProperty(video, "ended", { configurable: true, value: true });
  notify("pause");
  expect(player.status.state).toBe("playing");
  notify("ended");
  expect(player.status.state).toBe("ended");
  expect(states).toEqual(["starting", "playing", "ended"]);
});

it("reports login, autoplay denial, play rejection and native media errors", async () => {
  const login = fixture({ isLoginPage: () => true });
  expect(await login.player.start()).toEqual({ state: "blocked-login" });
  expect(login.play).not.toHaveBeenCalled();
  expect(await login.player.readDuration()).toBeNull();

  const autoplay = fixture();
  autoplay.play.mockRejectedValue(
    new DOMException("Denied", "NotAllowedError"),
  );
  expect(await autoplay.player.start()).toEqual({ state: "blocked-autoplay" });

  const rejected = fixture();
  rejected.play.mockRejectedValue(new Error("decoder"));
  expect(await rejected.player.start()).toEqual({
    state: "failed",
    reason: "play",
  });

  const media = fixture();
  const error = nativeSignal(media.video, "error");
  await media.player.start();
  Object.defineProperty(media.video, "error", {
    configurable: true,
    value: { code: 3 },
  });
  media.video.dispatchEvent(new Event("error"));
  expect(media.player.status.state).toBe("playing");
  error();
  expect(media.player.status).toEqual({ state: "failed", reason: "media" });
});

it("bounds hung play and metadata; ignores late completion and cancellation", async () => {
  vi.useFakeTimers();
  const { video, player, play, pause } = fixture({ timeoutMs: 50 });
  let resolvePlay!: () => void;
  play.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolvePlay = resolve;
      }),
  );
  const pending = player.start();
  await vi.advanceTimersByTimeAsync(50);
  expect(await pending).toEqual({ state: "failed", reason: "timeout" });
  resolvePlay();
  await Promise.resolve();
  expect(player.status.state).toBe("failed");
  expect(pause).toHaveBeenCalled();

  const second = fixture({ timeoutMs: 50 });
  let release!: () => void;
  second.play.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const starting = second.player.start();
  second.player.invalidate();
  expect(await starting).toEqual({ state: "stopped" });
  release();
  await Promise.resolve();
  expect(second.player.status.state).toBe("stopped");
  const metadata = second.player.readDuration();
  expect(await metadata).toBeNull();
  video.dispatchEvent(new Event("ended"));

  const detached = fixture({ timeoutMs: 50 });
  detached.play.mockImplementation(() => new Promise<void>(() => {}));
  const detachedStart = detached.player.start();
  detached.video.remove();
  await vi.advanceTimersByTimeAsync(50);
  expect(await detachedStart).toEqual({ state: "stopped" });
});

it("invalidates detached or navigated documents and stale native event handlers", async () => {
  const { video, player } = fixture();
  const notify = nativeSignal(video, "ended");
  await player.start();
  Object.defineProperty(video, "ended", { configurable: true, value: true });
  video.remove();
  notify();
  expect(player.status.state).toBe("playing");
  expect(player.invalidate()).toEqual({ state: "stopped" });
  notify();
  expect(player.status.state).toBe("stopped");
});
