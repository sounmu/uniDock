import { expect, type BrowserContext } from "@playwright/test";
import path from "node:path";
import { nativeVisibilityTest as test } from "./native-visibility";
import { aiCaptionsBuild, playbackBuild } from "./build-shape";

test.use({ nativeExtension: path.resolve(".output/chrome-mv3") });

const SKIP_REASON = "requires a playback or AI caption build for progress notifications";

async function pausedLecturePage(context: BrowserContext) {
  const origin = "https://mylms.korea.ac.kr";
  await context.route(`${origin}/**`, (route) => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><html lang="ko"><meta charset="utf-8"><title>Synthetic LMS</title><body style="background:#f1f1f3"><h1>샘플 강의</h1></body></html>',
  }));
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(origin);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  await expect.poll(() => worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/*` });
    if (tab?.id === undefined) return null;
    try {
      return await chrome.tabs.sendMessage(tab.id, { version: 1, type: "LMS_PRESENCE" });
    } catch {
      return null; // Content script may still be starting after navigation.
    }
  }, origin)).toEqual({ version: 1, type: "LMS_PRESENT" });
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/*` });
    if (tab?.id === undefined) throw new Error("Synthetic LMS tab missing");
    await chrome.tabs.sendMessage(tab.id, {
      version: 1, type: "PROGRESS_STATE",
      items: [{ kind: "playback", id: "playback", status: "paused", title: "샘플 강의", remaining: 1 }],
    });
  }, origin);
  return { page, worker, capsule: page.locator("#unidock-progress .capsule") };
}

test("paused playback capsule stays readable without a cast shadow", async ({ context }, testInfo) => {
  test.skip(!playbackBuild() && !aiCaptionsBuild(), SKIP_REASON);
  const { page, capsule } = await pausedLecturePage(context);
  await expect(capsule).toBeVisible();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`paused-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await expect(capsule).toHaveCSS("box-shadow", "none");
  const close = page.getByRole("button", { name: "알림 닫기" });
  await close.focus();
  await expect(close).toBeFocused();
  await close.press("Enter");
  await expect(capsule).toHaveCount(0);
});

test("capsule leaves the LMS page while a uniDock panel page is open in its window", async ({ context }) => {
  test.skip(!playbackBuild() && !aiCaptionsBuild(), SKIP_REASON);
  // Given an LMS page showing the capsule
  const { worker, capsule } = await pausedLecturePage(context);
  await expect(capsule).toBeVisible();
  // When the panel page opens as a tab of the same window
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  expect(await worker.evaluate(async () =>
    new Set((await chrome.tabs.query({})).map((tab) => tab.windowId)).size)).toBe(1);
  // Then the panel shows the work and the capsule is gone
  await expect(capsule).toHaveCount(0);
});
