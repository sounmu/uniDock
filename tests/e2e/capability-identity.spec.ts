import { expect, test, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const extensionPath = path.resolve(".output/chrome-mv3");
const origin = "https://mylms.korea.ac.kr";

test("production capabilities cannot cross synthetic LMS accounts", async ({
  playwright,
}) => {
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-capability-"));
  let context: BrowserContext | undefined;
  let account = 1;
  let itemNavigations = 0;
  const errors: string[] = [];
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--host-resolver-rules=MAP * ~NOTFOUND",
        "--no-proxy-server",
      ],
    });
    context.on("page", (page) => {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === "chrome-extension:") return route.continue();
      if (url.origin !== origin) return route.abort();
      expect(route.request().method()).toBe("GET");
      if (url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Synthetic LMS</title><h1>Synthetic LMS</h1>",
        });
      if (url.pathname === "/api/v1/users/self")
        return route.fulfill({ json: { id: account } });
      if (url.pathname === "/api/v1/courses")
        return route.fulfill({ json: [{ id: 101, name: "Course" }] });
      if (url.pathname === "/api/v1/courses/101/modules")
        return route.fulfill({
          json: [
            {
              id: 10,
              name: "Week",
              items_count: 1,
              items: [
                {
                  id: 501,
                  type: "ExternalTool",
                  title: "Lecture",
                  html_url: `${origin}/courses/101/modules/items/501`,
                },
              ],
            },
          ],
        });
      if (url.pathname === "/courses/101/modules/items/501") {
        itemNavigations++;
        return route.fulfill({ contentType: "text/html", body: "blocked" });
      }
      return route.fulfill({ status: 404 });
    });

    const lms = await context.newPage();
    await lms.goto(origin);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    worker.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    const tabId = await panel.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({ url: `${url}/*` }))[0];
      if (tab?.id === undefined) throw new Error("Missing synthetic LMS tab");
      return tab.id;
    }, origin);
    const listed: unknown = await panel.evaluate(
      (id) =>
        chrome.tabs.sendMessage(
          id,
          { version: 1, type: "RECORDINGS_LIST", course: "Course" },
          { frameId: 0 },
        ),
      tabId,
    );
    expect(listed).toMatchObject({ status: "success" });
    const handle = (listed as { recordings: { launchHandle: string }[] })
      .recordings[0]!.launchHandle;

    account = 2;
    const opened: unknown = await panel.evaluate(
      ({ id, handle }) =>
        chrome.tabs.sendMessage(
          id,
          { version: 1, type: "RECORDING_OPEN", handle },
          { frameId: 0 },
        ),
      { id: tabId, handle },
    );
    expect(opened).toEqual({ status: "error", code: "LOGIN_REQUIRED" });
    expect(itemNavigations).toBe(0);
    expect(
      context
        .pages()
        .some((page) =>
          page.url().startsWith(`${origin}/courses/101/modules/items/501`),
        ),
    ).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    if (context) await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
