export interface KuLectureReady {
  video: HTMLVideoElement;
  /** Transfer the selected video after the caller has installed its adapter. */
  handoff(): boolean;
}

/** Initialize KU through its own start control before observing the native lecture.
 * The caller must already hold a current playback authorization. No LMS APIs,
 * page-owned player methods, URLs or credentials are read or invoked here.
 */
export function initializeKuLecture(
  initial: HTMLVideoElement,
  authorized: () => boolean,
  signal?: AbortSignal,
): Promise<KuLectureReady> {
  const document = initial.ownerDocument;
  const container = initial.parentElement;
  const button = document.querySelector<HTMLElement>(
    ".vc-front-screen-play-btn",
  );
  const isAuthorized = () => {
    try {
      return authorized();
    } catch {
      return false;
    }
  };
  const isHidden = () => document.visibilityState === "hidden";
  const isUniqueCurrentPrimary = (video: HTMLVideoElement) => {
    const candidates = Array.from(
      document.querySelectorAll<HTMLVideoElement>(
        ".vc-vplay-container > video.vc-vplay-video1",
      ),
    ).filter(
      (candidate) =>
        Boolean(candidate.currentSrc || candidate.src || candidate.srcObject) &&
        candidate.readyState >= HTMLMediaElement.HAVE_METADATA,
    );
    return candidates.length === 1 && candidates[0] === video;
  };
  if (signal?.aborted || isHidden() || !isAuthorized())
    return Promise.reject(new Error("PLAYER_LOST"));
  if (
    !button ||
    button.getBoundingClientRect().width <= 0 ||
    getComputedStyle(button).visibility === "hidden" ||
    getComputedStyle(button).display === "none"
  )
    return Promise.resolve({
      video: initial,
      handoff: () => {
        const valid =
          !signal?.aborted &&
          !isHidden() &&
          isAuthorized() &&
          isUniqueCurrentPrimary(initial);
        if (!valid) initial.pause();
        return valid;
      },
    });

  const source = initial.currentSrc;
  const stream = initial.srcObject;
  return new Promise((resolve, reject) => {
    let state: "active" | "cancelled" | "ready" | "handed-off" = "active";
    let selected: HTMLVideoElement | null = null;
    const owned = new Set<HTMLVideoElement>();
    const deadline = performance.now() + 15000;
    const normalize = (video: HTMLVideoElement) => {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      if (video.defaultPlaybackRate !== 1) video.defaultPlaybackRate = 1;
    };
    const pause = (video: HTMLVideoElement) => {
      normalize(video);
      video.pause();
    };
    const track = (video: HTMLVideoElement) => {
      if (owned.has(video)) return;
      owned.add(video);
      video.addEventListener("play", guardPlay);
      video.addEventListener("ratechange", guardRate);
    };
    const release = (video: HTMLVideoElement) => {
      video.removeEventListener("play", guardPlay);
      video.removeEventListener("ratechange", guardRate);
      owned.delete(video);
    };
    const trackPrimaries = () => {
      if (!container) return;
      for (const video of container.querySelectorAll<HTMLVideoElement>(
        ":scope > video.vc-vplay-video1",
      ))
        track(video);
    };
    const cleanupReadiness = () => {
      clearInterval(timer);
      document.removeEventListener("loadedmetadata", check, true);
    };
    const cleanupAllGuards = () => {
      observer.disconnect();
      for (const video of [...owned]) release(video);
      document.removeEventListener("visibilitychange", guardVisibility);
      signal?.removeEventListener("abort", cancel);
    };
    function cancel() {
      if (state === "cancelled" || state === "handed-off") return;
      const shouldReject = state === "active";
      state = "cancelled";
      cleanupReadiness();
      for (const video of owned) pause(video);
      if (shouldReject) reject(new Error("PLAYER_LOST"));
      // Keep tracking exact KU primaries and guarding every owned element for
      // this document: the click handler may replace or replay media later.
    }
    function guardPlay(event: Event) {
      const video = event.currentTarget;
      if (!(video instanceof HTMLVideoElement)) return;
      if (!owned.has(video)) return;
      if (signal?.aborted || !isAuthorized() || isHidden()) {
        cancel();
        pause(video);
      } else if (
        state === "active" ||
        (state === "ready" && video === selected)
      )
        normalize(video);
      else pause(video);
    }
    function guardRate(event: Event) {
      const video = event.currentTarget;
      if (video instanceof HTMLVideoElement && owned.has(video))
        normalize(video);
    }
    function guardVisibility() {
      if (isHidden()) cancel();
    }
    const observer = new MutationObserver(() => {
      trackPrimaries();
      for (const video of owned) {
        if (state === "cancelled" || state === "handed-off") pause(video);
        else normalize(video);
      }
    });
    observer.observe(container ?? document.documentElement, {
      childList: true,
      subtree: true,
    });
    document.addEventListener("visibilitychange", guardVisibility);
    track(initial);
    function handoff(): boolean {
      trackPrimaries();
      if (
        state !== "ready" ||
        !selected ||
        signal?.aborted ||
        isHidden() ||
        !isAuthorized() ||
        !isUniqueCurrentPrimary(selected)
      ) {
        cancel();
        return false;
      }
      state = "handed-off";
      cleanupReadiness();
      observer.disconnect();
      document.removeEventListener("visibilitychange", guardVisibility);
      signal?.removeEventListener("abort", cancel);
      release(selected);
      for (const video of owned) pause(video);
      if (!owned.size) cleanupAllGuards();
      return true;
    }
    function check() {
      if (state !== "active") return;
      if (
        signal?.aborted ||
        isHidden() ||
        !isAuthorized() ||
        performance.now() >= deadline
      ) {
        cancel();
        return;
      }
      trackPrimaries();
      const videos = container?.querySelectorAll<HTMLVideoElement>(
        ":scope > video.vc-vplay-video1",
      );
      if (!videos) return;
      if (videos.length !== 1) return;
      const video = videos[0]!;
      if (
        video.readyState < HTMLMediaElement.HAVE_METADATA ||
        !(video.currentSrc || video.srcObject) ||
        (video === initial &&
          video.currentSrc === source &&
          video.srcObject === stream)
      )
        return;
      if (signal?.aborted || isHidden() || !isAuthorized()) {
        cancel();
        return;
      }
      selected = video;
      state = "ready";
      cleanupReadiness();
      normalize(video);
      resolve({ video, handoff });
    }
    const timer = setInterval(check, 100);
    document.addEventListener("loadedmetadata", check, true);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      normalize(initial);
      if (signal?.aborted || isHidden() || !isAuthorized()) {
        cancel();
        return;
      }
      button.click();
      check();
    } catch {
      cancel();
    }
  });
}
