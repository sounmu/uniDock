import { test, expect, type Locator } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";

test("interactive secondary controls use a neutral hover wash in both themes", async ({ playwright }) => {
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-hover-"));
  const server = await syntheticServer(profile);
  const extension = path.resolve(".output/chrome-mv3");
  const evidence = path.resolve(
    ".omo/evidence/neutral-hover",
    process.env.UNIDOCK_UI_BASELINE === "1" ? "before" : "after",
  );
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
    const checkHover = async (control: Locator, name: string) => {
      for (const colorScheme of ["light", "dark"] as const) {
        await panel.emulateMedia({ colorScheme });
        for (const width of [320, 390, 1440]) {
          await panel.setViewportSize({ width, height: 800 });
          await control.hover();
          await panel.screenshot({ path: path.join(evidence, `${name}-${colorScheme}-${width}.png`) });
          expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
        expect.soft(await control.evaluate((element) => getComputedStyle(element).backgroundColor))
          .toBe(colorScheme === "light" ? "rgba(0, 0, 0, 0.05)" : "rgba(255, 255, 255, 0.08)");
      }
    };
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await lms.bringToFront();
    await panel.getByRole("button", { name: "내 과목", exact: true }).click();
    await panel.getByRole("button", { name: /Synthetic Operating Systems/ }).click();
    await expect(panel.getByText("Synthetic Final Project", { exact: true })).toBeVisible();
    await checkHover(
      panel.getByRole("navigation", { name: "과목 메뉴" }).getByRole("button", { name: "녹화 강의", exact: true }),
      "tab",
    );
    await panel.getByRole("navigation", { name: "과목 메뉴" }).getByRole("button", { name: "녹화 강의", exact: true }).click();
    await checkHover(panel.locator(".row-action:not(:disabled)").first(), "row-action");
    await panel.getByRole("button", { name: "설정", exact: true }).click();
    await checkHover(panel.getByRole("link", { name: "개인정보 처리방침", exact: true }).first(), "settings-link");
  } finally {
    await context.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
