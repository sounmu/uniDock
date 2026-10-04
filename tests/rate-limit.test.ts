import { afterEach, expect, it, vi } from "vitest";
import { TabRateLimiter } from "../src/security/rate-limit";
import { openLmsTab } from "../src/open-tab";
import { downloadLmsFile } from "../src/download-tab";

const origin = "https://mylms.korea.ac.kr";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("admits up to the limit per tab and recovers after the window", () => {
  const limiter = new TabRateLimiter(2, 1000);
  expect(limiter.admit(1, 0)).toBe(true);
  expect(limiter.admit(1, 10)).toBe(true);
  expect(limiter.admit(1, 20)).toBe(false);
  // Another tab has its own budget.
  expect(limiter.admit(2, 20)).toBe(true);
  // A refused request does not extend the window.
  expect(limiter.admit(1, 1000)).toBe(true);
  expect(limiter.admit(1, 1005)).toBe(false);
  expect(limiter.admit(1, 1010)).toBe(true);
});

it("refuses tab opens beyond the per-tab budget without creating a tab", async () => {
  vi.useFakeTimers();
  const create = vi.fn().mockResolvedValue({ id: 8 });
  vi.stubGlobal("chrome", {
    runtime: { id: "extension" },
    tabs: { get: vi.fn().mockResolvedValue({ url: origin + "/" }), create },
  });
  const sender = {
    id: "extension",
    frameId: 0,
    url: origin + "/",
    tab: { id: 71 },
  } as chrome.runtime.MessageSender;
  const message = {
    version: 1,
    type: "OPEN_LMS_TARGET",
    url: origin + "/courses/101/modules/items/501",
  };
  for (let count = 0; count < 30; count++)
    expect((await openLmsTab(message, sender)).status).toBe("success");
  expect(await openLmsTab(message, sender)).toEqual({
    status: "error",
    code: "RATE_LIMITED",
  });
  expect(create).toHaveBeenCalledTimes(30);
  // Another tab is unaffected, and the budget returns after the window.
  expect(
    (await openLmsTab(message, { ...sender, tab: { id: 72 } } as never)).status,
  ).toBe("success");
  vi.advanceTimersByTime(60_000);
  expect((await openLmsTab(message, sender)).status).toBe("success");
});

it("refuses downloads beyond the per-tab budget without starting one", async () => {
  vi.useFakeTimers();
  const download = vi.fn().mockResolvedValue(1);
  const sender = {
    id: "fixture",
    frameId: 0,
    documentId: "document-a",
    url: `${origin}/courses/101`,
    tab: { id: 73 },
  } as chrome.runtime.MessageSender;
  vi.stubGlobal("chrome", {
    runtime: { id: "fixture" },
    tabs: {
      get: vi.fn().mockResolvedValue({ url: sender.url }),
      sendMessage: vi.fn(
        async (_tabId: number, challenge: { nonce: string }) => ({
          version: 1,
          type: "DOWNLOAD_SOURCE_OK",
          nonce: challenge.nonce,
        }),
      ),
    },
    downloads: { download },
  });
  const message = () => ({
    version: 1,
    type: "DOWNLOAD_LMS_FILE",
    deadline: Date.now() + 23_000,
    url: `${origin}/courses/101/files/501/download?download_frd=1`,
    filename: "uniDock/Course/Week/slides.pdf",
  });
  for (let count = 0; count < 240; count++)
    expect((await downloadLmsFile(message(), sender)).status).toBe("success");
  expect(await downloadLmsFile(message(), sender)).toEqual({
    status: "error",
    code: "RATE_LIMITED",
  });
  expect(download).toHaveBeenCalledTimes(240);
});

it("restores a spent capability once, only while the catalog is live", async () => {
  const { NavigationCatalog } = await import("../src/navigation-catalog");
  const catalog = new NavigationCatalog();
  const [document] = catalog.replaceDocuments(origin, [
    {
      module: "Week",
      title: "file.pdf",
      filename: "file.pdf",
      courseId: "101",
      itemId: "501",
      fileId: "777",
      moduleAccess: {},
      itemAccess: {},
    },
  ]);
  const handle = document!.downloadHandle;
  const taken = catalog.takeDownload(handle, origin);
  expect(catalog.takeDownload(handle, origin)).toBeNull();
  expect(taken?.restore()).toBe(true);
  expect(taken?.restore()).toBe(false);
  const again = catalog.takeDownload(handle, origin);
  expect(again?.url).toBe(taken?.url);
  catalog.revoke();
  expect(again?.restore()).toBe(false);
  const open = new NavigationCatalog();
  const [recording] = open.replace(origin, [
    {
      module: "Week",
      title: "Lecture",
      courseId: "101",
      itemId: "501",
      moduleAccess: {},
      itemAccess: {},
    },
  ]);
  const opened = open.takeOpen(recording!.launchHandle, origin);
  expect(opened?.restore()).toBe(true);
  expect(open.take(recording!.launchHandle, origin)).toBe(opened?.url);
  open.clear();
});
