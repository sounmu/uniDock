import { afterEach, expect, it, vi } from "vitest";

vi.mock("wxt/utils/define-background", () => ({
  defineBackground: (main: () => void) => ({ main }),
}));

import background from "../entrypoints/background";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function actionMocks() {
  const setPopup = vi.fn().mockResolvedValue(undefined);
  const setBadgeText = vi.fn().mockResolvedValue(undefined);
  const setBadgeBackgroundColor = vi.fn().mockResolvedValue(undefined);
  const setTitle = vi.fn().mockResolvedValue(undefined);
  return { setPopup, setBadgeText, setBadgeBackgroundColor, setTitle };
}

it("opens the sidepanel page as a popup when the side panel API is unavailable", async () => {
  const action = actionMocks();
  vi.stubGlobal("chrome", {
    runtime: { onMessage: { addListener: vi.fn() } },
    action,
  });

  expect(() => background.main()).not.toThrow();
  await vi.waitFor(() =>
    expect(action.setPopup).toHaveBeenCalledWith({ popup: "sidepanel.html" }),
  );
  expect(action.setBadgeText).toHaveBeenCalledWith({ text: "!" });
  expect(action.setTitle).toHaveBeenCalledWith({
    title: "uniDock — 사이드 패널 대신 팝업으로 엽니다",
  });
});

it("falls back to the popup when side panel setup is rejected", async () => {
  const action = actionMocks();
  vi.stubGlobal("chrome", {
    runtime: { onMessage: { addListener: vi.fn() } },
    sidePanel: {
      setPanelBehavior: vi.fn().mockRejectedValue(new Error("disabled")),
    },
    action,
  });

  background.main();

  await vi.waitFor(() =>
    expect(action.setPopup).toHaveBeenCalledWith({ popup: "sidepanel.html" }),
  );
  expect(action.setBadgeText).toHaveBeenCalledWith({ text: "!" });
});

it("restores direct side panel opening after support becomes available", async () => {
  const action = actionMocks();
  const setPanelBehavior = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("chrome", {
    runtime: { onMessage: { addListener: vi.fn() } },
    sidePanel: { setPanelBehavior },
    action,
  });

  background.main();

  await vi.waitFor(() =>
    expect(action.setPopup).toHaveBeenCalledWith({ popup: "" }),
  );
  expect(setPanelBehavior).toHaveBeenCalledWith({
    openPanelOnActionClick: true,
  });
  expect(action.setBadgeText).toHaveBeenCalledWith({ text: "" });
  expect(action.setTitle).toHaveBeenCalledWith({ title: "uniDock 열기" });
});
