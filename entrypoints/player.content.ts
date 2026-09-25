import { defineContentScript } from "wxt/utils/define-content-script";
import { PlaybackPlayer, type PlaybackStatus } from "../src/playback/player";
import {
  backgroundSender,
  isPlayerBinding,
  object,
  playerPage,
  type PlayerBinding,
} from "../src/playback/bridge";
import { LMS_MATCHES } from "../src/security/policy";

/** Runs only in the original native-video document, never injects MAIN-world player calls. */
export default defineContentScript({
  matches: [...LMS_MATCHES, "https://kucom.korea.ac.kr/em/*"],
  allFrames: true,
  runAt: "document_idle",
  main() {
    if (!playerPage(location.href)) return;
    const originalUrl = location.href;
    let player: PlaybackPlayer | null = null;
    let binding: PlayerBinding | null = null;
    let video: HTMLVideoElement | null = null;
    let closed = false,
      connecting = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    const current = () =>
      !closed &&
      location.href === originalUrl &&
      !!video?.isConnected &&
      video.ownerDocument === document;
    function stop() {
      if (closed) return;
      closed = true;
      clearTimeout(expiry);
      clearTimeout(heartbeat);
      observer.disconnect();
      video?.removeEventListener("ratechange", normalSpeed);
      document.removeEventListener("visibilitychange", visibleOnly);
      player?.invalidate();
    }
    function normalSpeed() {
      if (!current()) {
        stop();
        return;
      }
      if (video && video.playbackRate !== 1) video.playbackRate = 1;
      if (video && video.defaultPlaybackRate !== 1)
        video.defaultPlaybackRate = 1;
    }
    function visibleOnly() {
      if (document.visibilityState !== "hidden" || !player) return;
      if (player.status.state === "starting") {
        void signal({ state: "failed", reason: "play" });
        stop();
      } else player.pause();
    }
    async function signal(status: PlaybackStatus) {
      if (
        !binding ||
        closed ||
        status.state === "idle" ||
        status.state === "stopped"
      )
        return;
      try {
        const response: unknown = await chrome.runtime.sendMessage({
          version: 1,
          type: "PLAYBACK_PLAYER_EVENT",
          ...binding,
          state: status.state,
        });
        if (!object(response) || response.ok !== true) stop();
      } catch {
        stop();
      }
    }
    function authorize(value: unknown): boolean {
      if (
        !object(value) ||
        !isPlayerBinding(value.binding) ||
        typeof value.leaseUntil !== "number" ||
        !Number.isFinite(value.leaseUntil) ||
        value.leaseUntil <= Date.now() ||
        value.leaseUntil > Date.now() + 71000 ||
        value.binding.deadline <= Date.now()
      )
        return false;
      if (
        binding &&
        (value.binding.runId !== binding.runId ||
          value.binding.token !== binding.token)
      )
        return false;
      binding = value.binding;
      clearTimeout(expiry);
      expiry = setTimeout(
        () => {
          void signal({ state: "failed", reason: "timeout" });
          stop();
        },
        Math.max(0, Math.min(value.leaseUntil, binding.deadline) - Date.now()),
      );
      clearTimeout(heartbeat);
      heartbeat = setTimeout(() => {
        void renew();
      }, 20000);
      return true;
    }
    async function renew() {
      if (!binding || !current()) {
        stop();
        return;
      }
      try {
        const result: unknown = await chrome.runtime.sendMessage({
          version: 1,
          type: "PLAYBACK_PLAYER_LEASE",
          ...binding,
        });
        if (
          !current() ||
          !object(result) ||
          result.ok !== true ||
          !authorize(result.authorization)
        )
          stop();
      } catch {
        stop();
      }
    }
    async function connect() {
      if (closed || connecting || player) return;
      const videos = document.querySelectorAll("video");
      if (videos.length !== 1) return;
      const found = videos.item(0);
      if (!(found instanceof HTMLVideoElement)) return;
      connecting = true;
      video = found;
      try {
        const result: unknown = await chrome.runtime.sendMessage({
          version: 1,
          type: "PLAYBACK_PLAYER_HELLO",
        });
        if (
          !current() ||
          !object(result) ||
          result.ok !== true ||
          !authorize(result.authorization)
        ) {
          stop();
          return;
        }
        player = new PlaybackPlayer(found, {
          isLoginPage: () => !playerPage(location.href),
          onStateChange: (status) => {
            void signal(status);
          },
        });
        found.addEventListener("ratechange", normalSpeed);
        normalSpeed();
        if (document.visibilityState === "hidden") {
          void signal({ state: "blocked-autoplay" });
          stop();
          return;
        }
        await player.start();
        visibleOnly();
      } catch {
        stop();
      } finally {
        connecting = false;
      }
    }
    const observer = new MutationObserver(() => {
      if (player && !current()) stop();
      else void connect();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    window.addEventListener("pagehide", stop, { once: true });
    document.addEventListener("visibilitychange", visibleOnly);
    chrome.runtime.onMessage.addListener(
      (message: unknown, sender, respond) => {
        if (
          !backgroundSender(sender) ||
          !object(message) ||
          Object.keys(message).length !== 6 ||
          message.version !== 1 ||
          message.type !== "PLAYBACK_PLAYER_CONTROL" ||
          !isPlayerBinding(message) ||
          !binding ||
          message.runId !== binding.runId ||
          message.token !== binding.token ||
          !player ||
          !current()
        )
          return false;
        switch (message.action) {
          case "pause":
            // The adapter only pauses a playing video. A start still pending must be terminally cancelled.
            if (player.status.state === "starting") {
              stop();
              respond({ ok: false });
            } else {
              player.pause();
              respond({ ok: true });
            }
            return false;
          case "resume":
            if (document.visibilityState === "hidden") {
              respond({ ok: false });
              return false;
            }
            normalSpeed();
            void player.resume().then(
              (status) => respond({ ok: status.state === "playing" }),
              () => {
                stop();
                respond({ ok: false });
              },
            );
            return true;
          case "stop":
            stop();
            respond({ ok: true });
            return false;
          default:
            return false;
        }
      },
    );
    void connect();
  },
});
