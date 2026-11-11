import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { playbackBuild, PLAYBACK_SKIP_REASON } from "./build-shape";

test("playback data deletion uses the settings action style and requires confirmation", async ({ playwright }) => {
  test.skip(!playbackBuild(), PLAYBACK_SKIP_REASON);
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-guidance-"));
  const extension = path.resolve(".output/chrome-mv3");
  const baseline = process.env.UNIDOCK_UI_BASELINE === "1";
  const evidence = path.resolve(".omo/evidence/playback-guidance", baseline ? "before" : "after");
  await mkdir(evidence, { recursive: true });
  const context = await playwright.chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      "--host-resolver-rules=MAP * ~NOTFOUND", "--no-proxy-server",
    ],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await panel.getByRole("button", { name: "자동 재생", exact: true }).click();
    await panel.getByText("안내 및 로컬 데이터", { exact: true }).click();
    const erase = panel.getByRole("button", { name: "로컬 데이터 모두 삭제", exact: true });
    for (const theme of ["light", "dark"] as const) {
      await panel.emulateMedia({ colorScheme: theme });
      for (const width of [320, 390, 1440]) {
        await panel.setViewportSize({ width, height: 900 });
        await erase.scrollIntoViewIfNeeded();
        if (!baseline) {
          await expect(erase).toHaveCSS("color", theme === "light" ? "rgb(180, 35, 24)" : "rgb(255, 154, 143)");
        }
        expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await panel.screenshot({ path: path.join(evidence, `${theme}-${width}.png`), fullPage: true });
        await erase.click();
        const confirm = panel.getByRole("button", { name: "삭제 확인", exact: true });
        if (!baseline) {
          await expect(erase).toHaveCount(0);
          await expect(confirm).toHaveCSS("color", theme === "light" ? "rgb(180, 35, 24)" : "rgb(255, 154, 143)");
        }
        await panel.screenshot({ path: path.join(evidence, `${theme}-${width}-confirm.png`), fullPage: true });
        await panel.getByRole("button", { name: "취소", exact: true }).click();
        await expect(erase).toBeVisible();
      }
    }
    if (!baseline) {
      await erase.click();
      await panel.getByRole("button", { name: "삭제 확인", exact: true }).click();
      await expect(panel.getByRole("button", { name: "삭제 확인", exact: true })).toHaveCount(0);
      await expect(erase).toBeVisible();
    }
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
