import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";
import { playbackBuild, PLAYBACK_SKIP_REASON } from "./build-shape";

test("video selection keeps order through search and exposes its action bar while scrolling", async ({ playwright }) => {
  test.skip(!playbackBuild(), PLAYBACK_SKIP_REASON);
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-picker-"));
  const server = await syntheticServer(profile);
  const extension = path.resolve(".output/chrome-mv3");
  const baseline = process.env.UNIDOCK_UI_BASELINE === "1";
  const evidence = path.resolve(".omo/evidence/playback-selection", baseline ? "before" : "after");
  await mkdir(evidence, { recursive: true });
  const context = await playwright.chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, ignoreHTTPSErrors: true,
    reducedMotion: "reduce",
    args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      `--host-resolver-rules=MAP mylms.korea.ac.kr 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
      "--no-proxy-server", "--ignore-certificate-errors",
    ],
  });
  try {
    await context.route("**/api/v1/courses?*", (route) => route.fulfill({ json: [
      { id: 101, name: "262R (서울-학부)운영체제(영강)(Operating Systems)-00분반" },
      { id: 202, name: "자료구조" },
    ] }));
    await context.route("**/api/v1/courses/101/modules?*", (route) => route.fulfill({ json:
      Array.from({ length: 3 }, (_, week) => ({
        id: week + 1, name: `${week + 1}주차`, published: true, items_count: 6,
        items: Array.from({ length: 6 }, (_, index) => ({
          id: 1000 + week * 6 + index,
          type: "ExternalTool",
          title: `강의 ${week * 6 + index + 1} — ${index === 1 ? "스레드" : "프로세스"}의 이해`,
          html_url: `https://mylms.korea.ac.kr/courses/101/modules/items/${1000 + week * 6 + index}`,
        })),
      })),
    }));
    const lms = await context.newPage();
    await lms.goto("https://mylms.korea.ac.kr");
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await lms.bringToFront();
    await panel.getByRole("button", { name: "자동 재생", exact: true }).click();
    await panel.getByRole("button", { name: "영상 선택", exact: true }).click();
    await expect(panel.getByLabel("과목 선택").locator("option")).toHaveCount(3);
    await panel.getByLabel("과목 선택").selectOption({ index: 1 });
    const picker = panel.locator(".detail-view");
    await expect(picker.getByRole("checkbox")).toHaveCount(18);
    await picker.getByRole("checkbox", { name: /강의 1 —/ }).check();
    await picker.getByRole("checkbox", { name: /강의 18 —/ }).check();
    if (!baseline) {
      const search = picker.getByRole("searchbox", { name: "강의 검색" });
      expect(await search.count()).toBe(1);
      await expect(panel.getByLabel("과목 선택").locator("option:checked")).toHaveText("운영체제");
      await search.fill("스레드");
      await expect(picker.getByRole("checkbox")).toHaveCount(3);
      await picker.getByRole("checkbox", { name: /강의 2 —/ }).check();
      await search.fill("검색 결과 없는 제목");
      await expect(picker.getByText("검색 결과가 없습니다.")).toBeVisible();
      await expect(picker.getByRole("status")).toContainText("3개 선택");
      await search.fill("");
      await expect(picker.getByRole("heading", { level: 3 })).toHaveText(["1주차", "2주차", "3주차"]);
      for (const [number, order] of [[1, "1"], [18, "2"], [2, "3"]] as const) {
        const checkbox = picker.getByRole("checkbox", { name: new RegExp(`강의 ${number} —`) });
        await expect(checkbox).toBeChecked();
        await expect(checkbox.locator("..").locator(".playback-order")).toHaveText(order);
      }
    }
    for (const colorScheme of ["light", "dark"] as const) {
      await panel.emulateMedia({ colorScheme });
      for (const width of [320, 390, 1440]) {
        await panel.setViewportSize({ width, height: 800 });
        for (const position of ["top", "bottom"] as const) {
          await panel.evaluate((end) => window.scrollTo(0, end ? document.body.scrollHeight : 0), position === "bottom");
          expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          if (!baseline) {
            const bar = await picker.locator(".playback-selection-actions").boundingBox();
            const rail = await panel.locator(".rail").boundingBox();
            expect(bar).not.toBeNull();
            expect(rail).not.toBeNull();
            if (bar && rail) {
              expect(bar.y).toBeGreaterThanOrEqual(0);
              expect(bar.y + bar.height).toBeLessThan(rail.y);
            }
            await expect(picker.getByRole("button", { name: "자동 재생", exact: true })).toBeInViewport();
          }
          await panel.screenshot({ path: path.join(evidence, `${colorScheme}-${width}-${position}.png`) });
        }
      }
    }
    if (!baseline) {
      await picker.getByRole("button", { name: "영상 불러오기" }).click();
      await expect(picker.getByRole("checkbox", { checked: true })).toHaveCount(0);
      await expect(picker.getByRole("button", { name: "자동 재생", exact: true })).toBeDisabled();
    }
  } finally {
    await context.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
