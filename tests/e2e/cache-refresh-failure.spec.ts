import { expect, test, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const extensionPath = path.resolve(
  process.env.UNIDOCK_E2E_EXTENSION_PATH ?? ".output/chrome-mv3",
);
const origin = "https://mylms.korea.ac.kr";

test("a failed production refresh cannot resurrect the previously cached courses", async ({
  playwright,
}) => {
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-cache-refresh-"));
  let context: BrowserContext | undefined;
  let coursesRequests = 0;
  let courseResponse: "old" | "failure" | "new" = "old";

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
      expect(route.request().method()).toBe("GET");
      if (url.pathname === "/api/v1/users/self")
        return route.fulfill({ json: { id: 71 } });
      if (url.pathname === "/api/v1/courses") {
        coursesRequests++;
        if (courseResponse === "failure")
          return route.fulfill({
            status: 503,
            body: "synthetic refresh failure",
          });
        const name = courseResponse === "old" ? "Old course" : "New course";
        return route.fulfill({ json: [{ id: 101, name }] });
      }
      if (url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><body>Synthetic LMS</body></html>",
        });
      return route.fulfill({ status: 404, body: "not found" });
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
    const tabId = await panel.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({ url: `${url}/*` }))[0];
      if (tab?.id === undefined) throw new Error("Missing synthetic LMS tab");
      return tab.id;
    }, origin);
    const send = (message: unknown) =>
      panel.evaluate(
        ([id, payload]) =>
          chrome.tabs.sendMessage(id as number, payload, { frameId: 0 }),
        [tabId, message] as const,
      );
    const request = { version: 1, type: "COURSES_LIST" };

    expect(await send(request)).toEqual({
      status: "success",
      courses: [{ name: "Old course" }],
    });
    expect(await send(request)).toEqual({
      status: "success",
      courses: [{ name: "Old course" }],
    });
    expect(coursesRequests).toBe(1);

    courseResponse = "failure";
    expect(await send({ version: 1, type: "QUERY_REFRESH", request })).toEqual({
      status: "error",
      code: "NETWORK",
    });
    expect(coursesRequests).toBe(2);

    courseResponse = "new";
    const fresh = await send(request);
    expect(fresh).toEqual({
      status: "success",
      courses: [{ name: "New course" }],
    });
    expect(fresh).not.toEqual({
      status: "success",
      courses: [{ name: "Old course" }],
    });
    expect(await send(request)).toEqual(fresh);
    expect(coursesRequests).toBe(3);
  } finally {
    if (context) await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
