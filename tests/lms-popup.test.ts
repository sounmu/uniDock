// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeLmsPopups, startPopupAutoClose } from "../src/lms-popup";
import { popupAutoCloseKey, watchPopupAutoClose } from "../src/popup-settings";
import { deferred } from "./ui-helpers";

let stop: (() => void) | undefined;
const listeners = new Set<
  (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
>();
const get = vi.fn();
function setting(value: unknown) {
  for (const listener of listeners)
    listener({ [popupAutoCloseKey]: { newValue: value } }, "local");
}
function notice() {
  const item = document.createElement("div");
  item.className = "xnp-item-wrapper";
  item.dataset.popupId = "fixture";
  item.innerHTML =
    '<div class="xnp-item-content"></div><div class="xnp-item-close">' +
    '<input type="checkbox" class="xnp-item-close-checkbox">' +
    '<button class="xnp-item-close-button" type="button">Close</button></div>';
  const button = item.querySelector("button");
  if (!button) throw new Error("Missing fixture button");
  const clicked = vi.fn(() => item.remove());
  button.addEventListener("click", clicked);
  return { item, button, clicked };
}
async function mutation(action: () => void) {
  await new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      resolve();
    });
    observer.observe(document, { childList: true, subtree: true });
    action();
  });
}
beforeEach(() => {
  document.body.innerHTML = '<div id="xn-popup-wrapper"></div>';
  get.mockResolvedValue({});
  vi.stubGlobal("chrome", {
    storage: {
      local: { get },
      onChanged: {
        addListener: (listener: Parameters<typeof listeners.add>[0]) =>
          listeners.add(listener),
        removeListener: (listener: Parameters<typeof listeners.add>[0]) =>
          listeners.delete(listener),
      },
    },
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  listeners.clear();
  document.body.replaceChildren();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it("closes existing notices without touching their checkbox or unrelated dialogs", () => {
  const first = notice();
  const second = notice();
  const unrelated = notice();
  document.getElementById("xn-popup-wrapper")?.append(first.item, second.item);
  document.body.append(unrelated.item);
  stop = observeLmsPopups();
  expect(first.clicked).toHaveBeenCalledTimes(1);
  expect(second.clicked).toHaveBeenCalledTimes(1);
  expect(first.item.querySelector("input")?.checked).toBe(false);
  expect(unrelated.clicked).not.toHaveBeenCalled();
  expect(document.getElementById("xn-popup-wrapper")).not.toBeNull();
});
it("attaches to a delayed wrapper and handles later notices in that same wrapper", async () => {
  document.body.replaceChildren();
  stop = observeLmsPopups();
  const first = notice();
  await mutation(() => {
    const wrapper = document.createElement("div");
    wrapper.id = "xn-popup-wrapper";
    wrapper.append(first.item);
    document.body.append(wrapper);
  });
  const later = notice();
  await mutation(() =>
    document.getElementById("xn-popup-wrapper")?.append(later.item),
  );
  expect(first.clicked).toHaveBeenCalledTimes(1);
  expect(later.clicked).toHaveBeenCalledTimes(1);
});
it("handles a close button added after its notice without matching nested impostors", async () => {
  const staged = notice();
  const controls = staged.item.querySelector(".xnp-item-close");
  if (!controls) throw new Error("Missing fixture controls");
  controls.remove();
  const nested = notice();
  staged.item.querySelector(".xnp-item-content")?.append(nested.item);
  document.getElementById("xn-popup-wrapper")?.append(staged.item);
  stop = observeLmsPopups();
  await mutation(() => staged.item.append(controls));
  expect(staged.clicked).toHaveBeenCalledTimes(1);
  expect(nested.clicked).not.toHaveBeenCalled();
});
it("does not loop on an ineffective close handler or click disabled controls", async () => {
  const stuck = notice();
  stuck.button.removeEventListener("click", stuck.clicked);
  const clicked = vi.fn();
  stuck.button.addEventListener("click", clicked);
  const disabled = notice();
  disabled.button.disabled = true;
  document
    .getElementById("xn-popup-wrapper")
    ?.append(stuck.item, disabled.item);
  stop = observeLmsPopups();
  await mutation(() => stuck.item.append(document.createElement("span")));
  expect(clicked).toHaveBeenCalledTimes(1);
  expect(disabled.clicked).not.toHaveBeenCalled();
});
it("stops processing additions after cleanup", async () => {
  stop = observeLmsPopups();
  stop();
  const later = notice();
  await mutation(() =>
    document.getElementById("xn-popup-wrapper")?.append(later.item),
  );
  expect(later.clicked).not.toHaveBeenCalled();
});
it("ignores an initial read overtaken by a storage change", async () => {
  const held = deferred<Record<string, unknown>>();
  get.mockReturnValue(held.promise);
  const receive = vi.fn();
  stop = watchPopupAutoClose(receive, vi.fn());
  setting(false);
  held.resolve({ [popupAutoCloseKey]: true });
  await held.promise;
  expect(receive.mock.calls).toEqual([[false]]);
});
it("requires a true boolean and disables immediately when the setting is removed", async () => {
  stop = startPopupAutoClose();
  await get.mock.results[0]?.value;
  const first = notice();
  setting("true");
  await mutation(() =>
    document.getElementById("xn-popup-wrapper")?.append(first.item),
  );
  expect(first.clicked).not.toHaveBeenCalled();
  setting(true);
  expect(first.clicked).toHaveBeenCalledTimes(1);
  setting(undefined);
  const later = notice();
  await mutation(() =>
    document.getElementById("xn-popup-wrapper")?.append(later.item),
  );
  expect(later.clicked).not.toHaveBeenCalled();
});
it("pauses on pagehide and rereads the setting on pageshow", async () => {
  get.mockResolvedValue({ [popupAutoCloseKey]: true });
  stop = startPopupAutoClose();
  await get.mock.results[0]?.value;
  window.dispatchEvent(new Event("pagehide"));
  const later = notice();
  await mutation(() =>
    document.getElementById("xn-popup-wrapper")?.append(later.item),
  );
  expect(later.clicked).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
  window.dispatchEvent(new Event("pageshow"));
  await get.mock.results.at(-1)?.value;
  expect(later.clicked).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(1);
});
it("fails closed on a storage read error", async () => {
  get.mockRejectedValue(new Error("unavailable"));
  const first = notice();
  document.getElementById("xn-popup-wrapper")?.append(first.item);
  stop = startPopupAutoClose();
  await get.mock.results[0]?.value.catch(() => undefined);
  expect(first.clicked).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
});
