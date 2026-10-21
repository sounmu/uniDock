import { watchPopupAutoCloseFromWorker } from "./popup-settings";

const itemSelector = ".xnp-item-wrapper[data-popup-id]";
const buttonSelector =
  ":scope > .xnp-item-close > button.xnp-item-close-button";

const surveySelector = "#xn-lms-term-survey-list";
const surveyExitSelector =
  ":scope .xnlts-button-container > .xnlts-button.blue";
const surveyExitLabel = "설문 나가기";

/**
 * Clicks only the survey prompt's exit control. The sibling log-out control
 * shares its class prefix, so the exact label is part of the match; the survey
 * itself is never opened or answered.
 */
function observeLmsSurvey(): () => void {
  const attempted = new WeakSet<Element>();
  const exit = () => {
    const root = document.querySelector(surveySelector);
    if (!root) return;
    for (const button of root.querySelectorAll(surveyExitSelector)) {
      if (
        !(button instanceof HTMLElement) ||
        button.textContent?.trim() !== surveyExitLabel ||
        button.closest("[hidden], [inert]") ||
        attempted.has(button)
      )
        continue;
      // Attempts, not successes, so a missing site handler cannot cause a click loop.
      attempted.add(button);
      button.click();
    }
  };
  const observer = new MutationObserver(exit);
  observer.observe(document, { childList: true, subtree: true });
  exit();
  return () => observer.disconnect();
}

/** Only invokes the known notice close control; never hides or removes page DOM. */
export function observeLmsPopups(): () => void {
  const stopSurvey = observeLmsSurvey();
  let wrapper: Element | null = null;
  const attempted = new WeakSet<HTMLButtonElement>();
  const close = (item: Element) => {
    if (!item.isConnected || item.parentElement !== wrapper) return;
    const button = item.querySelector(buttonSelector);
    if (
      !(button instanceof HTMLButtonElement) ||
      button.disabled ||
      button.closest("[hidden], [inert]") ||
      attempted.has(button)
    )
      return;
    // Track attempts, not success. A missing site handler must not cause a click loop.
    attempted.add(button);
    button.click();
  };
  const observer = new MutationObserver((records) => {
    if (!wrapper) {
      attach();
      return;
    }
    const items = new Set<Element>();
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const parent = node.closest(itemSelector);
        if (parent) items.add(parent);
        for (const item of node.querySelectorAll(itemSelector)) items.add(item);
      }
    }
    for (const item of items) close(item);
  });
  function attach() {
    const found = document.getElementById("xn-popup-wrapper");
    if (!found) return;
    wrapper = found;
    observer.disconnect();
    observer.observe(wrapper, { childList: true, subtree: true });
    for (const item of wrapper.querySelectorAll(`:scope > ${itemSelector}`))
      close(item);
  }
  // The wrapper persists after notices close. Only bootstrap observes the document.
  observer.observe(document, { childList: true, subtree: true });
  attach();
  return () => {
    observer.disconnect();
    stopSurvey();
  };
}

export function startPopupAutoClose(): () => void {
  let stopWatching: (() => void) | undefined;
  let stopObserving: (() => void) | undefined;
  const pause = () => {
    stopWatching?.();
    stopWatching = undefined;
    stopObserving?.();
    stopObserving = undefined;
  };
  const resume = () => {
    pause();
    stopWatching = watchPopupAutoCloseFromWorker((enabled) => {
      if (enabled) stopObserving ??= observeLmsPopups();
      else {
        stopObserving?.();
        stopObserving = undefined;
      }
    }, pause);
  };
  window.addEventListener("pagehide", pause);
  window.addEventListener("pageshow", resume);
  resume();
  return () => {
    pause();
    window.removeEventListener("pagehide", pause);
    window.removeEventListener("pageshow", resume);
  };
}
