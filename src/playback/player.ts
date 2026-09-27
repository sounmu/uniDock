export type PlaybackState =
  | "idle"
  | "starting"
  | "playing"
  | "paused"
  | "ended"
  | "blocked-login"
  | "blocked-autoplay"
  | "failed"
  | "stopped";

export type PlaybackStatus = {
  state: PlaybackState;
  reason?: "media" | "timeout" | "play" | "rate" | "unverified-end";
};

export interface PlaybackOptions {
  onDiagnostic?: (
    code:
      | "PLAY_REQUEST"
      | "AUTOPLAY_DENIED"
      | "MUTED_RETRY"
      | "PLAY_ACCEPTED"
      | "PLAY_REJECTED"
      | "NATIVE_PLAYING"
      | "MEDIA_PROGRESS"
      | "END_UNVERIFIED",
  ) => void;
  /** The caller identifies login pages; a video element cannot identify an SSO redirect. */
  isLoginPage?: () => boolean;
  onStateChange?: (status: PlaybackStatus) => void;
  /** Bounds metadata and play() waits. Clamped to 1..30000 ms. */
  timeoutMs?: number;
}

/** Controls only a supplied native video in its original document. No LMS credit is inferred. */
export class PlaybackPlayer {
  private readonly document: Document;
  private readonly url: string;
  private readonly timeoutMs: number;
  private generation = 0;
  private statusValue: PlaybackStatus = { state: "idle" };
  private cancelPending = new Set<() => void>();
  private detachEvents?: () => void;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly options: PlaybackOptions = {},
  ) {
    this.document = video.ownerDocument;
    this.url = this.document.location.href;
    this.timeoutMs = Math.min(30000, Math.max(1, options.timeoutMs ?? 15000));
  }

  get status(): PlaybackStatus {
    return this.statusValue;
  }

  private ownsVideo(): boolean {
    return (
      this.video.ownerDocument === this.document &&
      this.document.defaultView?.document === this.document
    );
  }

  private valid(): boolean {
    return (
      this.video.isConnected &&
      this.ownsVideo() &&
      this.document.location.href === this.url
    );
  }

  private set(status: PlaybackStatus): PlaybackStatus {
    this.statusValue = status;
    this.options.onStateChange?.(status);
    return status;
  }

  private cancel(): void {
    this.generation++;
    this.detachEvents?.();
    this.detachEvents = undefined;
    for (const cancel of [...this.cancelPending]) cancel();
  }

  /** Starts once from the current native position, at normal speed. */
  start(): Promise<PlaybackStatus> {
    if (this.status.state !== "idle") return Promise.resolve(this.status);
    return this.play();
  }

  resume(): Promise<PlaybackStatus> {
    if (this.status.state !== "paused") return Promise.resolve(this.status);
    return this.play();
  }

  private play(): Promise<PlaybackStatus> {
    if (!this.valid()) return Promise.resolve(this.stop());
    if (this.options.isLoginPage?.())
      return Promise.resolve(this.set({ state: "blocked-login" }));
    this.cancel();
    const generation = this.generation;
    const current = () => generation === this.generation && this.valid();
    let settle: ((status: PlaybackStatus) => void) | undefined;
    let observedPlaying = false;
    let progressSeconds = 0;
    let lastTime = 0;
    let lastWall = 0;
    let source = "";
    let sourceObject: HTMLVideoElement["srcObject"] = null;
    const resetEvidence = () => {
      observedPlaying = false;
      progressSeconds = 0;
    };
    const nativePlaying = (event: Event) => {
      if (
        !event.isTrusted ||
        !current() ||
        this.video.paused ||
        this.video.seeking
      )
        return;
      observedPlaying = true;
      lastTime = this.video.currentTime;
      lastWall = performance.now();
      source = this.video.currentSrc;
      sourceObject = this.video.srcObject;
      this.options.onDiagnostic?.("NATIVE_PLAYING");
    };
    // The KU start control can begin playback before this adapter is attached.
    // Seed only the baseline; completion still requires measured time progress.
    if (
      !this.video.paused &&
      !this.video.ended &&
      !this.video.seeking &&
      this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      observedPlaying = true;
      lastTime = this.video.currentTime;
      lastWall = performance.now();
      source = this.video.currentSrc;
      sourceObject = this.video.srcObject;
    }
    const progress = (event: Event) => {
      if (
        !event.isTrusted ||
        !current() ||
        !observedPlaying ||
        this.video.seeking
      )
        return;
      const time = this.video.currentTime;
      const now = performance.now();
      const delta = time - lastTime;
      const wall = (now - lastWall) / 1000;
      if (
        source !== this.video.currentSrc ||
        sourceObject !== this.video.srcObject ||
        delta < 0 ||
        delta > wall + 0.5
      ) {
        resetEvidence();
        return;
      }
      const before = progressSeconds;
      progressSeconds += Math.max(0, Math.min(delta, wall));
      lastTime = time;
      lastWall = now;
      if (before < 1 && progressSeconds >= 1)
        this.options.onDiagnostic?.("MEDIA_PROGRESS");
    };
    const reset = (event: Event) => {
      if (event.isTrusted && current()) resetEvidence();
    };
    const ended = (event: Event) => {
      if (event.isTrusted && current() && this.video.ended) {
        this.detachEvents?.();
        this.detachEvents = undefined;
        const duration = this.video.duration;
        if (
          !observedPlaying ||
          progressSeconds < 1 ||
          this.video.seeking ||
          source !== this.video.currentSrc ||
          sourceObject !== this.video.srcObject ||
          !Number.isFinite(duration) ||
          duration <= 0 ||
          Math.abs(duration - this.video.currentTime) > 0.5 ||
          Math.abs(this.video.currentTime - lastTime) > 0.5
        ) {
          this.options.onDiagnostic?.("END_UNVERIFIED");
          settle?.(this.set({ state: "paused", reason: "unverified-end" }));
          return;
        }
        settle?.(this.set({ state: "ended" }));
      }
    };
    const error = (event: Event) => {
      if (event.isTrusted && current() && this.video.error) {
        this.detachEvents?.();
        this.detachEvents = undefined;
        settle?.(this.set({ state: "failed", reason: "media" }));
      }
    };
    const paused = (event: Event) => {
      if (
        event.isTrusted &&
        current() &&
        this.video.paused &&
        !this.video.ended &&
        this.status.state === "playing"
      )
        this.set({ state: "paused" });
    };
    const rateChanged = (event: Event) => {
      if (event.isTrusted && current() && this.video.playbackRate !== 1) {
        this.video.pause();
        this.detachEvents?.();
        this.detachEvents = undefined;
        settle?.(this.set({ state: "failed", reason: "rate" }));
      }
    };
    this.video.addEventListener("ended", ended);
    this.video.addEventListener("playing", nativePlaying);
    this.video.addEventListener("timeupdate", progress);
    this.video.addEventListener("seeking", reset);
    this.video.addEventListener("emptied", reset);
    this.video.addEventListener("loadstart", reset);
    this.video.addEventListener("error", error);
    this.video.addEventListener("pause", paused);
    this.video.addEventListener("ratechange", rateChanged);
    this.detachEvents = () => {
      this.video.removeEventListener("ended", ended);
      this.video.removeEventListener("playing", nativePlaying);
      this.video.removeEventListener("timeupdate", progress);
      this.video.removeEventListener("seeking", reset);
      this.video.removeEventListener("emptied", reset);
      this.video.removeEventListener("loadstart", reset);
      this.video.removeEventListener("error", error);
      this.video.removeEventListener("pause", paused);
      this.video.removeEventListener("ratechange", rateChanged);
    };
    this.video.playbackRate = 1;
    this.set({ state: "starting" });
    return new Promise((resolve) => {
      const finish = (status: PlaybackStatus) => {
        clearTimeout(timer);
        this.cancelPending.delete(cancel);
        resolve(status);
      };
      settle = finish;
      const cancel = () => finish(this.status);
      this.cancelPending.add(cancel);
      const timer = setTimeout(() => {
        if (generation === this.generation && !this.valid()) this.stop();
        if (current() && this.status.state === "starting") {
          this.video.pause();
          this.detachEvents?.();
          this.detachEvents = undefined;
          finish(this.set({ state: "failed", reason: "timeout" }));
        }
      }, this.timeoutMs);
      try {
        const requestPlay = async () => {
          this.options.onDiagnostic?.("PLAY_REQUEST");
          try {
            await this.video.play();
          } catch (cause) {
            if (
              !(cause instanceof DOMException) ||
              cause.name !== "NotAllowedError"
            )
              throw cause;
            this.options.onDiagnostic?.("AUTOPLAY_DENIED");
            if (
              !current() ||
              this.status.state !== "starting" ||
              this.video.muted
            )
              throw cause;
            this.video.muted = true;
            this.options.onDiagnostic?.("MUTED_RETRY");
            await this.video.play();
          }
        };
        requestPlay().then(
          () => {
            if (generation !== this.generation) {
              if (this.status.state === "stopped" && this.ownsVideo())
                this.video.pause();
              return;
            }
            if (generation === this.generation && !this.valid()) this.stop();
            if (!current()) return;
            this.options.onDiagnostic?.("PLAY_ACCEPTED");
            if (this.status.state === "failed") {
              this.video.pause();
              return;
            }
            if (this.status.state === "starting")
              finish(this.set({ state: "playing" }));
            else finish(this.status);
          },
          (cause: unknown) => {
            if (generation === this.generation && !this.valid()) this.stop();
            if (!current()) return;
            this.options.onDiagnostic?.("PLAY_REJECTED");
            this.detachEvents?.();
            this.detachEvents = undefined;
            const blocked =
              cause instanceof DOMException && cause.name === "NotAllowedError";
            finish(
              this.set({
                state: blocked ? "blocked-autoplay" : "failed",
                ...(!blocked && { reason: "play" as const }),
              }),
            );
          },
        );
      } catch {
        if (generation === this.generation && !this.valid()) this.stop();
        if (current()) {
          this.detachEvents?.();
          this.detachEvents = undefined;
          finish(this.set({ state: "failed", reason: "play" }));
        }
      }
    });
  }

  pause(): PlaybackStatus {
    if (this.status.state === "playing" && this.valid()) {
      this.video.pause();
      return this.set({ state: "paused" });
    }
    return this.status;
  }

  /** Terminal for this instance: never restarts or rewinds the video. */
  stop(): PlaybackStatus {
    if (this.status.state === "stopped") return this.status;
    const shouldPause = ["starting", "playing", "paused"].includes(
      this.status.state,
    );
    this.set({ state: "stopped" });
    this.cancel();
    if (this.ownsVideo() && shouldPause) this.video.pause();
    return this.status;
  }

  /** Called on frame/document navigation or loss of the caller's authorization. */
  invalidate(): PlaybackStatus {
    return this.stop();
  }
}
