// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import content from "../entrypoints/player.content";
import type { PlayerBinding } from "../src/playback/bridge";

vi.mock("wxt/utils/define-content-script", () => ({
  defineContentScript: (options: unknown) => options,
}));

const page = content as unknown as { main: () => void };
const extension = "fixture-extension";
const sender = {
  id: extension,
  url: `chrome-extension://${extension}/background.js`,
};
const binding: PlayerBinding = {
  runId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  token: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  deadline: Date.now() + 60000,
};
type Wire = { type: string; state?: string; action?: string };
type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (response: unknown) => void,
) => boolean;

function setup(
  options: {
    authorization?: unknown;
    lease?: unknown;
    url?: string;
    hidden?: boolean;
  } = {},
) {
  const address = {
    href: options.url ?? "https://kucom.korea.ac.kr/em/lecture",
  };
  vi.stubGlobal("location", address);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: options.hidden ? "hidden" : "visible",
  });
  const activeBinding = { ...binding, deadline: Date.now() + 60000 };
  const authorization = options.authorization ?? {
    binding: activeBinding,
    leaseUntil: Date.now() + 45000,
  };
  const listeners: Listener[] = [];
  const subscriptions = new Map<string, (message: Wire) => void>();
  const sendMessage = vi.fn(async (message: Wire) => {
    if (message.type === "PLAYBACK_PLAYER_HELLO")
      return { ok: true, authorization };
    if (message.type === "PLAYBACK_PLAYER_LEASE")
      return options.lease ?? { ok: true, authorization };
    if (message.type === "PLAYBACK_PLAYER_EVENT") {
      subscriptions.get(message.state ?? "")?.(message);
      return { ok: true };
    }
    throw new Error(`unexpected message: ${message.type}`);
  });
  vi.stubGlobal("chrome", {
    runtime: {
      id: extension,
      getURL: (path: string) => `chrome-extension://${extension}/${path}`,
      sendMessage,
      onMessage: {
        addListener: (listener: Listener) => listeners.push(listener),
      },
    },
  });
  const event = (state: string) =>
    new Promise<Wire>((resolve) => subscriptions.set(state, resolve));
  const video = document.createElement("video");
  document.body.className = "vc-vplay-container";
  video.className = "vc-vplay-video1";
  video.src = "https://kucom.korea.ac.kr/fixture.webm";
  Object.defineProperty(video, "readyState", { configurable: true, value: 4 });
  const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
  const control = (
    action: string,
    from: chrome.runtime.MessageSender = sender,
    fields: Record<string, unknown> = {},
  ) => {
    let delivered!: (response: unknown) => void;
    const done = new Promise<unknown>((resolve) => {
      delivered = resolve;
    });
    const respond = vi.fn((response: unknown) => delivered(response));
    const accepted = listeners[0]!(
      {
        version: 1,
        type: "PLAYBACK_PLAYER_CONTROL",
        ...activeBinding,
        action,
        ...(action === "resume" ? { leaseUntil: Date.now() + 45000 } : {}),
        ...fields,
      },
      from,
      respond,
    );
    return { accepted, respond, done };
  };
  return {
    address,
    video,
    play,
    pause,
    control,
    event,
    sendMessage,
    listeners,
    activeBinding,
  };
}

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();
  document.body.className = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "visibilityState");
});

it("does not handshake on non-player pages or until exactly one native video exists", async () => {
  const other = setup({ url: "https://kucom.korea.ac.kr/other" });
  document.body.append(other.video);
  page.main();
  expect(other.listeners).toHaveLength(0);
  expect(other.sendMessage).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();

  const fixture = setup();
  const second = document.createElement("video");
  second.className = "vc-vplay-video1";
  second.src = "https://kucom.korea.ac.kr/fixture.webm";
  Object.defineProperty(second, "readyState", { value: 4 });
  document.body.append(fixture.video, second);
  const playing = fixture.event("playing");
  page.main();
  await Promise.resolve();
  expect(fixture.sendMessage).not.toHaveBeenCalled();
  second.remove();
  await playing;
  expect(fixture.sendMessage).toHaveBeenCalledWith({
    version: 1,
    type: "PLAYBACK_PLAYER_HELLO",
  });
  expect(fixture.play).toHaveBeenCalledOnce();
});

