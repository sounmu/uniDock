import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";
import { playbackBuild } from "./build-shape";

test("course resource screens and main navigation share the assignment presentation", async ({ playwright }) => {
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-course-ui-"));
  const server = await syntheticServer(profile);
  const extension = path.resolve(".output/chrome-mv3");
  const baseline = process.env.UNIDOCK_UI_BASELINE === "1";
  const evidence = path.resolve(".omo/evidence/course-ui", baseline ? "before" : "after");
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
  try {
    const lms = await context.newPage();
    await lms.goto("https://mylms.korea.ac.kr");
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const panel = await context.newPage();
    const checkSelects = async () => {
      for (const select of await panel.locator("select:visible").all()) {
        await expect(select).toHaveCSS("appearance", "none");
        const arrow = await select.evaluate((element) => {
          const parent = element.parentElement;
          if (!parent) throw new Error("Missing select container");
          const style = getComputedStyle(parent, "::after");
          return { right: style.right, pointerEvents: style.pointerEvents };
        });
        expect(arrow).toEqual({ right: "12px", pointerEvents: "none" });
      }
    };
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await lms.bringToFront();
    await panel.getByRole("button", { name: "새로고침", exact: true }).click();
    await panel.getByRole("button", { name: /Synthetic Operating Systems/ }).click();
    await expect(panel.getByText("Synthetic Final Project", { exact: true })).toBeVisible();
    for (const [label, slug] of [["과제", "assignments"], ["녹화 강의", "recordings"], ["강의 자료", "materials"]] as const) {
      if (label !== "과제") await panel.getByRole("navigation", { name: "과목 메뉴" }).getByRole("button", { name: label, exact: true }).click();
      await expect(panel.locator(".list-row").first()).toBeVisible();
      for (const width of [320, 420]) {
        await panel.setViewportSize({ width, height: 800 });
        expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await panel.screenshot({ path: path.join(evidence, `${slug}-${width}.png`), fullPage: true });
      }
      if (!baseline) {
        const styles = await panel.evaluate(() => {
          const course = document.querySelector('[aria-label="과목 메뉴"]');
          const main = document.querySelector('[aria-label="주 메뉴"]');
          const selectedCourse = course?.querySelector('[aria-pressed="true"]');
          const selectedMain = main?.querySelector('[aria-current="page"]');
          if (!course || !main || !selectedCourse || !selectedMain) throw new Error("Missing navigation");
          const appearance = (element: Element) => {
            const css = getComputedStyle(element);
            return [css.backgroundColor, css.borderRadius, css.boxShadow];
          };
          return { course: appearance(course), main: appearance(main), courseSelected: appearance(selectedCourse), mainSelected: appearance(selectedMain) };
        });
        expect(styles.main).toEqual(styles.course);
        expect(styles.mainSelected).toEqual(styles.courseSelected);
        // The rounded button must not clip the bottom ink of long Korean
        // labels; the label span owns truncation within its rectangular box.
        for (const button of await panel.getByRole("navigation", { name: "주 메뉴" }).getByRole("button").all())
          await expect(button).toHaveCSS("overflow", "visible");
        await expect(panel.getByRole("button", { name: `${label} 새로고침`, exact: true })).toBeVisible();
        await expect(panel.locator(".assignment-freshness time")).toBeVisible();
        await panel.getByRole("button", { name: "보기 변경", exact: true }).click();
        const dialog = panel.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await checkSelects();
        for (const width of [320, 420]) {
          await panel.setViewportSize({ width, height: 800 });
          expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await panel.screenshot({ path: path.join(evidence, `${slug}-options-${width}.png`), fullPage: true });
        }
        await panel.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(panel.getByRole("button", { name: "보기 변경", exact: true })).toBeFocused();
      }
    }
    if (!baseline) {
      await lms.bringToFront();
      await panel.getByRole("button", { name: "할 일·일정", exact: true }).click();
      await expect(panel.getByText("조회 완료 · 3개 항목 · 한국 시간")).toBeVisible();
      await panel.locator("summary").filter({ hasText: "보기 설정" }).click();
      await panel.getByLabel("정렬", { exact: true }).selectOption("due-desc");
      await expect(panel.getByLabel("정렬", { exact: true })).toHaveValue("due-desc");
      await checkSelects();
      for (const width of [320, 420]) {
        await panel.setViewportSize({ width, height: 800 });
        await panel.screenshot({ path: path.join(evidence, `tasks-select-${width}.png`), fullPage: true });
      }
      if (playbackBuild()) {
        await lms.bringToFront();
        await panel.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "자동 재생", exact: true }).click();
        await panel.getByRole("button", { name: "영상 선택", exact: true }).click();
        await expect(panel.getByLabel("과목 선택")).toBeVisible();
        await checkSelects();
        for (const width of [320, 420]) {
          await panel.setViewportSize({ width, height: 800 });
          await panel.screenshot({ path: path.join(evidence, `playback-select-${width}.png`), fullPage: true });
        }
      }
    }
    await panel.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "설정", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "설정", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "설정", exact: true })).toHaveAttribute("aria-current", "page");
  } finally {
    await context.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
