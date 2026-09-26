/** Initialize KU through its own start control before observing the native lecture.
 * The caller must already hold a current playback authorization. No LMS APIs,
 * page-owned player methods, URLs or credentials are read or invoked here.
 */
export async function initializeKuLecture(
  initial: HTMLVideoElement,
  authorized: () => boolean,
): Promise<HTMLVideoElement> {
  const document = initial.ownerDocument;
  const button = document.querySelector<HTMLElement>(
    ".vc-front-screen-play-btn",
  );
  if (!authorized()) throw new Error("PLAYER_LOST");
  if (
    !button ||
    button.getBoundingClientRect().width <= 0 ||
    getComputedStyle(button).visibility === "hidden" ||
    getComputedStyle(button).display === "none"
  )
    return initial;

  const source = initial.currentSrc;
  const stream = initial.srcObject;
  return new Promise((resolve, reject) => {
    let finished = false;
    const deadline = performance.now() + 15000;
    const cleanup = () => {
      clearInterval(timer);
      document.removeEventListener("loadedmetadata", check, true);
    };
    function check() {
      if (finished) return;
      if (!authorized() || performance.now() >= deadline) {
        finished = true;
        cleanup();
        reject(new Error("PLAYER_LOST"));
        return;
      }
      const videos = document.querySelectorAll<HTMLVideoElement>(
        ".vc-vplay-container > video.vc-vplay-video1",
      );
      if (videos.length !== 1) return;
      const video = videos[0]!;
      if (
        video.readyState < HTMLMediaElement.HAVE_METADATA ||
        !(video.currentSrc || video.srcObject) ||
        (video.currentSrc === source && video.srcObject === stream)
      )
        return;
      finished = true;
      cleanup();
      resolve(video);
    }
    const timer = setInterval(check, 100);
    document.addEventListener("loadedmetadata", check, true);
    try {
      button.click();
      check();
    } catch {
      finished = true;
      cleanup();
      reject(new Error("PLAYER_LOST"));
    }
  });
}
