// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PopupSettings } from "../entrypoints/sidepanel/PopupSettings";
import { LocalDataSettings } from "../entrypoints/sidepanel/LocalDataSettings";
import { popupAutoCloseKey } from "../src/popup-settings";
import { click, deferred, mount } from "./ui-helpers";

let ui: Awaited<ReturnType<typeof mount>>;
const listeners = new Set<
  (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
>();
const get = vi.fn();
const set = vi.fn();
const request = vi.fn();
const removeGrant = vi.fn();
const sendMessage = vi.fn();
function toggle(): HTMLButtonElement {
  const button = ui.host.querySelector<HTMLButtonElement>('[role="switch"]');
  if (!button) throw new Error("Missing switch");
  return button;
}
function emit(value: unknown) {
  for (const listener of listeners)
    listener({ [popupAutoCloseKey]: { newValue: value } }, "local");
}
beforeEach(() => {
  get.mockResolvedValue({});
  request.mockResolvedValue(true);
  removeGrant.mockResolvedValue(true);
  set.mockImplementation(async (values: Record<string, unknown>) => {
    emit(values[popupAutoCloseKey]);
  });
  vi.stubGlobal("chrome", {
    permissions: { request, remove: removeGrant },
    runtime: { sendMessage },
    storage: {
      local: { get, set },
      onChanged: {
        addListener: (listener: Parameters<typeof listeners.add>[0]) =>
          listeners.add(listener),
        removeListener: (listener: Parameters<typeof listeners.add>[0]) =>
          listeners.delete(listener),
      },
    },
  });
});
afterEach(async () => {
  await ui?.unmount();
  listeners.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it("starts off without persisting a default and saves an explicit opt-in", async () => {
  ui = await mount(<PopupSettings />);
  const button = toggle();
  expect(button.getAttribute("aria-checked")).toBe("false");
  expect(button.querySelector(".switch-check")).toBeNull();
  expect(button.getAttribute("aria-labelledby")).toBe("popup-row-title");
  expect(ui.host.textContent).toContain("LMS 동작");
  expect(set).not.toHaveBeenCalled();
  await act(async () => button.click());
  expect(request).toHaveBeenCalledWith({
    origins: ["https://lms.korea.ac.kr/*"],
  });
  expect(set).toHaveBeenCalledWith({ [popupAutoCloseKey]: true });
  expect(button.getAttribute("aria-checked")).toBe("true");
  expect(button.querySelector(".switch-check")).not.toBeNull();
  await act(async () => button.click());
  // Turning off needs no prompt; the worker returns the grant.
  expect(request).toHaveBeenCalledTimes(1);
  expect(set).toHaveBeenLastCalledWith({ [popupAutoCloseKey]: false });
  expect(button.getAttribute("aria-checked")).toBe("false");
});
it("reflects clearing local data and detaches its listener on unmount", async () => {
  get.mockResolvedValue({ [popupAutoCloseKey]: true });
  ui = await mount(<PopupSettings />);
  await act(async () => emit(undefined));
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  await ui.unmount();
  expect(listeners.size).toBe(0);
});
it("disables interaction while the initial setting is loading", async () => {
  const held = deferred<Record<string, unknown>>();
  get.mockReturnValue(held.promise);
  ui = await mount(<PopupSettings />);
  expect(toggle().getAttribute("aria-disabled")).toBe("true");
  await act(async () => toggle().click());
  expect(set).not.toHaveBeenCalled();
  await act(async () => held.resolve({}));
  expect(toggle().getAttribute("aria-disabled")).toBe("false");
});
it("reports failed saves without claiming the setting changed", async () => {
  set.mockRejectedValue(new Error("storage"));
  ui = await mount(<PopupSettings />);
  const button = toggle();
  await act(async () => button.click());
  expect(ui.host.querySelector('[role="alert"]')).not.toBeNull();
  expect(button.getAttribute("aria-checked")).toBe("false");
  expect(button.getAttribute("aria-disabled")).toBe("false");
});
it("stays off without saving when the portal grant is declined", async () => {
  request.mockResolvedValue(false);
  ui = await mount(<PopupSettings />);
  const button = toggle();
  await act(async () => button.click());
  expect(set).not.toHaveBeenCalled();
  expect(button.getAttribute("aria-checked")).toBe("false");
  expect(ui.host.querySelector('[role="alert"]')?.textContent).toContain(
    "lms.korea.ac.kr 접근을 허용해야",
  );
  expect(button.getAttribute("aria-disabled")).toBe("false");
});
it("orders a quick OFF then ON: ON waits until OFF has saved and returned the grant", async () => {
  get.mockResolvedValue({ [popupAutoCloseKey]: true });
  const returned = deferred<boolean>();
  removeGrant.mockReturnValueOnce(returned.promise);
  const order: string[] = [];
  set.mockImplementation(async (values: Record<string, unknown>) => {
    order.push(`save:${String(values[popupAutoCloseKey])}`);
    emit(values[popupAutoCloseKey]);
  });
  removeGrant.mockImplementation(async () => {
    order.push("return-grant");
    return true;
  });
  request.mockImplementation(async () => {
    order.push("request");
    return true;
  });
  ui = await mount(<PopupSettings />);
  const button = toggle();
  expect(button.getAttribute("aria-checked")).toBe("true");
  await act(async () => button.click());
  // OFF is saved; the grant is still being returned.
  expect(button.getAttribute("aria-checked")).toBe("false");
  expect(button.getAttribute("aria-disabled")).toBe("true");
  await act(async () => button.click());
  expect(request).not.toHaveBeenCalled();
  await act(async () => returned.resolve(true));
  expect(button.getAttribute("aria-disabled")).toBe("false");
  await act(async () => button.click());
  expect(order).toEqual(["save:false", "request", "save:true"]);
  expect(removeGrant).toHaveBeenCalledWith({
    origins: ["https://lms.korea.ac.kr/*"],
  });
  expect(button.getAttribute("aria-checked")).toBe("true");
});
it("keeps the switch busy while local-data deletion clears the opt-in and its grant", async () => {
  get.mockResolvedValue({ [popupAutoCloseKey]: true });
  const deleted = deferred<unknown>();
  sendMessage.mockReturnValue(deleted.promise);
  ui = await mount(
    <>
      <PopupSettings />
      <LocalDataSettings />
    </>,
  );
  await click("로컬 데이터 모두 삭제");
  await click("삭제 확인");
  expect(toggle().getAttribute("aria-disabled")).toBe("true");
  await act(async () => toggle().click());
  expect(request).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
  await act(async () => {
    emit(undefined);
    deleted.resolve({ status: "success" });
  });
  expect(toggle().getAttribute("aria-disabled")).toBe("false");
  expect(toggle().getAttribute("aria-checked")).toBe("false");
});
