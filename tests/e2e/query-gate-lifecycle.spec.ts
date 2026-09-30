import { expect, test, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PLAYBACK_SKIP_REASON, playbackBuild } from "./build-shape";

const extensionPath = path.resolve(".output/chrome-mv3");

test.skip(!playbackBuild(), PLAYBACK_SKIP_REASON);
const origin = "https://mylms.korea.ac.kr";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accepted) => {
    resolve = accepted;
  });
  return { promise, resolve };
}

test("production panel drops cross-view query waiters and dispatches only the latest view", async ({
  playwright,
}) => {
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-query-gate-"));
  const assignmentStarted = deferred();
  const releaseAssignment = deferred();
  const apiRequests: string[] = [];
  let context: BrowserContext | undefined;

  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    await context.route(`${origin}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/api/v1/"))
        apiRequests.push(`${url.pathname}${url.search}`);

      const responses: Record<string, unknown> = {
        "/api/v1/users/self": { id: 71 },
        "/api/v1/courses": [{ id: 101, name: "Synthetic Operating Systems" }],
        "/api/v1/planner/items": [],
        "/api/v1/courses/101/modules": [
          {
            id: 20,
            name: "Week 1",
            published: true,
            items_count: 1,
            items: [
              {
                id: 501,
                type: "ExternalTool",
                title: "Synthetic Lecture",
                html_url: `${origin}/courses/101/modules/items/501`,
              },
            ],
          },
        ],
      };
      if (url.pathname === "/api/v1/courses/101/assignments") {
        assignmentStarted.resolve();
        await releaseAssignment.promise;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: [],
        });
        return;
      }
      if (url.pathname in responses) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: responses[url.pathname],
        });
        return;
      }
      if (url.pathname === "/") {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><title>Synthetic LMS</title><body>LMS</body></html>",
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });

    const lms = await context.newPage();
    await lms.goto(origin);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await lms.bringToFront();

    // Prime playback discovery so its recording-list request can wait behind
    // the held main-panel query without relying on stale UI state.
    expect(
      await panel.evaluate(() =>
        chrome.runtime.sendMessage({ version: 1, type: "PLAYBACK_REFRESH" }),
      ),
    ).toMatchObject({ status: "success" });
    const modulesBefore = apiRequests.filter((request) =>
      request.startsWith("/api/v1/courses/101/modules?"),
    ).length;

    await panel
      .getByRole("button", { name: "할 일·일정", exact: true })
      .click();
    await expect
      .poll(
        () =>
          apiRequests.filter((request) =>
            request.startsWith("/api/v1/courses/101/assignments?"),
          ).length,
      )
      .toBe(1);
    await assignmentStarted.promise;

    await panel.getByRole("button", { name: "자동 재생", exact: true }).click();
    await panel.getByRole("button", { name: "영상 선택", exact: true }).click();
    const modulesAfterPlaybackRefresh = apiRequests.filter((request) =>
      request.startsWith("/api/v1/courses/101/modules?"),
    ).length;
    expect(modulesAfterPlaybackRefresh).toBeGreaterThanOrEqual(modulesBefore);
    const coursesAfterPlaybackRefresh = apiRequests.filter((request) =>
      request.startsWith("/api/v1/courses?"),
    ).length;
    // The selector-bearing picker has its own COURSES_LIST request. It cannot
    // offer a recording selection until that request acquires the shared gate.
    // Do not await a missing option here: doing so reaches the transport's
    // bounded timeout and legitimately releases the original lease.
    await expect(panel.getByRole("combobox").locator("option")).toHaveCount(1);
    await panel
      .getByRole("button", { name: "할 일·일정", exact: true })
      .click();
    await panel.getByRole("button", { name: "일정", exact: true }).click();

    // No queued view may reach the LMS while the original response owns the gate.
    expect(
      apiRequests.filter((request) =>
        request.startsWith("/api/v1/planner/items"),
      ),
    ).toHaveLength(0);
    expect(
      apiRequests.filter((request) =>
        request.startsWith("/api/v1/courses/101/modules?"),
      ),
    ).toHaveLength(modulesAfterPlaybackRefresh);
    expect(
      apiRequests.filter((request) => request.startsWith("/api/v1/courses?")),
    ).toHaveLength(coursesAfterPlaybackRefresh);

    releaseAssignment.resolve();

    await expect(panel.getByRole("heading", { name: "일정" })).toBeVisible();
    await expect(panel.getByText("조회된 항목이 없습니다.")).toBeVisible();
    await expect
      .poll(
        () =>
          apiRequests.filter((request) =>
            request.startsWith("/api/v1/planner/items?"),
          ).length,
      )
      .toBe(1);
    expect(
      apiRequests.filter((request) =>
        request.startsWith("/api/v1/courses/101/modules?"),
      ),
    ).toHaveLength(modulesAfterPlaybackRefresh);
    expect(
      apiRequests.filter((request) => request.startsWith("/api/v1/courses?")),
    ).toHaveLength(coursesAfterPlaybackRefresh);
    await expect(
      panel.getByText(
        "이전 조회를 처리하고 있습니다. 잠시 후 다시 조회하세요.",
      ),
    ).toHaveCount(0);
    await expect(
      panel.getByText("녹화 후보를 불러오지 못했습니다."),
    ).toHaveCount(0);

    // A fresh request after the queue drains proves the shared gate was released.
    await panel.getByRole("button", { name: "내 과목", exact: true }).click();
    await expect(panel.getByText("조회 완료 · 1개 과목")).toBeVisible();
    const coursesBeforeRefresh = apiRequests.filter((request) =>
      request.startsWith("/api/v1/courses?"),
    ).length;
    await panel.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect(panel.getByText("조회 완료 · 1개 과목")).toBeVisible();
    await expect
      .poll(
        () =>
          apiRequests.filter((request) =>
            request.startsWith("/api/v1/courses?"),
          ).length,
      )
      .toBe(coursesBeforeRefresh + 1);
  } finally {
    releaseAssignment.resolve();
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
