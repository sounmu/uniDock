import { afterEach, expect, it, vi } from "vitest";
import {
  isVersionUpgrade,
  markUpdate,
  reinjectLmsContentScripts,
  takeUpdateBadge,
} from "../src/update-notice";

afterEach(() => vi.unstubAllGlobals());
function action(initial = "") {
  let text = initial;
  return {
    getBadgeText: vi.fn(async () => text),
    setBadgeText: vi.fn(async ({ text: next }: { text: string }) => {
      text = next;
    }),
    setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
    text: () => text,
  };
}

it("treats only a strictly newer dotted version as an upgrade", () => {
  for (const details of [
    { reason: "install" },
    { reason: "chrome_update" },
    { reason: "update" },
    { reason: "update", previousVersion: "0.1.2" },
    { reason: "update", previousVersion: "0.1.2.0" },
    { reason: "update", previousVersion: "0.1.3" },
    { reason: "update", previousVersion: "invalid" },
  ])
    expect(
      isVersionUpgrade(details as chrome.runtime.InstalledDetails, "0.1.2"),
    ).toBe(false);
  expect(
    isVersionUpgrade({ reason: "update", previousVersion: "0.1.1" }, "0.1.2"),
  ).toBe(true);
});

it("badges the toolbar icon once per upgrade, without tabs, storage or remote requests", async () => {
  const badge = action();
  const create = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: { getManifest: () => ({ version: "0.1.2" }) },
    action: badge,
    tabs: { create },
  });
  expect(await markUpdate({ reason: "install" })).toBe(false);
  expect(await markUpdate({ reason: "update", previousVersion: "0.1.2" })).toBe(
    false,
  );
  expect(badge.text()).toBe("");
  expect(await markUpdate({ reason: "update", previousVersion: "0.1.1" })).toBe(
    true,
  );
  expect(badge.text()).toBe("NEW");
  expect(create).not.toHaveBeenCalled();
  // The panel spends it exactly once.
  expect(await takeUpdateBadge()).toBe(true);
  expect(badge.text()).toBe("");
  expect(await takeUpdateBadge()).toBe(false);
});

it("never replaces or clears the side panel fallback badge", async () => {
  const badge = action("!");
  vi.stubGlobal("chrome", {
    runtime: { getManifest: () => ({ version: "0.1.2" }) },
    action: badge,
  });
  expect(await markUpdate({ reason: "update", previousVersion: "0.1.1" })).toBe(
    false,
  );
  expect(await takeUpdateBadge()).toBe(false);
  expect(badge.text()).toBe("!");
  expect(badge.setBadgeText).not.toHaveBeenCalled();
});

it("re-injects only the packaged LMS script into loaded LMS tabs without a live copy", async () => {
  const executeScript = vi.fn(
    async ({ target }: { target: { tabId: number } }) => {
      if (target.tabId === 3) throw new Error("discarded");
      return [];
    },
  );
  // Tab 6 already runs this extension copy; every other tab has no receiver.
  const sendMessage = vi.fn(async (tabId: number) => {
    if (tabId === 6) return { version: 1, type: "LMS_PRESENT" };
    if (tabId === 2) return { version: 1, type: "SOMETHING_ELSE" };
    throw new Error("Receiving end does not exist.");
  });
  const complete = "complete";
  const query = vi.fn().mockResolvedValue([
    { id: 1, status: complete, url: "https://mylms.korea.ac.kr/courses/1" },
    { id: 2, status: complete, url: "https://canvas.korea.ac.kr/" },
    { id: 3, status: complete, url: "https://mylms.korea.ac.kr/" },
    { id: 4, status: complete, url: "https://evil.invalid/" },
    { id: 5, status: complete, url: "https://user:pass@mylms.korea.ac.kr/" },
    { id: 6, status: complete, url: "https://mylms.korea.ac.kr/" },
    { id: 7, status: "loading", url: "https://mylms.korea.ac.kr/" },
    { status: complete, url: "https://mylms.korea.ac.kr/" },
  ]);
  vi.stubGlobal("chrome", {
    tabs: { query, sendMessage },
    scripting: { executeScript },
  });
  expect(await reinjectLmsContentScripts({ reason: "chrome_update" })).toBe(0);
  expect(query).not.toHaveBeenCalled();
  expect(
    await reinjectLmsContentScripts({
      reason: "update",
      previousVersion: "0.1.1",
    }),
  ).toBe(2);
  expect(query).toHaveBeenCalledWith({
    url: ["https://mylms.korea.ac.kr/*", "https://canvas.korea.ac.kr/*"],
  });
  expect(sendMessage).toHaveBeenCalledWith(
    6,
    { version: 1, type: "LMS_PRESENCE" },
    { frameId: 0 },
  );
  expect(executeScript.mock.calls.map(([call]) => call)).toEqual(
    [1, 2, 3].map((tabId) => ({
      target: { tabId },
      files: ["content-scripts/lms.js"],
    })),
  );
  query.mockRejectedValueOnce(new Error("unavailable"));
  expect(await reinjectLmsContentScripts({ reason: "install" })).toBe(0);
});
