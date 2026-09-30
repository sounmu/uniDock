import { defineContentScript } from "wxt/utils/define-content-script";
import { PlaybackPlayer, type PlaybackStatus } from "../src/playback/player";
import { initializeKuLecture } from "../src/playback/ku-player";
import {
  backgroundSender,
  isPlayerBinding,
  isPlayerControl,
  object,
  playerPage,
  type PlayerBinding,
} from "../src/playback/bridge";
import { LMS_MATCHES } from "../src/security/policy";
import { playbackDiagnostic as diagnostic } from "../src/security/logger";

/** Runs only in the original native-video document, never injects MAIN-world player calls. */
export default defineContentScript({
  matches: [...LMS_MATCHES, "https://kucom.korea.ac.kr/em/*"],
  allFrames: true,
  runAt: "document_idle",
  main() {
    if (!playerPage(location.href)) return;
    diagnostic("FRAME_READY");
    diagnostic(
      location.origin === "https://kucom.korea.ac.kr"
        ? "KU_FRAME_READY"
        : "LMS_FRAME_READY",
    );
    let waitingCode = "";
    const originalUrl = location.href;
    const kuPlayer =
      new URL(originalUrl).origin === "https://kucom.korea.ac.kr";
    let player: PlaybackPlayer | null = null;
    let binding: PlayerBinding | null = null;
    let video: HTMLVideoElement | null = null;
    let closed = false,
      connecting = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let authorizationGeneration = 0;
    let dormant = false;
    let discoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let initialization: AbortController | null = null;
    const discoveryUntil = Date.now() + 45000;
    type VideoIdentity = {
      video: HTMLVideoElement;
      currentSrc: string;
      src: string;
      srcObject: HTMLVideoElement["srcObject"];
    };
    const candidateSelection = () => {
      const videos = document.querySelectorAll("video");
      // KU includes auxiliary players which may load and finish before the
      // lecture. Never fall back to those while the primary player is loading.
      const eligible = kuPlayer
        ? Array.from(videos).filter((candidate) =>
            candidate.matches(".vc-vplay-container > video.vc-vplay-video1"),
          )
        : Array.from(videos);
      const candidates = eligible.filter((candidate) => {
        if (!kuPlayer && videos.length === 1) return true;
        // KU keeps empty helper videos and may size the native element only
        // after play(). Select by media readiness rather than CSS geometry.
        return (
          Boolean(
            candidate.currentSrc || candidate.src || candidate.srcObject,
          ) && candidate.readyState >= HTMLMediaElement.HAVE_METADATA
        );
      });
      return { videos, eligible, candidates };
    };
    const selectCandidate = (): HTMLVideoElement | null => {
      const { candidates } = candidateSelection();
      return candidates.length === 1 ? candidates[0]! : null;
    };
    const identity = (selected: HTMLVideoElement): VideoIdentity => ({
      video: selected,
      currentSrc: selected.currentSrc,
      src: selected.src,
      srcObject: selected.srcObject,
    });
    const stillSelected = (selected: VideoIdentity): boolean => {
      const currentCandidate = selectCandidate();
      const resolvedSourceUnchanged = selected.currentSrc
        ? currentCandidate?.currentSrc === selected.currentSrc
        : !currentCandidate?.currentSrc ||
          (Boolean(selected.src) &&
            currentCandidate.currentSrc === selected.src);
      return (
        currentCandidate === selected.video &&
        resolvedSourceUnchanged &&
        currentCandidate.src === selected.src &&
        currentCandidate.srcObject === selected.srcObject
      );
    };
    const current = () =>
      !closed &&
      location.href === originalUrl &&
      !!video?.isConnected &&
      video.ownerDocument === document;
    function stop() {
      if (closed) return;
      closed = true;
      authorizationGeneration++;
      clearTimeout(expiry);
      clearTimeout(heartbeat);
      clearTimeout(discoveryTimer);
      initialization?.abort();
      initialization = null;
      observer.disconnect();
      document.removeEventListener("loadedmetadata", connect, true);
      window.removeEventListener("resize", connect);
      video?.removeEventListener("ratechange", normalSpeed);
      document.removeEventListener("visibilitychange", visibleOnly);
      player?.invalidate();
    }
    function suspendAuthorization() {
      dormant = true;
      authorizationGeneration++;
      clearTimeout(expiry);
      clearTimeout(heartbeat);
      expiry = undefined;
      heartbeat = undefined;
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
      if (document.visibilityState !== "hidden") return;
      if (!player) {
        if (connecting) void signal({ state: "failed", reason: "play" });
        stop();
        return;
      }
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
      dormant = false;
      const generation = ++authorizationGeneration;
      clearTimeout(expiry);
      expiry = setTimeout(
        () => {
          if (generation !== authorizationGeneration || dormant || closed)
            return;
          if (player?.status.state === "paused") {
            suspendAuthorization();
            return;
          }
          void signal({ state: "failed", reason: "timeout" });
          stop();
        },
        Math.max(0, Math.min(value.leaseUntil, binding.deadline) - Date.now()),
      );
      clearTimeout(heartbeat);
      heartbeat = setTimeout(() => {
        void renew(generation);
      }, 20000);
      return true;
    }
    async function renew(generation: number) {
      if (
        generation !== authorizationGeneration ||
        dormant ||
        !binding ||
        !current()
      ) {
        if (generation === authorizationGeneration && !dormant) stop();
        return;
      }
      const requested = binding;
      try {
        const result: unknown = await chrome.runtime.sendMessage({
          version: 1,
          type: "PLAYBACK_PLAYER_LEASE",
          ...requested,
        });
        // A pause invalidates the old renewal operation. Neither a late grant
        // nor a refusal may close or re-arm the dormant adapter.
        if (
          generation !== authorizationGeneration ||
          dormant ||
          player?.status.state === "paused"
        )
          return;
        if (
          !current() ||
          !object(result) ||
          result.ok !== true ||
          !authorize(result.authorization)
        )
          stop();
      } catch {
        if (generation === authorizationGeneration && !dormant) stop();
      }
    }
    function authorizeControl(message: {
      runId: string;
      token: string;
      deadline: number;
      leaseUntil: number;
    }): boolean {
      return authorize({
        binding: {
          runId: message.runId,
          token: message.token,
          deadline: message.deadline,
        },
        leaseUntil: message.leaseUntil,
      });
    }
    async function connect() {
      if (closed || connecting || player) return;
      const { videos, eligible, candidates } = candidateSelection();
      if (candidates.length !== 1) {
        const code = candidates.length
          ? "WAIT_AMBIGUOUS_VIDEO"
          : kuPlayer && !eligible.length
            ? "WAIT_KU_PRIMARY_VIDEO"
            : !videos.length
              ? "WAIT_NO_VIDEO_ELEMENT"
              : Array.from(videos).some((v) =>
                    Boolean(v.currentSrc || v.src || v.srcObject),
                  )
                ? "WAIT_VIDEO_METADATA"
                : "WAIT_VIDEO_SOURCE";
        if (waitingCode !== code) diagnostic(code);
        waitingCode = code;
        return;
      }
      const found = candidates[0];
      if (!(found instanceof HTMLVideoElement)) return;
      const selected = identity(found);
      connecting = true;
      video = found;
      clearTimeout(discoveryTimer);
      diagnostic("VIDEO_SELECTED");
      if (kuPlayer) diagnostic("KU_PRIMARY_SELECTED");
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
          diagnostic("AUTHORIZATION_REJECTED");
          stop();
          return;
        }
        // The authorization applies only to the exact, uniquely selected
        // media observed before HELLO. DOM/media changes while HELLO is in
        // flight must not transfer that grant to an obsolete candidate.
        if (!stillSelected(selected)) {
          diagnostic("VIDEO_SELECTION_CHANGED");
          void signal({ state: "failed", reason: "play" });
          stop();
          return;
        }
        if (kuPlayer) {
          if (document.visibilityState === "hidden") {
            diagnostic("DOCUMENT_HIDDEN");
            void signal({ state: "blocked-autoplay" });
            stop();
            return;
          }
          diagnostic("KU_INITIALIZING");
          initialization = new AbortController();
          const ready = await initializeKuLecture(
            found,
            () =>
              !closed &&
              location.href === originalUrl &&
              document.visibilityState !== "hidden" &&
              !!binding &&
              binding.deadline > Date.now(),
            initialization.signal,
          );
          video = ready.video;
          diagnostic("KU_LECTURE_READY");
          if (!current() || selectCandidate() !== ready.video) {
            diagnostic("VIDEO_SELECTION_CHANGED");
            void signal({ state: "failed", reason: "play" });
            stop();
            return;
          }
          player = new PlaybackPlayer(video, {
            onDiagnostic: diagnostic,
            isLoginPage: () => !playerPage(location.href),
            isVisible: () => document.visibilityState !== "hidden",
            onStateChange: (status) => {
              diagnostic(
                `STATE_${status.state}${status.reason ? `_${status.reason}` : ""}`,
              );
              if (status.state === "paused") suspendAuthorization();
              void signal(status);
            },
          });
          if (!ready.handoff()) {
            stop();
            return;
          }
          initialization = null;
        }
        if (!current()) {
          stop();
          return;
        }
        player ??= new PlaybackPlayer(video!, {
          onDiagnostic: diagnostic,
          isLoginPage: () => !playerPage(location.href),
          isVisible: () => document.visibilityState !== "hidden",
          onStateChange: (status) => {
            diagnostic(
              `STATE_${status.state}${status.reason ? `_${status.reason}` : ""}`,
            );
            if (status.state === "paused") suspendAuthorization();
            void signal(status);
          },
        });
        video!.addEventListener("ratechange", normalSpeed);
        normalSpeed();
        if (document.visibilityState === "hidden") {
          diagnostic("DOCUMENT_HIDDEN");
          void signal({ state: "blocked-autoplay" });
          stop();
          return;
        }
        await player.start();
        visibleOnly();
      } catch {
        diagnostic("KU_INITIALIZATION_FAILED");
        void signal({ state: "failed", reason: "play" });
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
      attributes: true,
      attributeFilter: ["src", "style", "class", "hidden"],
    });
    document.addEventListener("loadedmetadata", connect, true);
    // Media properties and stylesheet-driven layout can change without DOM mutations.
    // This bounded local probe performs no network requests or playback attempts.
    function probe() {
      if (closed || player || connecting) return;
      if (Date.now() >= discoveryUntil) {
        diagnostic("VIDEO_DISCOVERY_TIMEOUT");
        return;
      }
      void connect();
      if (!closed && !player && !connecting)
        discoveryTimer = setTimeout(probe, 500);
    }
    discoveryTimer = setTimeout(probe, 500);
    window.addEventListener("resize", connect);
    window.addEventListener("pagehide", stop, { once: true });
    document.addEventListener("visibilitychange", visibleOnly);
    chrome.runtime.onMessage.addListener(
      (message: unknown, sender, respond) => {
        if (
          !backgroundSender(sender) ||
          !object(message) ||
          !isPlayerControl(message) ||
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
            if (!authorizeControl(message)) {
              respond({ ok: false });
              return false;
            }
            normalSpeed();
            void player.resume().then(
              (status) => {
                if (status.state !== "playing") {
                  if (status.state === "paused") suspendAuthorization();
                  else stop();
                }
                respond({ ok: status.state === "playing" });
              },
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
