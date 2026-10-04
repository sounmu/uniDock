import type { Result } from "./protocol";
import { validDownloadDeadline, validHandle } from "./protocol";
import { object } from "./playback/bridge";
import { lmsFileDownloadUrl, validDownloadPath } from "./security/download";
import { safeLog } from "./security/logger";
import { TabRateLimiter } from "./security/rate-limit";
// The panel downloads serially; a full course batch stays well under this.
const downloads = new TabRateLimiter(240, 60_000);

async function sourceDocumentAlive(
  tabId: number,
  documentId: string,
  deadline: number,
): Promise<boolean> {
  const nonce = crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const verified: unknown = await Promise.race([
      chrome.tabs.sendMessage(
        tabId,
        { version: 1, type: "DOWNLOAD_SOURCE_CHECK", nonce },
        { frameId: 0, documentId },
      ),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(
          () => resolve(undefined),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
    return (
      object(verified) &&
      Object.keys(verified).length === 3 &&
      verified.version === 1 &&
      verified.type === "DOWNLOAD_SOURCE_OK" &&
      validHandle(verified.nonce) &&
      verified.nonce === nonce
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Only the installed extension's top-frame LMS content script may download.
export async function downloadLmsFile(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<Result> {
  if (
    !object(message) ||
    Object.keys(message).length !== 5 ||
    message.version !== 1 ||
    message.type !== "DOWNLOAD_LMS_FILE" ||
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    sender.tab?.id === undefined ||
    !sender.documentId ||
    !sender.url ||
    !validDownloadDeadline(message.deadline) ||
    lmsFileDownloadUrl(message.url, sender.url) !== message.url ||
    typeof message.url !== "string" ||
    !validDownloadPath(message.filename)
  )
    return { status: "error", code: "POLICY" };
  try {
    const current = await chrome.tabs.get(sender.tab.id);
    if (current.url !== sender.url)
      return { status: "error", code: "RELOAD_TAB" };
    if (!validDownloadDeadline(message.deadline))
      return { status: "error", code: "TIMEOUT" };
    if (
      !(await sourceDocumentAlive(
        sender.tab.id,
        sender.documentId,
        message.deadline,
      ))
    )
      return { status: "error", code: "RELOAD_TAB" };
    // Same-document navigation keeps the document ID; re-check the source URL.
    if ((await chrome.tabs.get(sender.tab.id)).url !== sender.url)
      return { status: "error", code: "RELOAD_TAB" };
    // The browser may finish a download after this deadline. We only forbid
    // initiating one after the originating panel operation has expired.
    if (!validDownloadDeadline(message.deadline))
      return { status: "error", code: "TIMEOUT" };
    if (!downloads.admit(sender.tab.id))
      return { status: "error", code: "BUSY" };
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
