import { openLmsTab } from "../src/open-tab";
import { defineBackground } from "wxt/utils/define-background";
import { safeLog } from "../src/security/logger";

const DEFAULT_ACTION_TITLE = "uniDock 열기";
const FALLBACK_ACTION_TITLE = "uniDock — 사이드 패널 대신 팝업으로 엽니다";

async function usePopupFallback() {
  await Promise.all([
    chrome.action.setPopup({ popup: "sidepanel.html" }),
    chrome.action.setBadgeText({ text: "!" }),
    chrome.action.setBadgeBackgroundColor({ color: "#872038" }),
    chrome.action.setTitle({ title: FALLBACK_ACTION_TITLE }),
  ]);
}

async function configurePanelAction() {
  if (typeof chrome.sidePanel?.setPanelBehavior !== "function") {
    await usePopupFallback();
    return;
  }
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    await usePopupFallback();
    return;
  }
  await Promise.all([
    chrome.action.setPopup({ popup: "" }),
    chrome.action.setBadgeText({ text: "" }),
    chrome.action.setTitle({ title: DEFAULT_ACTION_TITLE }),
  ]);
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (
      !message ||
      typeof message !== "object" ||
      (message as Record<string, unknown>).type !== "OPEN_LMS_TARGET"
    )
      return false;
    void openLmsTab(message, sender).then(respond);
    return true;
  });
  void configurePanelAction().catch(() => safeLog("PANEL_SETUP_FAILED"));
});
