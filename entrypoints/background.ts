import { defineBackground } from 'wxt/utils/define-background';
import { safeLog } from '../src/security/logger';
export default defineBackground(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => safeLog('PANEL_SETUP_FAILED'));
});
