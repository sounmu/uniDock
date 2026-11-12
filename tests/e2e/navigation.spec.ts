import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";
import { playbackBuild } from "./build-shape";

test("Home and course tools return to their source while main destinations remain reachable", async ({ playwright }) => {
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-navigation-"));
  const server = await syntheticServer(profile);
  const extension = path.resolve(".output/chrome-mv3");
  const evidence = path.resolve(".omo/evidence/navigation/after");
  const collector = process.env.UNIDOCK_UI_SNAPSHOT_SCRIPT
    ? await readFile(process.env.UNIDOCK_UI_SNAPSHOT_SCRIPT, "utf8") : null;
  await mkdir(evidence, { recursive: true });
  const context = await playwright.chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, ignoreHTTPSErrors: true,
    colorScheme: "light", reducedMotion: "reduce",
    args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      `--host-resolver-rules=MAP mylms.korea.ac.kr 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
      "--no-proxy-server", "--ignore-certificate-errors",
    ],
  });
  const capture = async (page: Page, name: string) => {
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (name === "home-summary") {
        await expect(page.locator(".home-due")).toHaveCount(2);
        expect(await page.locator(".home-due").evaluateAll((dates) => dates.every((date) => {
          const box = date.getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth && date.scrollWidth <= date.clientWidth;
        }))).toBe(true);
      }
      const navigation = page.getByRole("navigation", { name: "주 메뉴" });
      await expect(navigation.getByRole("button")).toHaveCount(4);
      for (const button of await navigation.getByRole("button").all()) {
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        if (box) {
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.y + box.height).toBeLessThanOrEqual(800);
        }
      }
      await page.screenshot({ path: path.join(evidence, `${name}-${width}.png`), fullPage: true });
      if (collector) {
        const snapshot: unknown = await page.evaluate(collector);
        await writeFile(path.join(evidence, `${name}-${width}.json`), JSON.stringify(snapshot));
      }
    }
  };
  try {
    const lms = await context.newPage();
    await lms.goto("https://mylms.korea.ac.kr");
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await lms.bringToFront();
    const navigation = panel.getByRole("navigation", { name: "주 메뉴" });
    await expect(navigation.getByRole("button", { name: "홈", exact: true })).toHaveAttribute("aria-current", "page");
    await capture(panel, "home-idle");
    await panel.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect(panel.getByText("Synthetic Early Deadline", { exact: true })).toBeVisible();
    await capture(panel, "home-summary");
    await panel.getByRole("button", { name: /Synthetic Early Deadline/ }).click();
    await expect(panel.getByRole("heading", { name: "Synthetic Early Deadline", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "← 목록", exact: true }).click();

    await navigation.getByRole("button", { name: "내 과목", exact: true }).click();
    await expect(panel.getByText("조회 완료 · 2개 과목")).toBeVisible();
    await capture(panel, "courses");
    await panel.getByRole("button", { name: /Synthetic Operating Systems/ }).click();
    await panel.getByRole("button", { name: "녹화 강의", exact: true }).click();
    await panel.getByRole("button", { name: /Synthetic Lecture A/, exact: false }).first().click();
    const recording = panel.locator(".detail-view").filter({ has: panel.getByRole("heading", { name: "Synthetic Lecture A", exact: true }) });
    await expect(recording).toBeVisible();
    await capture(panel, "recording-detail");
    if (playbackBuild()) {
      const entry = recording.getByRole("button", { name: "자동 재생", exact: true });
      await entry.click();
      const picker = panel.locator(".playback-panel");
      await expect(picker.getByRole("checkbox", { name: /Synthetic Lecture A/ })).toBeChecked();
      await capture(panel, "playback-entry");
      await picker.getByRole("button", { name: "← 목록", exact: true }).click();
      await picker.getByRole("button", { name: "영상 선택", exact: true }).click();
      await expect(picker.getByLabel("과목 선택").locator("option")).toHaveCount(3);
      await picker.getByLabel("과목 선택").selectOption({ index: 2 });
      await expect(picker.getByRole("button", { name: "영상 불러오기", exact: true })).toBeEnabled();
      await expect(picker.getByRole("checkbox")).toHaveCount(0);
      await panel.getByRole("button", { name: "← 돌아가기", exact: true }).click();
      await expect(recording).toBeVisible();
      await expect(entry).toBeFocused();
      await expect(entry).toHaveAttribute("aria-disabled", "true");
      await panel.getByRole("button", { name: "녹화 강의 새로고침" }).click();
      await panel.getByRole("button", { name: /Synthetic Lecture A/ }).first().click();
    } else {
      await expect(recording.getByRole("button", { name: "자동 재생", exact: true })).toHaveCount(0);
    }
    const opened = context.waitForEvent("page");
    await recording.getByRole("button", { name: "강의 열고 자막 추출", exact: true }).click();
    const lecture = await opened;
    await lecture.waitForLoadState("domcontentloaded");
    expect(lecture.url()).toBe("https://mylms.korea.ac.kr/courses/101/modules/items/902");
    await expect(panel.getByRole("button", { name: "자막 감지", exact: true })).toBeVisible();
    await expect(panel.getByRole("status")).toContainText("Synthetic Lecture A");
    await capture(panel, "captions-entry");
    await panel.getByRole("button", { name: "← 돌아가기", exact: true }).click();
    await expect(recording).toBeVisible();
    await lecture.close();
    await lms.bringToFront();

    await navigation.getByRole("button", { name: "일정", exact: true }).click();
    await expect(panel.getByText("Synthetic Undated Reading", { exact: true })).toBeVisible();
    await capture(panel, "tasks");
    await panel.getByRole("button", { name: "일정 목록 보기", exact: true }).click();
    await expect(panel.getByText("조회된 항목이 없습니다.")).toBeVisible();
    await capture(panel, "schedule");
    await navigation.getByRole("button", { name: "설정", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "설정", exact: true })).toBeVisible();
    await capture(panel, "settings");
    await panel.getByRole("button", { name: "← 돌아가기", exact: true }).click();
    await expect(navigation.getByRole("button", { name: "일정", exact: true })).toHaveAttribute("aria-current", "page");

    await navigation.getByRole("button", { name: "홈", exact: true }).click();
    const captionsEntry = panel.getByRole("button", { name: "자막 추출", exact: true });
    await captionsEntry.focus();
    await panel.keyboard.press("Enter");
    await expect(panel.getByRole("button", { name: "자막 감지", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "← 돌아가기", exact: true }).click();
    await expect(captionsEntry).toBeFocused();
  } finally {
    await context.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
