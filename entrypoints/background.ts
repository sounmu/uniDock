import { openLmsTab } from '../src/open-tab';
import { defineBackground } from 'wxt/utils/define-background';
import { safeLog } from '../src/security/logger';
export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (!message || typeof message !== 'object' || (message as Record<string,unknown>).type !== 'OPEN_LMS_TARGET') return false;
    void openLmsTab(message,sender).then(respond);
    return true;
  });
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => safeLog('PANEL_SETUP_FAILED'));
});
