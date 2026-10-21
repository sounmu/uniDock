// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PopupSettings } from "../entrypoints/sidepanel/PopupSettings";
import { popupAutoCloseKey } from "../src/popup-settings";
import { deferred, mount } from "./ui-helpers";

let ui: Awaited<ReturnType<typeof mount>>;
const listeners = new Set<
  (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
>();
const get = vi.fn();
const set = vi.fn();
function emit(value: unknown) {
  for (const listener of listeners)
    listener({ [popupAutoCloseKey]: { newValue: value } }, "local");
}
beforeEach(() => {
  get.mockResolvedValue({});
  set.mockImplementation(async (values: Record<string, unknown>) => {
    emit(values[popupAutoCloseKey]);
  });
  vi.stubGlobal("chrome", {
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
  const select = ui.host.querySelector("select");
  if (!select) throw new Error("Missing select");
  expect(select.value).toBe("off");
  expect(set).not.toHaveBeenCalled();
  await act(async () => {
    select.value = "on";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(set).toHaveBeenCalledWith({ [popupAutoCloseKey]: true });
  expect(select.value).toBe("on");
});
it("reflects clearing local data and detaches its listener on unmount", async () => {
  get.mockResolvedValue({ [popupAutoCloseKey]: true });
  ui = await mount(<PopupSettings />);
  await act(async () => emit(undefined));
  expect(ui.host.querySelector("select")?.value).toBe("off");
  await ui.unmount();
  expect(listeners.size).toBe(0);
});
it("disables interaction while the initial setting is loading", async () => {
  const held = deferred<Record<string, unknown>>();
  get.mockReturnValue(held.promise);
  ui = await mount(<PopupSettings />);
  expect(ui.host.querySelector("select")?.disabled).toBe(true);
  await act(async () => held.resolve({}));
  expect(ui.host.querySelector("select")?.disabled).toBe(false);
});
it("reports failed saves without claiming the setting changed", async () => {
  set.mockRejectedValue(new Error("storage"));
  ui = await mount(<PopupSettings />);
  const select = ui.host.querySelector("select");
  if (!select) throw new Error("Missing select");
  await act(async () => {
    select.value = "on";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(ui.host.querySelector('[role="alert"]')).not.toBeNull();
  expect(select.value).toBe("off");
  expect(select.disabled).toBe(false);
});
