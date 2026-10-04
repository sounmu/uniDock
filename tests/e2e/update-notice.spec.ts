import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("renders bundled update notes from the information screen and closes the notice tab", async ({
  playwright,
}, testInfo) => {
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-update-"));
  const extension = path.resolve(".output/chrome-mv3");
  const context = await playwright.chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--host-resolver-rules=MAP * ~NOTFOUND",
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const errors: string[] = [];
    worker.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const panel = await context.newPage();
    await panel.goto(
      `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
    );
    const version = await panel.evaluate(
      () => chrome.runtime.getManifest().version,
    );
    expect(
      context.pages().some((page) => page.url().endsWith("/updates.html")),
    ).toBe(false);
    await panel.getByRole("button", { name: "정보", exact: true }).click();
    const opened = context.waitForEvent("page");
    await panel.getByRole("link", { name: "현재 버전 변경 사항" }).click();
    const notice = await opened;
    notice.on("pageerror", (error) => errors.push(error.message));
    await expect(notice.getByRole("heading", { level: 1 })).toHaveText(
      "강의 자료를 더 편하게 확인하세요",
    );
    await expect(notice.locator("#version")).toHaveText(version);
    for (const width of [320, 720]) {
      await notice.setViewportSize({ width, height: 850 });
      expect(
        await notice.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await notice.screenshot({
        path: testInfo.outputPath(`updates-${width}.png`),
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
    const closed = notice.waitForEvent("close");
    await notice.getByRole("button", { name: "확인 · 창 닫기" }).click();
    await closed;
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("a pending update badge becomes one panel notice and is cleared, never a new tab", async ({
  playwright,
}, testInfo) => {
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-badge-"));
  const extension = path.resolve(".output/chrome-mv3");
  const context = await playwright.chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--host-resolver-rules=MAP * ~NOTFOUND",
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    // Stand in for onInstalled after a version increase (unit-tested).
    await worker.evaluate(() => chrome.action.setBadgeText({ text: "NEW" }));
    const pages = context.pages().length;
    const errors: string[] = [];
    const panel = await context.newPage();
    panel.on("pageerror", (error) => errors.push(error.message));
    await panel.setViewportSize({ width: 360, height: 800 });
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    const notice = panel.getByRole("complementary", { name: "업데이트 안내" });
    await expect(notice).toContainText("버전으로 업데이트되었습니다.");
    expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe(
      "",
    );
    await panel.screenshot({
      path: testInfo.outputPath("panel-update-notice.png"),
      fullPage: true,
    });
    expect(
      await panel.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const opened = context.waitForEvent("page");
    await notice.getByRole("link", { name: "변경 사항 보기" }).click();
    expect((await opened).url()).toBe(`chrome-extension://${id}/updates.html`);
    await notice.getByRole("button", { name: "닫기" }).click();
    await expect(notice).toHaveCount(0);
    // A second panel does not repeat the notice once the badge was spent.
    const again = await context.newPage();
    await again.goto(`chrome-extension://${id}/sidepanel.html`);
    await expect(again.locator("main")).toBeVisible();
    await expect(
      again.getByRole("complementary", { name: "업데이트 안내" }),
    ).toHaveCount(0);
    // Only the panel pages and the user-opened notes page exist.
    expect(context.pages().length).toBe(pages + 3);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
