import { allowedPage, LMS_MATCHES } from "./security/policy";

/** Chrome owns update delivery; no polling, external URLs, tabs or persisted IDs. */
export const UPDATE_BADGE = "NEW";
/** Badge used when the side panel is unavailable; an update must not hide it. */
export const FALLBACK_BADGE = "!";
// WXT bundles `entrypoints/lms.content.ts` to this fixed package path.
const LMS_CONTENT_SCRIPT = "content-scripts/lms.js";

export function isVersionUpgrade(
  details: chrome.runtime.InstalledDetails,
  current: string,
): boolean {
  const previous = details.previousVersion;
  if (details.reason !== "update" || !previous || previous === current)
    return false;
  const valid = /^\d+(?:\.\d+){0,3}$/;
  if (!valid.test(previous) || !valid.test(current)) return false;
  const before = previous.split(".").map(Number);
  const after = current.split(".").map(Number);
  for (let index = 0; index < 4; index++) {
    const delta = (after[index] ?? 0) - (before[index] ?? 0);
    if (delta) return delta > 0;
  }
  return false;
}

/** Marks the toolbar icon after a genuine upgrade; the panel clears it on open. */
export async function markUpdate(
  details: chrome.runtime.InstalledDetails,
): Promise<boolean> {
  if (!isVersionUpgrade(details, chrome.runtime.getManifest().version))
    return false;
  try {
    if ((await chrome.action.getBadgeText({})) !== "") return false;
    await Promise.all([
      chrome.action.setBadgeText({ text: UPDATE_BADGE }),
      chrome.action.setBadgeBackgroundColor({ color: "#872038" }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Spends the update badge once; true when this panel should show the notice. */
export async function takeUpdateBadge(): Promise<boolean> {
  try {
    if ((await chrome.action.getBadgeText({})) !== UPDATE_BADGE) return false;
    await chrome.action.setBadgeText({ text: "" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Chrome does not inject manifest content scripts into tabs that were already
 * open at install time, and an update orphans the old copy. Re-run only the
 * packaged LMS script in top-level LMS tabs so they work without a reload.
 *
 * Two live copies would answer the same panel messages with separate state,
 * so skip tabs still loading (the manifest injects into their new document)
 * and tabs where this extension copy already answers a presence check.
 */
export async function reinjectLmsContentScripts(
  details: chrome.runtime.InstalledDetails,
): Promise<number> {
  if (details.reason !== "install" && details.reason !== "update") return 0;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: LMS_MATCHES });
  } catch {
    return 0;
  }
  const results = await Promise.all(
    tabs.map(async (tab) => {
      if (
        tab.id === undefined ||
        !tab.url ||
        !allowedPage(tab.url) ||
        tab.status !== "complete"
      )
        return false;
      if (await livePresence(tab.id)) return false;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: [LMS_CONTENT_SCRIPT],
        });
        return true;
      } catch {
        // Discarded, loading or error pages simply keep needing a reload.
        return false;
      }
    }),
  );
  return results.filter(Boolean).length;
}

async function livePresence(tabId: number): Promise<boolean> {
  try {
    const reply: unknown = await chrome.tabs.sendMessage(
      tabId,
      { version: 1, type: "LMS_PRESENCE" },
      { frameId: 0 },
    );
    return (
      reply !== null &&
      typeof reply === "object" &&
      (reply as { type?: unknown }).type === "LMS_PRESENT"
    );
  } catch {
    // No receiver: a fresh install or an orphaned copy from before an update.
    return false;
  }
}