it("selects the sole loaded video among ten placeholders even with zero layout size", async () => {
  const fixture = setup();
  fixture.video.src = "https://kucom.korea.ac.kr/fixture.webm";
  Object.defineProperty(fixture.video, "readyState", { value: 4 });
  fixture.video.style.display = "none";
  expect(fixture.video.getBoundingClientRect().width).toBe(0);
  document.body.append(
    ...Array.from({ length: 10 }, () => document.createElement("video")),
    fixture.video,
  );
  const playing = fixture.event("playing");
  page.main();
  await playing;
  expect(fixture.play).toHaveBeenCalledOnce();
});

it("ignores a loaded auxiliary video until the KU primary lecture is ready", async () => {
  const fixture = setup();
  const helper = document.createElement("video");
  helper.className = "vc-sdvideo-video";
  helper.src = "https://kucom.korea.ac.kr/helper.webm";
  Object.defineProperty(helper, "readyState", { value: 4 });
  const helperPlay = vi.spyOn(helper, "play");
  document.body.append(helper);
  page.main();
  await Promise.resolve();
  expect(fixture.sendMessage).not.toHaveBeenCalled();
  Object.defineProperty(fixture.video, "readyState", {
    configurable: true,
    value: 0,
  });
  document.body.append(fixture.video);
  await Promise.resolve();
  expect(fixture.sendMessage).not.toHaveBeenCalled();
  const playing = fixture.event("playing");
  Object.defineProperty(fixture.video, "readyState", { value: 4 });
  fixture.video.dispatchEvent(new Event("loadedmetadata"));
  await playing;
  expect(fixture.play).toHaveBeenCalledOnce();
  expect(helperPlay).not.toHaveBeenCalled();
});

it("does not guess between two loaded videos even if one is CSS hidden", async () => {
  const fixture = setup();
  const second = document.createElement("video");
  for (const video of [fixture.video, second]) {
    video.className = "vc-vplay-video1";
    video.src = "https://kucom.korea.ac.kr/fixture.webm";
    Object.defineProperty(video, "readyState", { value: 4 });
  }
  document.body.append(fixture.video, second);
  page.main();
  await Promise.resolve();
  expect(fixture.sendMessage).not.toHaveBeenCalled();
  second.style.display = "none";
  await Promise.resolve();
  expect(fixture.sendMessage).not.toHaveBeenCalled();
  const playing = fixture.event("playing");
  second.remove();
  await playing;
  expect(fixture.play).toHaveBeenCalledOnce();
});

it("discovers media readiness without a DOM mutation", async () => {
  vi.useFakeTimers();
  const fixture = setup();
  let readyState = 0;
  fixture.video.src = "https://kucom.korea.ac.kr/fixture.webm";
  Object.defineProperty(fixture.video, "readyState", { get: () => readyState });
  document.body.append(fixture.video, document.createElement("video"));
  page.main();
  await Promise.resolve();
  expect(fixture.play).not.toHaveBeenCalled();
  readyState = 4;
  await vi.advanceTimersByTimeAsync(500);
  expect(fixture.play).toHaveBeenCalledOnce();
});

it("rejects invalid authorization and never plays or accepts commands", async () => {
  const fixture = setup({
    authorization: { binding, leaseUntil: Date.now() - 1 },
  });
  document.body.append(fixture.video);
  page.main();
  // The rejected handshake closes before any event can be emitted.
  await fixture.sendMessage.mock.results[0]!.value;
  await Promise.resolve();
  expect(fixture.play).not.toHaveBeenCalled();
  expect(fixture.control("resume").accepted).toBe(false);
  expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
});

