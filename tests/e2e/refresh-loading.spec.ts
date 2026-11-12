import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";

test("list loading keeps placeholders and accessible icon refresh controls", async ({ playwright }) => {
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-refresh-"));
  const server = await syntheticServer(profile);
  const extension = path.resolve(".output/chrome-mv3");
  const evidence = path.resolve(".omo/evidence/refresh-loading");
  await mkdir(evidence, { recursive: true });
  const context = await playwright.chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    reducedMotion: "reduce",
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--host-resolver-rules=MAP mylms.korea.ac.kr 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  try {
    const lms = await context.newPage();
    await lms.goto("https://mylms.korea.ac.kr");
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await lms.bringToFront();

    for (const screen of ["courses", "assignments", "recordings", "materials", "tasks"] as const) {
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      await context.route("**/api/**", async (route) => {
        await held;
        await route.continue();
      });
      try {
        if (screen === "courses") {
          await panel.getByRole("button", { name: "내 과목", exact: true }).click();
        } else if (screen === "assignments") {
          await panel.getByRole("button", { name: /Synthetic Operating Systems/ }).click();
        } else if (screen === "tasks") {
          await lms.bringToFront();
          await panel.getByRole("button", { name: "일정", exact: true }).click();
        } else {
          await panel.getByRole("navigation", { name: "과목 메뉴" })
            .getByRole("button", { name: screen === "recordings" ? "녹화 강의" : "강의 자료", exact: true }).click();
        }
        const rows = panel.locator(".skeleton-row");
        await expect(rows).toHaveCount(6);
        const refresh = panel.getByRole("button", { name: /새로고침$/ });
        for (const colorScheme of ["light", "dark"] as const) {
          await panel.emulateMedia({ colorScheme });
          for (const width of [320, 390, 1440]) {
            await panel.setViewportSize({ width, height: 800 });
            await panel.screenshot({ path: path.join(evidence, `${screen}-${colorScheme}-${width}.png`) });
            expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          }
          expect.soft(await refresh.evaluate((element) => getComputedStyle(element).color))
            .toBe(colorScheme === "light" ? "rgb(92, 92, 98)" : "rgb(169, 169, 176)");
        }
        expect(await panel.getByText("목록을 불러오고 있습니다…", { exact: true }).count()).toBe(0);
        await expect(rows.locator("..")).toHaveAttribute("aria-hidden", "true");
        await expect(refresh).toHaveAttribute("aria-busy", "true");
        await expect(refresh).toHaveAttribute("aria-disabled", "true");
        await expect(refresh).toHaveText("");
        await expect(refresh.locator("svg")).toBeVisible();
        await expect(refresh.locator("svg")).toHaveCSS("animation-name", "none");
      } finally {
        release();
      }
      await expect(panel.locator(".skeleton-row")).toHaveCount(0);
      await context.unroute("**/api/**");
      await expect(panel.getByRole("button", { name: /새로고침$/ })).toHaveAttribute("aria-busy", "false");
    }
  } finally {
    await context.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
