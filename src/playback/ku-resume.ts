/** Accept only KU's visible saved-position prompt while playback is authorized. */
export function observeKuResume(
  document: Document,
  authorized: () => boolean,
  onAccept?: (positionSeconds: number) => void,
): () => void {
  let active = true;
  let handled: HTMLElement | null = null;
  const visible = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const style = document.defaultView?.getComputedStyle(element);
    return (
      element.isConnected &&
      rect.width > 0 &&
      rect.height > 0 &&
      style?.display !== "none" &&
      style?.visibility === "visible"
    );
  };
  const check = () => {
    if (!active) return;
    if (handled && !visible(handled)) handled = null;
    if (document.visibilityState === "hidden" || !authorized()) return;
    const boxes = Array.from(
      document.querySelectorAll<HTMLElement>(".confirm-msg-box"),
    ).filter(visible);
    const box = boxes.length === 1 ? boxes[0] : undefined;
    if (!box || box === handled) return;
    const text = box
      .querySelector(".confirm-msg-text")
      ?.textContent?.replace(/\s+/g, " ")
      .trim();
    const position = text
      ? /^이전에 시청했던 (\d{1,3}:[0-5]\d(?::[0-5]\d)?)부터 이어서 보시겠습니까\?$/.exec(
          text,
        )?.[1]
      : undefined;
    if (!position) return;
    const yes = box.querySelector<HTMLElement>(".confirm-ok-btn");
    const no = box.querySelector<HTMLElement>(".confirm-cancel-btn");
    if (
      !yes ||
      yes.textContent?.trim() !== "예" ||
      no?.textContent?.trim() !== "아니오" ||
      yes.matches(":disabled") ||
      yes.getAttribute("aria-disabled") === "true" ||
      !visible(yes)
    )
      return;
    handled = box;
    onAccept?.(
      position
        .split(":")
        .reduce((seconds, part) => seconds * 60 + Number(part), 0),
    );
    yes.click();
  };
  const observer = new MutationObserver(check);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden", "aria-disabled"],
  });
  check();
  return () => {
    active = false;
    observer.disconnect();
  };
}
