import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PLAYBACK_SKIP_REASON, playbackBuild } from "./build-shape";

const extensionPath = path.resolve(".output/chrome-mv3");

test.skip(!playbackBuild(), PLAYBACK_SKIP_REASON);
const origin = "https://mylms.korea.ac.kr";
const salt = "1".repeat(64);
const accountKey = createHash("sha256")
  .update(`unidock-playback-v1\0${salt}\0${origin}\0${71}`)
  .digest("hex");
const pausedState = {
  version: 2,
  accountKey,
  origin,
  playlist: [{ id: "101:501", courseId: "101" }],
  player: null,
  stopped: true,
};

async function seedPausedState(context: BrowserContext, extensionId: string) {
  const storagePage = await context.newPage();
  await storagePage.goto(`chrome-extension://${extensionId}/privacy.html`);
  await storagePage.evaluate(
    ({ state, knownSalt }) =>
      chrome.storage.local.set({
        "unidock.playback.v2": state,
        "unidock.playback.salt": knownSalt,
      }),
    { state: pausedState, knownSalt: salt },
  );
  await storagePage.close();
}

async function openPanels(context: BrowserContext, extensionId: string) {
  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([
    first.goto(`chrome-extension://${extensionId}/sidepanel.html`),
    second.goto(`chrome-extension://${extensionId}/sidepanel.html`),
  ]);
  await Promise.all(
    [first, second].map((panel) =>
      panel.getByRole("button", { name: "자동 재생" }).click(),
    ),
  );
  await Promise.all(
    [first, second].map((panel) =>
      expect(panel.locator(".playback-panel h1")).toContainText("일시정지"),
    ),
  );
  return [first, second] as const;
}

async function expectStatus(panels: readonly Page[], value: string) {
  await Promise.all(
    panels.map((panel) =>
      expect(panel.locator(".playback-panel h1")).toContainText(value),
    ),
  );
}

async function observeTabRemoval(worker: import("@playwright/test").Worker) {
  await worker.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __panelSyncRemoved?: number;
    };
    scope.__panelSyncRemoved = 0;
    chrome.tabs.onRemoved.addListener(() => {
      scope.__panelSyncRemoved = (scope.__panelSyncRemoved ?? 0) + 1;
    });
  });
}

async function tabEvidence(worker: import("@playwright/test").Worker) {
  return worker.evaluate(async () => ({
    player: (await chrome.tabs.query({})).some((tab) =>
      /\/courses\/101\/modules\/items\//.test(tab.url ?? ""),
    ),
    removed:
      (
        globalThis as typeof globalThis & {
          __panelSyncRemoved?: number;
        }
      ).__panelSyncRemoved ?? 0,
  }));
}

test("two production panels converge after no-tab stop and local deletion without STATUS discovery", async ({
  playwright,
}) => {
  test.setTimeout(90_000);
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-panel-sync-"));
  let context: BrowserContext | undefined;
  let apiRequests = 0;
  try {
    const launch = async () => {
      const launched = await playwright.chromium.launchPersistentContext(
        profile,
        {
          channel: "chromium",
          headless: process.env.CI === "true",
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
          ],
        },
      );
      await launched.route(`${origin}/**`, async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith("/api/v1/")) apiRequests++;
        const values: Record<string, unknown> = {
          "/api/v1/users/self": { id: 71 },
          "/api/v1/courses": [{ id: 101, name: "합성 운영체제" }],
          "/api/v1/courses/101/assignments": [],
          "/api/v1/planner/items": [],
          "/api/v1/courses/101/modules": [
            {
              id: 20,
              name: "1주차",
              published: true,
              items_count: 1,
              items: [
                {
                  id: 501,
                  type: "ExternalTool",
                  title: "합성 영상",
                  html_url: `${origin}/courses/101/modules/items/501`,
                },
              ],
            },
          ],
        };
        if (url.pathname in values) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            json: values[url.pathname],
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><body>Synthetic LMS</body></html>",
        });
      });
      return launched;
    };

    context = await launch();

    const lms = await context.newPage();
    await lms.goto(origin);
    let worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    let extensionId = new URL(worker.url()).host;

    await seedPausedState(context, extensionId);
    await context.close();
    context = await launch();
    const restoredLms = await context.newPage();
    await restoredLms.goto(origin);
    worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    extensionId = new URL(worker.url()).host;
    let panels = await openPanels(context, extensionId);
    await expect.poll(() => apiRequests).toBeGreaterThan(0);
    await Promise.all(
      panels.map((panel) =>
        expect(panel.locator(".playback-panel")).toHaveAttribute(
          "aria-busy",
          "false",
        ),
      ),
    );
    apiRequests = 0; // Initial REFRESH establishes the account; notifications use STATUS.
    await observeTabRemoval(worker);
    expect(await tabEvidence(worker)).toEqual({ player: false, removed: 0 });
    await panels[0].getByRole("button", { name: "자동 재생 끄기" }).click();
    await expectStatus(panels, "중지됨");
    expect(apiRequests).toBe(0);
    expect(await tabEvidence(worker)).toEqual({ player: false, removed: 0 });

    await seedPausedState(context, extensionId);
    await context.close();
    context = await launch();
    const secondLms = await context.newPage();
    await secondLms.goto(origin);
    worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    extensionId = new URL(worker.url()).host;
    panels = await openPanels(context, extensionId);
    await expect.poll(() => apiRequests).toBeGreaterThan(0);
    await Promise.all(
      panels.map((panel) =>
        expect(panel.locator(".playback-panel")).toHaveAttribute(
          "aria-busy",
          "false",
        ),
      ),
    );
    apiRequests = 0;
    await observeTabRemoval(worker);
    expect(await tabEvidence(worker)).toEqual({ player: false, removed: 0 });
    await panels[0].getByText("안내 및 로컬 데이터").click();
    await panels[0]
      .getByRole("button", { name: "로컬 데이터 모두 삭제" })
      .click();
    await panels[0].getByRole("button", { name: "삭제 확인" }).click();
    await expectStatus(panels, "대기");
    expect(apiRequests).toBe(0);
    expect(await tabEvidence(worker)).toEqual({ player: false, removed: 0 });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
