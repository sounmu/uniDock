import { validDocument, type Result } from "./protocol";
import { navigationUrl, playerUrl } from "./security/navigation";
import { TabRateLimiter } from "./security/rate-limit";
import { allowedPage } from "./security/policy";
// Shared by clicks and caption-batch opens: a forged request picks its own
// `reuse` flag, so a second limiter would only double the budget. A batch
// waits for each lecture's player, and its upload if any, before the next.
export const OPEN_RATE_WINDOW_MS = 60_000;
const opens = new TabRateLimiter(30, OPEN_RATE_WINDOW_MS);
// A caption batch asks about one loading lecture every 1.5 seconds.
const checks = new TabRateLimiter(60, OPEN_RATE_WINDOW_MS);
/** Session key holding the id of the one tab caption work from this list tab
    opens lectures in; panels in other windows work from other list tabs. */
export function lectureTabKey(source: number): string {
  return `unidock-lecture-tab:${source}`;
}

async function openInLectureTab(url: string, source: number): Promise<void> {
  const key = lectureTabKey(source);
  const saved: unknown = (await chrome.storage.session.get(key))[key];
  // The source tab holds the list being worked through, so it is never reused.
  if (typeof saved === "number" && saved !== source) {
    // A closed tab rejects; a tab the user took elsewhere is left alone.
    const tab = await chrome.tabs.get(saved).catch(() => undefined);
    // Board recordings open the canonical KU player page directly.
    if (tab?.url && (allowedPage(tab.url) || playerUrl(tab.url))) {
      await chrome.tabs.update(saved, { url, active: true });
      return;
    }
  }
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab.id !== undefined) await chrome.storage.session.set({ [key]: tab.id });
}
// Only our top-frame LMS content script can request a canonical LMS navigation
// or ask what the lecture tab it opened shows.
function listTabSender(
  sender: chrome.runtime.MessageSender,
): sender is chrome.runtime.MessageSender & {
  url: string;
  tab: chrome.tabs.Tab & { id: number };
} {
  return (
    sender.id === chrome.runtime.id &&
    sender.frameId === 0 &&
    sender.tab?.id !== undefined &&
    !!sender.url
  );
}
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
    !listTabSender(sender)
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
/** Whether the lecture tab this list tab opened still shows `url` at the top
    and holds `document` among its current documents. A caption batch sends
    the audio of a player document only after this confirms it; anything that
    cannot be confirmed is a mismatch. */
export async function verifyLectureTab(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<Result> {
  if (!message || typeof message !== "object")
    return { status: "error", code: "POLICY" };
  const row = message as Record<string, unknown>;
  if (
    Object.keys(row).length !== 4 ||
    row.version !== 1 ||
    row.type !== "VERIFY_LECTURE_TAB" ||
    !validDocument(row.document) ||
    !listTabSender(sender)
  )
    return { status: "error", code: "POLICY" };
  const url = navigationUrl(row.url, sender.url);
  if (!url) return { status: "error", code: "POLICY" };
  try {
    const current = await chrome.tabs.get(sender.tab.id);
    if (current.url !== sender.url)
      return { status: "error", code: "RELOAD_TAB" };
    if (!checks.admit(sender.tab.id))
      return { status: "error", code: "RATE_LIMITED" };
    const key = lectureTabKey(sender.tab.id);
    const saved: unknown = (await chrome.storage.session.get(key))[key];
    if (typeof saved !== "number")
      return { status: "error", code: "LECTURE_MISMATCH" };
    // One pass over the tab's frames reads the top URL and the documents
    // together, so a navigation cannot fall between two separate checks.
    const frames = await chrome.scripting.executeScript({
      target: { tabId: saved, allFrames: true },
      func: () => location.href,
    });
    const top = frames.find((frame) => frame.frameId === 0);
    return top?.result === url &&
      frames.some((frame) => frame.documentId === row.document)
      ? { status: "success", verified: true }
      : { status: "error", code: "LECTURE_MISMATCH" };
  } catch {
    return { status: "error", code: "LECTURE_MISMATCH" };
  }
}