it("accepts only background controls with the current complete binding", async () => {
  const fixture = setup();
  document.body.append(fixture.video);
  const playing = fixture.event("playing");
  page.main();
  await playing;
  expect(fixture.control("pause", { ...sender, id: "foreign" }).accepted).toBe(
    false,
  );
  expect(
    fixture.control("pause", { ...sender, tab: { id: 5 } as chrome.tabs.Tab })
      .accepted,
  ).toBe(false);
  expect(
    fixture.control("pause", { ...sender, url: "https://evil.invalid/" })
      .accepted,
  ).toBe(false);
  expect(
    fixture.control("pause", sender, {
      token: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    }).accepted,
  ).toBe(false);
  expect(
    fixture.control("pause", sender, {
      runId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    }).accepted,
  ).toBe(false);
  expect(fixture.control("pause", sender, { extra: true }).accepted).toBe(
    false,
  );
  expect(fixture.control("pause", sender, { version: 2 }).accepted).toBe(false);
  expect(fixture.control("start").accepted).toBe(false);
  expect(fixture.pause).not.toHaveBeenCalled();
  const paused = fixture.event("paused");
  const result = fixture.control("pause");
  await paused;
  expect(result.accepted).toBe(false);
  expect(result.respond).toHaveBeenCalledExactlyOnceWith({ ok: true });
  expect(fixture.pause).toHaveBeenCalledOnce();
  const resumed = fixture.event("playing");
  const resume = fixture.control("resume");
  expect(resume.accepted).toBe(true);
  await resumed;
  expect(await resume.done).toEqual({ ok: true });
  expect(fixture.play).toHaveBeenCalledTimes(2);
});

it("reports only trusted native ended, not forged ended or native pause before ended", async () => {
  const fixture = setup();
  document.body.append(fixture.video);
  const handlers = new Map<string, EventListener[]>();
  const add = fixture.video.addEventListener.bind(fixture.video);
  vi.spyOn(fixture.video, "addEventListener").mockImplementation(
    (name, handler, options) => {
      if (typeof handler === "function")
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      add(name, handler, options);
    },
  );
  const native = (name: string) => {
    for (const handler of handlers.get(name) ?? [])
      handler({ isTrusted: true } as Event);
  };
  const playing = fixture.event("playing");
  page.main();
  await playing;
  fixture.video.dispatchEvent(new Event("ended"));
  expect(
    fixture.sendMessage.mock.calls.some(([m]) => m.state === "ended"),
  ).toBe(false);
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  Object.defineProperty(fixture.video, "paused", {
    configurable: true,
    value: false,
  });
  Object.defineProperty(fixture.video, "duration", {
    configurable: true,
    value: 2,
  });
  native("playing");
  for (let time = 0.25; time <= 2; time += 0.25) {
    clock.mockReturnValue(time * 1000);
    fixture.video.currentTime = time;
    native("timeupdate");
  }
  Object.defineProperty(fixture.video, "paused", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(fixture.video, "ended", {
    configurable: true,
    value: true,
  });
  native("pause");
  expect(
    fixture.sendMessage.mock.calls.some(([m]) => m.state === "paused"),
  ).toBe(false);
  const ended = fixture.event("ended");
  native("ended");
  await ended;
  expect(
    fixture.sendMessage.mock.calls.filter(([m]) => m.state === "ended"),
  ).toHaveLength(1);
});

it("blocks hidden autoplay and hidden resume without invoking native play", async () => {
  const hidden = setup({ hidden: true });
  document.body.append(hidden.video);
  const blocked = hidden.event("blocked-autoplay");
  page.main();
  await blocked;
  expect(hidden.play).not.toHaveBeenCalled();
  expect(hidden.control("resume").accepted).toBe(false);
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();

  const fixture = setup();
  document.body.append(fixture.video);
  const playing = fixture.event("playing");
  page.main();
  await playing;
  const paused = fixture.event("paused");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
  await paused;
  const resume = fixture.control("resume");
  expect(resume.respond).toHaveBeenCalledWith({ ok: false });
  expect(fixture.play).toHaveBeenCalledOnce();
});

it("reports native autoplay denial after one muted retry without restarting", async () => {
  const fixture = setup();
  fixture.play.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
  document.body.append(fixture.video);
  const blocked = fixture.event("blocked-autoplay");
  page.main();
  await blocked;
  expect(fixture.play).toHaveBeenCalledTimes(2);
  expect(fixture.video.muted).toBe(true);
  const resume = fixture.control("resume");
  expect(resume.accepted).toBe(true);
  expect(await resume.done).toEqual({ ok: false });
  expect(fixture.play).toHaveBeenCalledTimes(2);
});

it("rejects controls after navigation or video removal and invalidates playback", async () => {
  const fixture = setup();
  document.body.append(fixture.video);
  const playing = fixture.event("playing");
  page.main();
  await playing;
  fixture.address.href = "https://kucom.korea.ac.kr/login";
  expect(fixture.control("resume").accepted).toBe(false);
  fixture.video.remove();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(fixture.control("pause").accepted).toBe(false);
  expect(fixture.play).toHaveBeenCalledOnce();
});

it("expires a lease, emits timeout and closes controls", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T00:00:00Z"));
  const fixture = setup();
  document.body.append(fixture.video);
  const playing = fixture.event("playing");
  page.main();
  await playing;
  const timeout = fixture.event("failed");
  await vi.advanceTimersByTimeAsync(45000);
  expect(await timeout).toMatchObject({ state: "failed" });
  expect(
    fixture.sendMessage.mock.calls.some(
      ([m]) => m.type === "PLAYBACK_PLAYER_LEASE",
    ),
  ).toBe(true);
  expect(fixture.control("resume").accepted).toBe(false);
  expect(fixture.pause).toHaveBeenCalled();
});

