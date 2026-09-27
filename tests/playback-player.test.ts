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
  const handlers = new Map(
    names.map((name) => [name, new Set<EventListener>()]),
  );
  vi.spyOn(video, "addEventListener").mockImplementation(
    (type, handler, options) => {
      if (typeof handler === "function") handlers.get(type)?.add(handler);
      EventTarget.prototype.addEventListener.call(
        video,
        type,
        handler,
        options,
      );
    },
  );
  vi.spyOn(video, "removeEventListener").mockImplementation(
    (type, handler, options) => {
      if (typeof handler === "function") handlers.get(type)?.delete(handler);
      EventTarget.prototype.removeEventListener.call(
        video,
        type,
        handler,
        options,
      );
    },
  );
  return (name: string) => {
    for (const handler of [...(handlers.get(name) ?? [])])
      handler({ isTrusted: true } as Event);
  };
}
function nativeSignal(video: HTMLVideoElement, name: string) {
  const notify = nativeSignals(video, [name]);
  return () => notify(name);
}

function advanceMedia(video: HTMLVideoElement, notify: (name: string) => void) {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  Object.defineProperty(video, "paused", { configurable: true, value: false });
  Object.defineProperty(video, "duration", { configurable: true, value: 2 });
  notify("playing");
  for (let time = 0.25; time <= 2; time += 0.25) {
    clock.mockReturnValue(time * 1000);
    video.currentTime = time;
    notify("timeupdate");
  }
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

it("physically rejects trusted native play while paused until explicit resume", async () => {
  const { video, play, pause, player } = fixture();
  const notify = nativeSignals(video, ["play", "playing"]);
  await player.start();
  player.pause();
  pause.mockClear();

  // Script-forged media events cannot exercise the trusted native-control path.
  video.dispatchEvent(new Event("play"));
  video.dispatchEvent(new Event("playing"));
  expect(pause).not.toHaveBeenCalled();
  expect(player.status).toEqual({ state: "paused" });

  notify("play");
  notify("playing");
  expect(pause).toHaveBeenCalledTimes(2);
  expect(player.status).toEqual({ state: "paused" });

  expect(await player.resume()).toEqual({ state: "playing" });
  expect(play).toHaveBeenCalledTimes(2);
});

it("physically rejects native play when the document is already hidden", async () => {
  let visible = true;
  const { video, pause, player } = fixture({ isVisible: () => visible });
  const notify = nativeSignal(video, "play");
  await player.start();
  pause.mockClear();

  visible = false;
  notify();

  expect(pause).toHaveBeenCalledOnce();
  expect(player.status).toEqual({ state: "paused" });
});

it("does not let a late hidden play acceptance resurrect terminal failure", async () => {
  let visible = true;
  const { video, play, player } = fixture({ isVisible: () => visible });
  const rateChanged = nativeSignal(video, "ratechange");
  let acceptPlay!: () => void;
  play.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        acceptPlay = resolve;
      }),
  );

  const starting = player.start();
  video.playbackRate = 1.5;
  rateChanged();
  expect(await starting).toEqual({ state: "failed", reason: "rate" });

  visible = false;
  acceptPlay();
  await Promise.resolve();
  await Promise.resolve();
  expect(player.status).toEqual({ state: "failed", reason: "rate" });
});

it("only a trusted native ended event with ended=true completes playback, never credit", async () => {
  const { video, player } = fixture();
  const notify = nativeSignals(video, ["ended", "playing", "timeupdate"]);
  await player.start();
  video.dispatchEvent(new Event("ended"));
  expect(player.status.state).toBe("playing");
  notify("ended");
  expect(player.status.state).toBe("playing");
  advanceMedia(video, notify);
  Object.defineProperty(video, "ended", { configurable: true, value: true });
  notify("ended");
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
  const notify = nativeSignals(video, [
    "pause",
    "ended",
    "playing",
    "timeupdate",
  ]);
  await player.start();
  advanceMedia(video, notify);
  Object.defineProperty(video, "paused", { configurable: true, value: true });
  Object.defineProperty(video, "ended", { configurable: true, value: true });
  notify("pause");
  expect(player.status.state).toBe("playing");
  notify("ended");
  expect(player.status.state).toBe("ended");
  expect(states).toEqual(["starting", "playing", "ended"]);
});

