import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";

test("shows weekly and board materials of every format as one list in the production panel", async ({
  playwright,
}, testInfo) => {
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-formats-"));
  const server = await syntheticServer(profile);
  const extension = path.resolve(".output/chrome-mv3");
  const context = await playwright.chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--host-resolver-rules=MAP mylms.korea.ac.kr 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
    ],
  });
  try {
    await context.route("**/api/v1/courses/101/discussion_topics?*", (route) =>
      route.fulfill({
        json: new URL(route.request().url()).searchParams.has(
          "only_announcements",
        )
          ? []
          : [
              {
                id: 7,
                title: "수업 자료 게시판",
                attachments: [
                  { id: 501, filename: "긴 제목의 수업 발표 자료.pptx" },
                  { id: 502, filename: "이전 수업 자료.ppt" },
                ],
              },
            ],
      }),
    );
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const errors: string[] = [];
    worker.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const lms = await context.newPage();
    await lms.goto("https://mylms.korea.ac.kr/");
    const panel = await context.newPage();
    panel.on("pageerror", (error) => errors.push(error.message));
    await panel.goto(
      `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
    );
    await lms.bringToFront();
    await panel.getByRole("button", { name: "내 과목", exact: true }).click();
    await panel
      .getByRole("button", { name: /Synthetic Operating Systems/ })
      .click();
    await panel.getByRole("button", { name: "강의 자료", exact: true }).click();
    await expect(
      panel.getByRole("heading", { name: "강의 자료 · 4개", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("heading", { name: "게시판 · 수업 자료 게시판" }),
    ).toBeVisible();
    for (const width of [320, 420]) {
      await panel.setViewportSize({ width, height: 800 });
      expect(
        await panel.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await panel.screenshot({
        path: testInfo.outputPath(`materials-${width}.png`),
        fullPage: true,
      });
    }
    // Formats are one "강의 자료" list: no format filter or per-row format label.
    await expect(panel.getByLabel("파일 형식")).toHaveCount(0);
    await expect(panel.locator(".file-format")).toHaveCount(0);
    await panel
      .getByRole("checkbox", { name: "전체 선택", exact: true })
      .check();
    await expect(
      panel.getByRole("button", { name: "선택 다운로드 (4)" }),
    ).toBeEnabled();
    await panel
      .getByRole("checkbox", { name: "전체 선택", exact: true })
      .uncheck();
    await panel.getByRole("button", { name: /이전 수업 자료.ppt/ }).click();
    await expect(
      panel.getByRole("heading", { name: "이전 수업 자료.ppt", exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "이 자료 다운로드" }),
    ).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
