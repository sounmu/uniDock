import type { Result } from "./protocol";
import { object } from "./playback/bridge";
import { lmsFileDownloadUrl, validDownloadPath } from "./security/download";
import { safeLog } from "./security/logger";

// Only the installed extension's top-frame LMS content script may download.
export async function downloadLmsFile(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<Result> {
  if (
    !object(message) ||
    Object.keys(message).length !== 4 ||
    message.version !== 1 ||
    message.type !== "DOWNLOAD_LMS_FILE" ||
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    sender.tab?.id === undefined ||
    !sender.url ||
    lmsFileDownloadUrl(message.url, sender.url) !== message.url ||
    typeof message.url !== "string" ||
    !validDownloadPath(message.filename)
  )
    return { status: "error", code: "POLICY" };
  try {
    const current = await chrome.tabs.get(sender.tab.id);
    if (current.url !== sender.url)
      return { status: "error", code: "RELOAD_TAB" };
    await chrome.downloads.download({
      url: message.url,
      filename: message.filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
    return { status: "success", downloaded: true };
  } catch {
    // Browser API boundary: never expose or log the rejected URL or error.
    safeLog("REQUEST_FAILED");
    return { status: "error", code: "DOWNLOAD_FAILED" };
  }
}
