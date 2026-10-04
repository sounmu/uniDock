import { type Result } from "./protocol";
import { navigationUrl } from "./security/navigation";
import { TabRateLimiter } from "./security/rate-limit";
// A person opens lectures one click at a time.
const opens = new TabRateLimiter(30, 60_000);
// Only our top-frame LMS content script can request a canonical LMS navigation.
export async function openLmsTab(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<Result> {
  if (!message || typeof message !== "object")
    return { status: "error", code: "POLICY" };
  const row = message as Record<string, unknown>;
  if (
    Object.keys(row).length !== 3 ||
    row.version !== 1 ||
    row.type !== "OPEN_LMS_TARGET" ||
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    sender.tab?.id === undefined ||
    !sender.url
  )
    return { status: "error", code: "POLICY" };
  const url = navigationUrl(row.url, sender.url);
  if (!url) return { status: "error", code: "POLICY" };
  try {
    const current = await chrome.tabs.get(sender.tab.id);
    if (current.url !== sender.url)
      return { status: "error", code: "RELOAD_TAB" };
    if (!opens.admit(sender.tab.id))
      return { status: "error", code: "RATE_LIMITED" };
    await chrome.tabs.create({ url, active: true });
    return { status: "success", opened: true };
  } catch {
    return { status: "error", code: "TAB_OPEN_FAILED" };
  }
}
