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
    const scope = "10000000-0000-4000-8000-000000000001";
    const request = { version: 1, type: "COURSES_LIST" };
    const courses = (refresh: boolean) => ({
      version: 1,
      type: "CAPABILITY_LIST",
      scope,
      refresh,
      request,
    });

    const old = await send(courses(false));
    expect(old).toMatchObject({
      status: "success",
      courses: [{ name: "Old course" }],
    });
    const oldCached = await send(courses(false));
    expect(oldCached).toMatchObject({
      status: "success",
      courses: [{ name: "Old course" }],
    });
    expect(
      (oldCached as { courses: { courseSelector: string }[] }).courses[0]
        ?.courseSelector,
    ).not.toBe(
      (old as { courses: { courseSelector: string }[] }).courses[0]
        ?.courseSelector,
    );
    expect(coursesRequests).toBe(1);

    courseResponse = "failure";
    expect(await send(courses(true))).toEqual({
      status: "error",
      code: "NETWORK",
    });
    expect(coursesRequests).toBe(2);

    courseResponse = "new";
    const fresh = await send(courses(false));
    expect(fresh).toMatchObject({
      status: "success",
      courses: [{ name: "New course" }],
    });
    expect(fresh).not.toMatchObject({ courses: [{ name: "Old course" }] });
    expect(await send(courses(false))).toMatchObject({
      status: "success",
      courses: [{ name: "New course" }],
    });
    expect(coursesRequests).toBe(3);
  } finally {
    if (context) await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
