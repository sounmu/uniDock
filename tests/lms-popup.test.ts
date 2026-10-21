// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeLmsPopups, startPopupAutoClose } from "../src/lms-popup";
import {
  isPopupAutoCloseGet,
  notifyPopupAutoCloseTabs,
  parsePopupAutoCloseState,
  popupAutoCloseKey,
  popupPageSender,
  readPopupAutoClose,
  watchPopupAutoClose,
  watchPopupAutoCloseFromWorker,
} from "../src/popup-settings";
import { deferred } from "./ui-helpers";

let stop: (() => void) | undefined;
const listeners = new Set<
  (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
>();
const messageListeners = new Set<
  (message: unknown, sender: chrome.runtime.MessageSender) => unknown
>();
const get = vi.fn();
const sendMessage = vi.fn();
const worker = { id: "test" } as chrome.runtime.MessageSender;
let enabled: unknown = false;
function state(value: unknown) {
  return { version: 1, type: "POPUP_AUTO_CLOSE_STATE", enabled: value };
}
function storageChange(value: unknown) {
  for (const listener of listeners)
    listener({ [popupAutoCloseKey]: { newValue: value } }, "local");
}
function notify(
  sender = worker,
  message: unknown = { version: 1, type: "POPUP_AUTO_CLOSE_CHANGED" },
) {
  for (const listener of messageListeners) listener(message, sender);
}
/** Simulates the worker seeing a new value and telling the page to reread. */
async function setting(value: unknown) {
  enabled = value;
  notify();
  await sendMessage.mock.results.at(-1)?.value.catch(() => undefined);
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
  enabled = false;
  get.mockResolvedValue({});
  sendMessage.mockImplementation(async () => state(enabled));
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      getURL: (path: string) => `chrome-extension://test/${path}`,
      sendMessage,
      onMessage: {
        addListener: (listener: Parameters<typeof messageListeners.add>[0]) =>
          messageListeners.add(listener),
        removeListener: (
          listener: Parameters<typeof messageListeners.add>[0],
        ) => messageListeners.delete(listener),
      },
    },
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
  messageListeners.clear();
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
function survey() {
  const root = document.createElement("div");
  root.id = "xn-lms-term-survey-list";
  root.innerHTML =
    '<div class="xnlts-contents"><div class="xnlts-refresh">' +
    '<div class="xnlts-button">새로고침</div></div>' +
    '<div class="xnlts-survey">262R 과목 설문</div></div>' +
    '<div class="xnlts-button-container">' +
    '<div class="xnlts-button">로그아웃</div>' +
    '<div class="xnlts-button blue">설문 나가기</div></div>';
  const [logout, exit] = [
    ...root.querySelectorAll(".xnlts-button-container > div"),
  ];
  const refresh = root.querySelector(".xnlts-refresh .xnlts-button");
  const survey = root.querySelector(".xnlts-survey");
  if (!logout || !exit || !refresh || !survey)
    throw new Error("Missing fixture survey");
  const clicks = {
    logout: vi.fn(),
    exit: vi.fn(() => root.remove()),
    refresh: vi.fn(),
    survey: vi.fn(),
  };
  logout.addEventListener("click", clicks.logout);
  exit.addEventListener("click", clicks.exit);
  refresh.addEventListener("click", clicks.refresh);
  survey.addEventListener("click", clicks.survey);
  return { root, exit, clicks };
}
it("leaves an existing survey prompt without logging out, refreshing or opening a survey", () => {
  const { root, clicks } = survey();
  document.body.append(root);
  stop = observeLmsPopups();
  expect(clicks.exit).toHaveBeenCalledTimes(1);
  expect(clicks.logout).not.toHaveBeenCalled();
  expect(clicks.refresh).not.toHaveBeenCalled();
  expect(clicks.survey).not.toHaveBeenCalled();
});
it("leaves a survey prompt that appears after the notice wrapper is attached", async () => {
  stop = observeLmsPopups();
  const { root, clicks } = survey();
  await mutation(() => document.body.append(root));
  expect(clicks.exit).toHaveBeenCalledTimes(1);
  expect(clicks.logout).not.toHaveBeenCalled();
});
it("clicks only the exact exit label and never loops or acts after cleanup", async () => {
  const wrong = survey();
  const wrongExit = wrong.root.querySelector(".xnlts-button.blue");
  if (wrongExit) wrongExit.textContent = "로그아웃 하기";
  const stuck = survey();
  stuck.exit.removeEventListener("click", stuck.clicks.exit);
  const clicked = vi.fn();
  stuck.exit.addEventListener("click", clicked);
  document.body.append(wrong.root);
  stop = observeLmsPopups();
  expect(wrong.clicks.exit).not.toHaveBeenCalled();
  await mutation(() => {
    wrong.root.remove();
    document.body.append(stuck.root);
  });
  await mutation(() => stuck.root.append(document.createElement("span")));
  expect(clicked).toHaveBeenCalledTimes(1);
  stop();
  stop = undefined;
  const later = survey();
  await mutation(() => document.body.append(later.root));
  expect(later.clicks.exit).not.toHaveBeenCalled();
});
it("ignores a side-panel initial read overtaken by a storage change", async () => {
  const held = deferred<Record<string, unknown>>();
  get.mockReturnValue(held.promise);
  const receive = vi.fn();
  stop = watchPopupAutoClose(receive, vi.fn());
  storageChange(false);
  held.resolve({ [popupAutoCloseKey]: true });
  await held.promise;
  expect(receive.mock.calls).toEqual([[false]]);
});
it("reads through the worker, never extension storage, and applies only the newest reply", async () => {
  const held = deferred<unknown>();
  sendMessage.mockReturnValueOnce(held.promise);
  const receive = vi.fn();
  stop = watchPopupAutoCloseFromWorker(receive, vi.fn());
  expect(sendMessage).toHaveBeenCalledWith({
    version: 1,
    type: "POPUP_AUTO_CLOSE_GET",
  });
  await setting(false);
  held.resolve(state(true));
  await held.promise;
  expect(receive.mock.calls).toEqual([[false]]);
  expect(get).not.toHaveBeenCalled();
  expect(listeners.size).toBe(0);
});
it("rereads only for exact change notices from this extension's worker", async () => {
  stop = watchPopupAutoCloseFromWorker(vi.fn(), vi.fn());
  await sendMessage.mock.results[0]?.value;
  const change = { version: 1, type: "POPUP_AUTO_CLOSE_CHANGED" };
  for (const [sender, message] of [
    [{ id: "test", tab: { id: 1 } }, change],
    [{ id: "other" }, change],
    [{ id: "test", url: "chrome-extension://test/sidepanel.html" }, change],
    [worker, { ...change, enabled: true }],
    [worker, { version: 2, type: "POPUP_AUTO_CLOSE_CHANGED" }],
    [worker, null],
  ] as const)
    notify(sender as chrome.runtime.MessageSender, message);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  notify({ id: "test", url: "chrome-extension://test/background.js" });
  expect(sendMessage).toHaveBeenCalledTimes(2);
});
it("starts on a worker change notice and stops immediately when the setting is off", async () => {
  stop = startPopupAutoClose();
  await sendMessage.mock.results[0]?.value;
  const first = notice();
  await mutation(() =>
    document.getElementById("xn-popup-wrapper")?.append(first.item),
  );
  expect(first.clicked).not.toHaveBeenCalled();
  await setting(true);
  expect(first.clicked).toHaveBeenCalledTimes(1);
  await setting(false);
  const later = notice();
  await mutation(() =>
    document.getElementById("xn-popup-wrapper")?.append(later.item),
  );
  expect(later.clicked).not.toHaveBeenCalled();
  await setting(true);
  expect(later.clicked).toHaveBeenCalledTimes(1);
});
it("pauses on pagehide and rereads the setting on pageshow", async () => {
  enabled = true;
  stop = startPopupAutoClose();
  await sendMessage.mock.results[0]?.value;
  window.dispatchEvent(new Event("pagehide"));
  const later = notice();
  await mutation(() =>
    document.getElementById("xn-popup-wrapper")?.append(later.item),
  );
  expect(later.clicked).not.toHaveBeenCalled();
  expect(messageListeners.size).toBe(0);
  window.dispatchEvent(new Event("pageshow"));
  await sendMessage.mock.results.at(-1)?.value;
  expect(later.clicked).toHaveBeenCalledTimes(1);
  expect(messageListeners.size).toBe(1);
});
it.each([
  ["a rejected request", () => sendMessage.mockRejectedValue(new Error("x"))],
  [
    "an unavailable runtime",
    () =>
      sendMessage.mockImplementation(() => {
        throw new Error("Extension context invalidated");
      }),
  ],
  ["a refusal", () => sendMessage.mockResolvedValue({ ok: false })],
  ["a non-boolean value", () => sendMessage.mockResolvedValue(state("true"))],
  [
    "an extra field",
    () => sendMessage.mockResolvedValue({ ...state(true), url: "x" }),
  ],
])("fails closed on %s", async (_name, arrange) => {
  arrange();
  const first = notice();
  document.getElementById("xn-popup-wrapper")?.append(first.item);
  stop = startPopupAutoClose();
  await sendMessage.mock.results[0]?.value?.catch?.(() => undefined);
  await Promise.resolve();
  expect(first.clicked).not.toHaveBeenCalled();
  expect(messageListeners.size).toBe(0);
});
it("parses only the exact closed popup messages", () => {
  expect(
    isPopupAutoCloseGet({ version: 1, type: "POPUP_AUTO_CLOSE_GET" }),
  ).toBe(true);
  expect(
    isPopupAutoCloseGet({ version: 1, type: "POPUP_AUTO_CLOSE_GET", x: 1 }),
  ).toBe(false);
  expect(isPopupAutoCloseGet([1, 2])).toBe(false);
  expect(parsePopupAutoCloseState(state(false))).toBe(false);
  expect(parsePopupAutoCloseState({ ...state(true), version: 2 })).toBeNull();
  expect(parsePopupAutoCloseState(null)).toBeNull();
});
it("accepts setting reads only from this extension's portal top frame", () => {
  const page = {
    id: "test",
    frameId: 0,
    tab: { id: 4 } as chrome.tabs.Tab,
    url: "https://lms.korea.ac.kr/main",
    origin: "https://lms.korea.ac.kr",
  };
  expect(popupPageSender(page)).toBe(true);
  expect(popupPageSender({ ...page, origin: undefined })).toBe(true);
  for (const sender of [
    { ...page, id: "other" },
    { ...page, frameId: 1 },
    { ...page, tab: undefined },
    { ...page, url: undefined },
    { ...page, url: "https://mylms.korea.ac.kr/" },
    { ...page, url: "https://user:pass@lms.korea.ac.kr/" },
    { ...page, url: "not a url" },
    { ...page, origin: "https://evil.example" },
  ])
    expect(popupPageSender(sender)).toBe(false);
});
it("reports only a strict boolean from worker storage", async () => {
  get.mockResolvedValueOnce({ [popupAutoCloseKey]: "true" });
  expect(await readPopupAutoClose()).toEqual(state(false));
  get.mockResolvedValueOnce({ [popupAutoCloseKey]: true });
  expect(await readPopupAutoClose()).toEqual(state(true));
  expect(get).toHaveBeenCalledWith(popupAutoCloseKey);
});
it("notifies only top frames of portal tabs and tolerates missing receivers", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce([{ id: 3 }, {}, { id: 5 }])
    .mockRejectedValueOnce(new Error("unavailable"));
  const tabsSend = vi
    .fn()
    .mockRejectedValueOnce(new Error("no receiver"))
    .mockResolvedValue(undefined);
  vi.stubGlobal("chrome", { tabs: { query, sendMessage: tabsSend } });
  await notifyPopupAutoCloseTabs();
  expect(query).toHaveBeenCalledWith({ url: ["https://lms.korea.ac.kr/*"] });
  expect(tabsSend.mock.calls).toEqual([
    [3, { version: 1, type: "POPUP_AUTO_CLOSE_CHANGED" }, { frameId: 0 }],
    [5, { version: 1, type: "POPUP_AUTO_CLOSE_CHANGED" }, { frameId: 0 }],
  ]);
  await notifyPopupAutoCloseTabs();
  expect(tabsSend).toHaveBeenCalledTimes(2);
});