it("invalidates the video when background refuses lease renewal", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T00:00:00Z"));
  const fixture = setup({ lease: { ok: false } });
  document.body.append(fixture.video);
  const playing = fixture.event("playing");
  page.main();
  await playing;
  await vi.advanceTimersByTimeAsync(20000);
  expect(fixture.sendMessage).toHaveBeenCalledWith({
    version: 1,
    type: "PLAYBACK_PLAYER_LEASE",
    ...fixture.activeBinding,
  });
  expect(fixture.control("pause").accepted).toBe(false);
  expect(fixture.pause).toHaveBeenCalledOnce();
});

it("keeps a paused adapter dormant past heartbeat and expiry until a freshly authorized resume", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T00:00:00Z"));
  const fixture = setup();
  document.body.append(fixture.video);
  const playing = fixture.event("playing");
  page.main();
  await playing;

  const paused = fixture.event("paused");
  fixture.control("pause");
  await paused;
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(80000);

  expect(
    fixture.sendMessage.mock.calls.filter(
      ([message]) => message.type === "PLAYBACK_PLAYER_LEASE",
    ),
  ).toHaveLength(0);
  expect(fixture.pause).toHaveBeenCalledOnce();
  const resumed = fixture.event("playing");
  const resume = fixture.control("resume", sender, {
    deadline: Date.now() + 70000,
    leaseUntil: Date.now() + 60000,
  });
  await resumed;
  expect(await resume.done).toEqual({ ok: true });
  expect(fixture.play).toHaveBeenCalledTimes(2);
  expect(fixture.video.playbackRate).toBe(1);
});

it("ignores a stale in-flight lease refusal after pause and rejects stale resume authorization", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T00:00:00Z"));
  const renewal = Promise.withResolvers<unknown>();
  const fixture = setup({ lease: renewal.promise });
  document.body.append(fixture.video);
  const playing = fixture.event("playing");
  page.main();
  await playing;
  await vi.advanceTimersByTimeAsync(20000);

  const paused = fixture.event("paused");
  fixture.control("pause");
  await paused;
  renewal.resolve({ ok: false });
  await Promise.resolve();
  await Promise.resolve();

  const stale = fixture.control("resume", sender, {
    deadline: Date.now() - 1,
    leaseUntil: Date.now() - 1,
  });
  expect(stale.accepted).toBe(false);
  expect(stale.respond).toHaveBeenCalledWith({ ok: false });
  expect(fixture.play).toHaveBeenCalledOnce();

  const resumed = fixture.event("playing");
  const fresh = fixture.control("resume", sender, {
    deadline: Date.now() + 70000,
    leaseUntil: Date.now() + 60000,
  });
  await resumed;
  expect(await fresh.done).toEqual({ ok: true });
  expect(fixture.play).toHaveBeenCalledTimes(2);
});
