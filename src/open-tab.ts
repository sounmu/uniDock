import { type Result } from "./protocol";
import { navigationUrl } from "./security/navigation";
import { TabRateLimiter } from "./security/rate-limit";
import { allowedPage } from "./security/policy";
// A person opens lectures one click at a time.
const opens = new TabRateLimiter(30, 60_000);
/** Session key holding the id of the one tab caption work opens lectures in. */
export const LECTURE_TAB_KEY = "unidock-lecture-tab";

async function openInLectureTab(url: string, source: number): Promise<void> {
  const saved: unknown = (await chrome.storage.session.get(LECTURE_TAB_KEY))[LECTURE_TAB_KEY];
  // The source tab holds the list being worked through, so it is never reused.
  if (typeof saved === "number" && saved !== source) {
    // A closed tab rejects; a tab the user took elsewhere is left alone.
    const tab = await chrome.tabs.get(saved).catch(() => undefined);
    if (tab?.url && allowedPage(tab.url)) {
      await chrome.tabs.update(saved, { url, active: true });
      return;
    }
  }
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab.id !== undefined)
    await chrome.storage.session.set({ [LECTURE_TAB_KEY]: tab.id });
}
// Only our top-frame LMS content script can request a canonical LMS navigation.
export async function openLmsTab(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<Result> {
  if (!message || typeof message !== "object")
    return { status: "error", code: "POLICY" };
  const row = message as Record<string, unknown>;
  const keys = Object.keys(row).length;
  if (
    !(keys === 3 || (keys === 4 && row.reuse === true)) ||
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
    if (row.reuse === true) await openInLectureTab(url, sender.tab.id);
    else await chrome.tabs.create({ url, active: true });
    return { status: "success", opened: true };
  } catch {
    return { status: "error", code: "TAB_OPEN_FAILED" };
  }
}
