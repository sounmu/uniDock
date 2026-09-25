import { expect, test } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext } from "@playwright/test";

const extensionPath = path.resolve(".output/chrome-mv3");
const lmsOrigin = "https://mylms.korea.ac.kr";

test("production extension merges announcement dates and saves calendar corrections", async ({
  playwright,
}, testInfo) => {
  test.setTimeout(120_000);
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-calendar-"));
  let context: BrowserContext | undefined;
  const requests: string[] = [];
  let dense = false;
  let failAnnouncements = false;
  let revised = false;
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: process.env.CI === "true",
      viewport: { width: 375, height: 760 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    await context.route(`${lmsOrigin}/**`, async (route) => {
      const url = new URL(route.request().url());
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/") {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><title>Synthetic LMS</title><body><h1>Synthetic LMS</h1></body></html>",
        });
        return;
      }
      const data: Record<string, unknown> = {
        "/api/v1/users/self": { id: 71 },
        "/api/v1/courses": [
          { id: 101, name: "운영체제" },
          { id: 202, name: "법학" },
        ],
        "/api/v1/courses/101/modules": [],
        "/api/v1/courses/202/modules": [],
        "/api/v1/courses/101/assignments": [
          {
            id: 81,
            name: "정규 과제",
            due_at: "2026-10-07T18:00:00+09:00",
            html_url: `${lmsOrigin}/courses/101/assignments/81`,
          },
        ],
        "/api/v1/planner/items": [],
        "/api/v1/courses/202/assignments": [
          {
            id: 92,
            name: "법학 과제",
            due_at: "2026-10-09T17:00:00+09:00",
          },
        ],
        "/api/v1/announcements": [
          {
            id: 17,
            context_code: "course_101",
            title: "중간고사 및 보고서",
            message:
              "<p>2026년 10월 7일 14시 중간고사</p><p>보고서는 2026년 10월 9일 23:59까지 제출</p>",
            posted_at: "2026-09-15T09:00:00+09:00",
            html_url: `${lmsOrigin}/courses/101/discussion_topics/17`,
          },
        ],
      };
      if (
        url.pathname === "/api/v1/announcements" &&
        url.searchParams.get("context_codes[]") === "course_202"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
        return;
      }
      if (url.pathname === "/api/v1/announcements" && failAnnouncements) {
        await route.fulfill({ status: 503, body: "fixture unavailable" });
        return;
      }
      if (url.pathname === "/api/v1/announcements" && revised) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              id: 18,
              context_code: "course_101",
              title: "중간고사 일정 변경",
              message: "<p>2026년 10월 7일 14시 중간고사 일정 변경</p>",
              posted_at: "2026-09-16T09:00:00+09:00",
            },
          ]),
        });
        return;
      }
      if (url.pathname === "/api/v1/announcements" && dense) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            Array.from({ length: 14 }, (_, index) => ({
              id: 100 + index,
              context_code: "course_101",
              title: `긴 한국어 제목 ${index + 1}`,
              message: `<p>2026년 10월 7일 ${index + 1}시 운영체제 실습 결과 보고서를 확인하고 제출하세요</p>`,
              posted_at: "2026-09-15T09:00:00+09:00",
            })),
          ),
        });
        return;
      }
      if (url.pathname in data) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(data[url.pathname]),
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });

    const lms = await context.newPage();
    await lms.goto(lmsOrigin);
    await expect(
      lms.getByRole("heading", { name: "Synthetic LMS" }),
    ).toBeVisible();
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await lms.bringToFront();
    await panel.getByRole("button", { name: "전체 일정" }).click();
    await panel.getByRole("button", { name: "다음 달" }).click();
    await expect(
      panel.getByRole("grid", { name: "2026년 10월" }),
    ).toBeVisible();
    await panel.getByRole("gridcell", { name: "7일 2건" }).click();
    await expect(
      panel.getByText("중간고사", { exact: false }).first(),
    ).toBeVisible();
    await expect(
      panel.getByText("정규 과제", { exact: false }).first(),
    ).toBeVisible();
    const source = panel.locator(".day-details .event-card").filter({
      hasText: "중간고사",
    });
    await expect(source.getByText("근거:", { exact: false })).toContainText(
      "10월 7일 14시 중간고사",
    );
    await expect(source.locator("a.item-title-link")).toHaveAttribute(
      "href",
      `${lmsOrigin}/courses/101/discussion_topics/17`,
    );
    await panel.screenshot({
      path: testInfo.outputPath("calendar-375.png"),
      fullPage: true,
    });

    await source.getByRole("button", { name: "수정" }).click();
    await source.getByLabel("날짜").fill("2026-10-08");
    await source.getByRole("button", { name: "확인" }).click();
    await panel.getByRole("button", { name: "목록" }).click();
    await expect(
      panel.locator(".event-card").filter({ hasText: "중간고사" }),
    ).toContainText("2026-10-08");
    await panel
      .locator(".event-card")
      .filter({ hasText: "중간고사" })
      .getByRole("button", { name: "제외" })
      .click();
    await expect(panel.getByText("제외된 항목 (1건)")).toBeVisible();
    await panel.screenshot({
      path: testInfo.outputPath("calendar-edited-excluded.png"),
      fullPage: true,
    });
    await panel.reload();
    await lms.bringToFront();
    await panel.getByRole("button", { name: "전체 일정" }).click();
    await panel.getByRole("button", { name: "다음 달" }).click();
    await panel.getByRole("button", { name: "목록" }).click();
    await expect(panel.getByText("제외된 항목 (1건)")).toBeVisible();
    revised = true;
    await panel.getByRole("button", { name: "새로고침" }).click();
    await expect(panel.locator('[role="status"] li')).toHaveCount(1);
    await panel.screenshot({
      path: testInfo.outputPath("calendar-changed-source-review.png"),
      fullPage: true,
    });
    revised = false;
    await panel.getByRole("button", { name: "새로고침" }).click();
    await expect(panel.getByText("제외된 항목 (1건)")).toBeVisible();
    await panel.getByRole("combobox", { name: "과목" }).selectOption({
      label: "운영체제",
    });
    await expect(
      panel.locator(".event-card").filter({ hasText: "법학 과제" }),
    ).toHaveCount(0);
    await panel.getByRole("combobox", { name: "과목" }).selectOption("");
    await expect(
      panel.locator(".event-card").filter({ hasText: "법학 과제" }),
    ).toHaveCount(1);
    await panel.getByRole("button", { name: "달력" }).click();
    await panel.getByRole("button", { name: "이전 달" }).click();
    await panel.getByRole("gridcell", { name: "15일" }).click();
    await expect(panel.getByText("이 날짜에 일정이 없습니다.")).toBeVisible();
    await panel.setViewportSize({ width: 320, height: 700 });
    await expect(panel.locator("html")).toHaveJSProperty("scrollWidth", 320);
    await panel.screenshot({
      path: testInfo.outputPath("calendar-empty-320.png"),
      fullPage: true,
    });
    await panel.getByRole("button", { name: "다음 달" }).focus();
    await panel.keyboard.press("Tab");
    await expect(
      panel.getByRole("textbox", { name: "공지 게시 시작일" }),
    ).toBeFocused();
    await panel.screenshot({
      path: testInfo.outputPath("calendar-keyboard-focus-320.png"),
      fullPage: true,
    });

    dense = true;
    await panel.getByRole("button", { name: "다음 달" }).click();
    await panel.getByRole("button", { name: "새로고침" }).click();
    await expect(
      panel.getByRole("gridcell", { name: "7일 15건" }),
    ).toBeVisible();
    await panel.getByRole("gridcell", { name: "7일 15건" }).click();
    await panel.screenshot({
      path: testInfo.outputPath("calendar-dense-320.png"),
      fullPage: true,
    });
    await panel.setViewportSize({ width: 480, height: 760 });
    await panel.screenshot({
      path: testInfo.outputPath("calendar-dense-480.png"),
      fullPage: true,
    });
    await panel.setViewportSize({ width: 188, height: 700 });
    await panel.screenshot({
      path: testInfo.outputPath("calendar-200pct-equivalent.png"),
      fullPage: true,
    });
    failAnnouncements = true;
    await panel.getByRole("button", { name: "새로고침" }).click();
    await expect(panel.locator(".calendar-panel .notice.error")).toBeVisible();
    await panel.screenshot({
      path: testInfo.outputPath("calendar-error.png"),
      fullPage: true,
    });
    expect(
      requests.some((url) => url.startsWith("/api/v1/announcements?")),
    ).toBe(true);
    expect(
      requests.some((url) =>
        url.startsWith("/api/v1/courses/101/assignments?"),
      ),
    ).toBe(true);
    await testInfo.attach("calendar-action-log", {
      body: Buffer.from(requests.join("\n")),
      contentType: "text/plain",
    });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
