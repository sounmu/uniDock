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
  reason?: "media" | "timeout" | "play" | "rate";
};

export interface PlaybackOptions {
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

  private valid(): boolean {
    return (
      this.video.isConnected &&
      this.video.ownerDocument === this.document &&
      this.document.defaultView?.document === this.document &&
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

  /** Reads native metadata only; never invokes play(), load(), or seek. */
  readDuration(): Promise<number | null> {
    if (
      this.status.state === "stopped" ||
      !this.valid() ||
      this.options.isLoginPage?.()
    )
      return Promise.resolve(null);
    const duration = () =>
      this.video.readyState >= HTMLMediaElement.HAVE_METADATA &&
      Number.isFinite(this.video.duration) &&
      this.video.duration > 0
        ? this.video.duration
        : null;
    const known = duration();
    if (known !== null || this.video.error) return Promise.resolve(known);
    const generation = this.generation;
    return new Promise((resolve) => {
      const finish = (value: number | null) => {
        clearTimeout(timer);
        this.video.removeEventListener("loadedmetadata", loaded);
        this.video.removeEventListener("error", error);
        this.cancelPending.delete(cancel);
        resolve(value);
      };
      const loaded = (event: Event) => {
        if (event.isTrusted && generation === this.generation && this.valid())
          finish(duration());
      };
      const error = (event: Event) => {
        if (event.isTrusted && generation === this.generation) finish(null);
      };
      const cancel = () => finish(null);
      this.video.addEventListener("loadedmetadata", loaded);
      this.video.addEventListener("error", error);
      this.cancelPending.add(cancel);
      const timer = setTimeout(cancel, this.timeoutMs);
    });
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
    const ended = (event: Event) => {
      if (event.isTrusted && current() && this.video.ended) {
        this.detachEvents?.();
        this.detachEvents = undefined;
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
    this.video.addEventListener("error", error);
    this.video.addEventListener("pause", paused);
    this.video.addEventListener("ratechange", rateChanged);
    this.detachEvents = () => {
      this.video.removeEventListener("ended", ended);
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
        Promise.resolve(this.video.play()).then(
          () => {
            if (generation === this.generation && !this.valid()) this.stop();
            if (!current()) return;
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
    if (this.valid() && shouldPause) this.video.pause();
    return this.status;
  }

  /** Called on frame/document navigation or loss of the caller's authorization. */
  invalidate(): PlaybackStatus {
    return this.stop();
  }
}
