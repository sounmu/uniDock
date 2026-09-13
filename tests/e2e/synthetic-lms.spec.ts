import { expect, test } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext } from "@playwright/test";

const extensionPath = path.resolve(".output/chrome-mv3");
const lmsOrigin = "https://mylms.korea.ac.kr";

test("loads the production MV3 and queries a synthetic LMS through real runtime messaging", async ({
  playwright,
}, testInfo) => {
  // Given: a production extension build and an isolated Chromium profile.
  await stat(path.join(extensionPath, "manifest.json"));
  const profileDirectory = await mkdtemp(
    path.join(tmpdir(), "unidock-playwright-"),
  );
  const sidepanelScreenshot = testInfo.outputPath("sidepanel-courses.png");
  const deadlineScreenshot = testInfo.outputPath("sidepanel-deadlines.png");
  const todoScreenshot = testInfo.outputPath("sidepanel-todo.png");
  const lmsScreenshot = testInfo.outputPath("synthetic-lms.png");
  const tracePath = testInfo.outputPath("runtime-messaging-trace.zip");
  let context: BrowserContext | undefined;
  let tracingStarted = false;
  let coursesRequestSeen = false;

  try {
    context = await playwright.chromium.launchPersistentContext(
      profileDirectory,
      {
        channel: "chromium",
        headless: true,
        viewport: { width: 1280, height: 800 },
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
        ],
      },
    );
    await context.tracing.start({ screenshots: true, snapshots: true });
    tracingStarted = true;

    const lmsPage = await context.newPage();
    await lmsPage.route(`${lmsOrigin}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: '<!doctype html><html lang="en"><title>Synthetic LMS</title><body><main><h1>Synthetic LMS</h1><p>Browser fixture for uniDock.</p></main></body></html>',
        });
        return;
      }
      if (
        url.pathname === "/api/v1/courses" &&
        url.searchParams.get("per_page") === "100" &&
        url.searchParams.get("enrollment_state") === "active"
      ) {
        coursesRequestSeen = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            { id: 101, name: "Synthetic Operating Systems" },
          ]),
        });
        return;
      }
      if (url.pathname === "/api/v1/courses/101/assignments") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              name: "Synthetic Final Project",
              due_at: "2099-09-20T14:00:00+09:00",
              published: true,
              locked_for_user: false,
              submission: {
                workflow_state: "unsubmitted",
                submitted_at: null,
                missing: false,
                late: false,
              },
            },
          ]),
        });
        return;
      }
      if (url.pathname === "/api/v1/users/self/todo") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            {
              type: "submitting",
              context_name: "Synthetic Operating Systems",
              assignment: {
                name: "Synthetic Todo With Ignore URL",
                due_at: "2099-09-20T14:00:00+09:00",
              },
              ignore: `${lmsOrigin}/api/v1/users/self/todo/assignment_123/ignore`,
            },
          ]),
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });
    await lmsPage.goto(`${lmsOrigin}/`);
    await expect(
      lmsPage.getByRole("heading", { name: "Synthetic LMS" }),
    ).toBeVisible();

    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(serviceWorker.url()).host;
    expect(extensionId).not.toBe("");

    const sidepanelPage = await context.newPage();
    await sidepanelPage.goto(
      `chrome-extension://${extensionId}/sidepanel.html`,
    );
    await expect(
      sidepanelPage.getByRole("heading", { name: "내 과목", exact: true }),
    ).toBeVisible();

    // When: the real side-panel UI sends through chrome.tabs to the real content script.
    await lmsPage.bringToFront();
    await sidepanelPage.getByRole("button", { name: "조회" }).click();

    // Then: the content script fetches the fixture and the panel renders its response.
    await expect(sidepanelPage.getByText("조회 완료 · 1개 과목")).toBeVisible();
    await expect(
      sidepanelPage.getByText("Synthetic Operating Systems"),
    ).toBeVisible();
    expect(coursesRequestSeen).toBe(true);

    await sidepanelPage.screenshot({
      path: sidepanelScreenshot,
      fullPage: true,
    });
    await lmsPage.screenshot({ path: lmsScreenshot, fullPage: true });
    await testInfo.attach("sidepanel-courses", {
      path: sidepanelScreenshot,
      contentType: "image/png",
    });

    await sidepanelPage.getByRole("button", { name: "과제 보기" }).click();
    await expect(
      sidepanelPage.getByText("Synthetic Final Project"),
    ).toBeVisible();
    await sidepanelPage.getByRole("button", { name: "마감일" }).click();
    await expect(
      sidepanelPage.getByRole("checkbox", { name: "남은 과제 후보만" }),
    ).toBeChecked();
    await expect(
      sidepanelPage.getByRole("combobox", { name: "마감 기간" }),
    ).toHaveValue("all");
    await expect(
      sidepanelPage.getByRole("combobox", { name: "정렬" }),
    ).toHaveValue("original");
    await expect(
      sidepanelPage.getByText("조회 완료 · 1개 항목 중 1개 표시"),
    ).toBeVisible();
    await sidepanelPage.screenshot({
      path: deadlineScreenshot,
      fullPage: true,
    });
    await testInfo.attach("sidepanel-deadlines", {
      path: deadlineScreenshot,
      contentType: "image/png",
    });

    await sidepanelPage.getByRole("button", { name: "Todo" }).click();
    await expect(
      sidepanelPage.getByText("Synthetic Todo With Ignore URL"),
    ).toBeVisible();
    await expect(
      sidepanelPage.getByText("조회 완료 · 1개 항목 · 한국 시간"),
    ).toBeVisible();
    await expect(
      sidepanelPage.getByText("숨김 표시됨 · submitting"),
    ).toBeVisible();
    await sidepanelPage.screenshot({ path: todoScreenshot, fullPage: true });
    await testInfo.attach("sidepanel-todo", {
      path: todoScreenshot,
      contentType: "image/png",
    });
    await testInfo.attach("synthetic-lms", {
      path: lmsScreenshot,
      contentType: "image/png",
    });
  } finally {
    if (context && tracingStarted) {
      await context.tracing.stop({ path: tracePath });
    }
    if (context) await context.close();
    await rm(profileDirectory, { recursive: true, force: true });
  }
});