it.each(["no-progress", "seek", "source-change"])(
  "pauses rather than completes on an unverified end: %s",
  async (scenario) => {
    const onDiagnostic = vi.fn();
    const { video, player } = fixture({ onDiagnostic });
    const notify = nativeSignals(video, [
      "ended",
      "playing",
      "timeupdate",
      "seeking",
      "loadstart",
    ]);
    await player.start();
    if (scenario !== "no-progress") advanceMedia(video, notify);
    if (scenario === "seek") notify("seeking");
    if (scenario === "source-change") notify("loadstart");
    Object.defineProperty(video, "ended", { configurable: true, value: true });
    notify("ended");
    expect(player.status).toEqual({
      state: "paused",
      reason: "unverified-end",
    });
    expect(onDiagnostic).toHaveBeenCalledWith("END_UNVERIFIED");
  },
);

it("keeps native play blocked after an unverified end until explicit resume", async () => {
  const { video, play, pause, player } = fixture();
  const notify = nativeSignals(video, ["ended", "play", "playing"]);
  await player.start();
  Object.defineProperty(video, "ended", { configurable: true, value: true });
  notify("ended");
  expect(player.status).toEqual({
    state: "paused",
    reason: "unverified-end",
  });
  pause.mockClear();

  Object.defineProperty(video, "ended", { configurable: true, value: false });
  notify("play");
  notify("playing");
  expect(pause).toHaveBeenCalledTimes(2);
  expect(player.status).toEqual({
    state: "paused",
    reason: "unverified-end",
  });

  expect(await player.resume()).toEqual({ state: "playing" });
  expect(play).toHaveBeenCalledTimes(2);
});

it("reports login, autoplay denial, play rejection and native media errors", async () => {
  const login = fixture({ isLoginPage: () => true });
  expect(await login.player.start()).toEqual({ state: "blocked-login" });
  expect(login.play).not.toHaveBeenCalled();

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

it("retries autoplay denial once muted and reports fixed diagnostic codes", async () => {
  const onDiagnostic = vi.fn();
  const { video, play, player } = fixture({ onDiagnostic });
  play.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
  expect(await player.start()).toEqual({ state: "playing" });
  expect(video.muted).toBe(true);
  expect(play).toHaveBeenCalledTimes(2);
  expect(onDiagnostic.mock.calls.flat()).toEqual([
    "PLAY_REQUEST",
    "AUTOPLAY_DENIED",
    "MUTED_RETRY",
    "PLAY_ACCEPTED",
  ]);
});

it("does not retry decoder failures or already muted autoplay denial", async () => {
  const f = fixture();
  f.video.muted = true;
  f.play.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
  expect(await f.player.start()).toEqual({ state: "blocked-autoplay" });
  expect(f.play).toHaveBeenCalledOnce();
});

it("bounds hung play and ignores late completion and cancellation", async () => {
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
  expect(second.pause).toHaveBeenCalledOnce();
  release();
  await Promise.resolve();
  await Promise.resolve();
  expect(second.player.status.state).toBe("stopped");
  expect(second.pause).toHaveBeenCalledTimes(2);
  video.dispatchEvent(new Event("ended"));

  const detached = fixture({ timeoutMs: 50 });
  detached.play.mockImplementation(() => new Promise<void>(() => {}));
  const detachedStart = detached.player.start();
  detached.video.remove();
  await vi.advanceTimersByTimeAsync(50);
  expect(await detachedStart).toEqual({ state: "stopped" });
  expect(detached.pause).toHaveBeenCalledOnce();
});

it.each(["url-changed", "detached"])(
  "invalidates and physically pauses owned media when %s",
  async (scenario) => {
    const { video, player, pause } = fixture();
    const originalUrl = location.href;
    await player.start();
    if (scenario === "url-changed") history.pushState({}, "", "#changed");
    else video.remove();

    expect(player.invalidate()).toEqual({ state: "stopped" });
    expect(pause).toHaveBeenCalledOnce();
    history.replaceState({}, "", originalUrl);
  },
);

it("does not pause media whose ownership moved to another document", async () => {
  const { video, player, pause } = fixture();
  await player.start();
  document.implementation.createHTMLDocument().adoptNode(video);

  expect(player.invalidate()).toEqual({ state: "stopped" });
  expect(pause).not.toHaveBeenCalled();
});

it("invalidates stale native event handlers", async () => {
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
