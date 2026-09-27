import { expect, test, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Allows the same regression to exercise an independently built baseline.
const extensionPath = path.resolve(
  process.env.UNIDOCK_E2E_EXTENSION_PATH ?? ".output/chrome-mv3",
);
const origin = "https://mylms.korea.ac.kr";
interface LifecycleEvidence {
  instance: string;
  events: { type: string; persisted: boolean; trusted: boolean }[];
}
declare global {
  interface Window {
    cacheLifecycle?: LifecycleEvidence;
    cacheInitialResult?: Promise<unknown>;
    cacheLateResult?: Promise<unknown>;
    cacheAccountOwner?: Promise<unknown>;
  }
}
const fixtureHtml = `<!doctype html><html><title>Synthetic cache lifecycle</title>
<script>
  window.cacheLifecycle = { instance: crypto.randomUUID(), events: [] };
  for (const type of ["pagehide", "pageshow"]) {
    addEventListener(type, event => cacheLifecycle.events.push({
      type: event.type, persisted: event.persisted, trusted: event.isTrusted
    }));
  }
</script><body><h1>Synthetic cache lifecycle</h1></body></html>`;

test("rejects a late account A cache commit after a trusted BFCache restoration", async ({
  playwright,
}, testInfo) => {
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(
    path.join(tmpdir(), "unidock-cache-lifecycle-"),
  );
  const coursesStarted = Promise.withResolvers<void>();
  const releaseCourses = Promise.withResolvers<void>();
  const accountRaceStarted = Promise.withResolvers<void>();
  const releaseAccountRace = Promise.withResolvers<void>();
  let context: BrowserContext | undefined;
  let extensionId: string | undefined;
  let account = 1;
  let coursesRequests = 0;
  const identities: number[] = [];
  const errors: string[] = [];
  const timeline: { event: string; account?: number }[] = [];
  const evidence: Record<string, unknown> = {
    extensionPath,
    identities,
    timeline,
    errors,
  };

  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      // Playwright disables BFCache by default; the regression requires it.
      ignoreDefaultArgs: ["--disable-back-forward-cache"],
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--host-resolver-rules=MAP * ~NOTFOUND",
        "--no-proxy-server",
      ],
    });
    evidence.browserVersion = context.browser()?.version();
    context.on("page", (page) => {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
    });
    // Every site response is synthetic. Unknown origins never reach the network.
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      // The unpacked extension's scripts/styles are local browser resources.
      if (url.protocol === "chrome-extension:" && url.host === extensionId)
        return route.continue();
      if (url.origin !== origin) return route.abort();
      expect(route.request().method()).toBe("GET");
      if (url.pathname === "/api/v1/users/self") {
        identities.push(account);
        timeline.push({ event: "identity", account });
        return route.fulfill({ json: { id: account } });
      }
      if (url.pathname === "/api/v1/courses") {
        const capturedAccount = account;
        coursesRequests++;
        timeline.push({ event: "courses-requested", account: capturedAccount });
        if (coursesRequests === 1) {
          coursesStarted.resolve();
          await releaseCourses.promise;
        } else if (coursesRequests === 2) {
          accountRaceStarted.resolve();
          await releaseAccountRace.promise;
        }
        await route.fulfill({
          json: [
            {
              id: capturedAccount === 1 ? 101 : 202,
              name:
                capturedAccount === 1 ? "Account A course" : "Account B course",
            },
          ],
        });
        timeline.push({ event: "courses-fulfilled", account: capturedAccount });
        return;
      }
      if (url.pathname === "/" || url.pathname === "/other")
        return route.fulfill({ contentType: "text/html", body: fixtureHtml });
      return route.fulfill({ status: 204 });
    });

    const lms = await context.newPage();
    await lms.goto(origin);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    worker.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await lms.bringToFront();
    const tabId = await panel.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({ url: `${url}/*` }))[0];
      if (tab?.id === undefined) throw new Error("Missing synthetic LMS tab");
      return tab.id;
    }, origin);
    const original = await lms.evaluate(() => window.cacheLifecycle?.instance);
    expect(original).toBeTruthy();
    const scope = "10000000-0000-4000-8000-000000000001";

    await panel.evaluate(
      ({ id, scope }) => {
        window.cacheInitialResult = chrome.tabs
          .sendMessage(
            id,
            {
              version: 1,
              type: "CAPABILITY_LIST",
              scope,
              refresh: false,
              request: { version: 1, type: "COURSES_LIST" },
            },
            { frameId: 0 },
          )
          .catch(() => ({ channelClosed: true }));
      },
      { id: tabId, scope },
    );
    await coursesStarted.promise;
    timeline.push({ event: "navigate-away" });
    await lms.goto(`${origin}/other`);
    // BFCache restoration does not fire a new load event. Waiting for load can
    // hang even when the original document was successfully restored.
    await lms.goBack({ waitUntil: "commit" });
    await lms.waitForFunction(
      (instance) =>
        window.cacheLifecycle &&
        (window.cacheLifecycle.instance !== instance ||
          window.cacheLifecycle.events.some(
            (event) => event.type === "pageshow" && event.persisted,
          )),
      original,
    );
    const restored = await lms.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0] as
        | (PerformanceNavigationTiming & {
            notRestoredReasons?: { toJSON(): unknown } | null;
          })
        | undefined;
      return {
        ...window.cacheLifecycle,
        notRestoredReasons: navigation?.notRestoredReasons?.toJSON() ?? null,
      };
    });
    evidence.restoration = restored;
    expect(
      restored.instance,
      `BFCache is required; document replacement is not a passing fallback: ${JSON.stringify(restored)}`,
    ).toBe(original);
    expect(restored.events).toEqual([
      { type: "pageshow", persisted: false, trusted: true },
      { type: "pagehide", persisted: true, trusted: true },
      { type: "pageshow", persisted: true, trusted: true },
    ]);
    timeline.push({ event: "trusted-bfcache-restoration" });

    // Reattach to the still-gated operation through real runtime messaging.
    // The different query's BUSY reply is a message-dispatch barrier; it makes
    // late completion observable without sleeps or reading extension internals.
    const busy = await panel.evaluate(
      async ({ id, scope }) => {
        window.cacheLateResult = chrome.tabs
          .sendMessage(
            id,
            {
              version: 1,
              type: "CAPABILITY_LIST",
              scope,
              refresh: false,
              request: { version: 1, type: "COURSES_LIST" },
            },
            { frameId: 0 },
          )
          .catch(() => ({ channelClosed: true }));
        return chrome.tabs.sendMessage(
          id,
          { version: 1, type: "TODO_LIST" },
          { frameId: 0 },
        );
      },
      { id: tabId, scope },
    );
    expect(busy).toEqual({ status: "error", code: "BUSY" });
    expect(coursesRequests).toBe(1);
    expect(identities).toEqual([1, 1]);
    timeline.push({ event: "release-old-courses", account: 1 });
    releaseCourses.resolve();
    const lateResult = await panel.evaluate(() => window.cacheLateResult);
    evidence.lateResult = lateResult;
    const initialResult = await panel.evaluate(() => window.cacheInitialResult);
    evidence.initialResult = initialResult;
    timeline.push({ event: "old-operation-settled" });
    evidence.beforeAccountSwitch = {
      identities: [...identities],
      coursesRequests,
    };
    expect.soft(lateResult).toEqual({ status: "error", code: "RELOAD_TAB" });
    expect(initialResult).toEqual({ channelClosed: true });

    // In the restored lifecycle, hold a fresh A refresh and join it from B.
    // Every admitted caller must independently probe identity before sharing.
    await panel.evaluate(
      ({ id, scope }) => {
        const refresh = {
          version: 1,
          type: "CAPABILITY_LIST",
          scope,
          refresh: true,
          request: { version: 1, type: "COURSES_LIST" },
        };
        window.cacheAccountOwner = chrome.tabs.sendMessage(id, refresh, {
          frameId: 0,
        });
      },
      { id: tabId, scope },
    );
    await accountRaceStarted.promise;
    account = 2;
    timeline.push({ event: "switch-fixture-account", account });
    const accountFollower: unknown = await panel.evaluate(
      ({ id, scope }) =>
        chrome.tabs.sendMessage(
          id,
          {
            version: 1,
            type: "CAPABILITY_LIST",
            scope,
            refresh: true,
            request: { version: 1, type: "COURSES_LIST" },
          },
          { frameId: 0 },
        ),
      { id: tabId, scope },
    );
    evidence.accountFollower = accountFollower;
    expect(accountFollower).toEqual({
      status: "error",
      code: "LOGIN_REQUIRED",
    });
    expect(accountFollower).not.toEqual({
      status: "success",
      courses: [{ name: "Account A course" }],
    });
    releaseAccountRace.resolve();
    const accountOwner = await panel.evaluate(() => window.cacheAccountOwner);
    evidence.accountOwner = accountOwner;
    expect(accountOwner).toEqual({ status: "error", code: "RELOAD_TAB" });

    const resultB: unknown = await panel.evaluate(
      ({ id, scope }) =>
        chrome.tabs.sendMessage(
          id,
          {
            version: 1,
            type: "CAPABILITY_LIST",
            scope,
            refresh: false,
            request: { version: 1, type: "COURSES_LIST" },
          },
          { frameId: 0 },
        ),
      { id: tabId, scope },
    );
    evidence.resultB = resultB;
    expect.soft(resultB).toMatchObject({
      status: "success",
      courses: [{ name: "Account B course" }],
    });
    expect.soft(coursesRequests).toBe(3);
    expect.soft(identities).toEqual([1, 1, 1, 2, 2, 2]);
    expect(errors).toEqual([]);
  } finally {
    releaseCourses.resolve();
    releaseAccountRace.resolve();
    evidence.coursesRequests = coursesRequests;
    const evidencePath = testInfo.outputPath("cache-lifecycle-evidence.json");
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    await testInfo.attach("cache-lifecycle-evidence", {
      path: evidencePath,
      contentType: "application/json",
    });
    if (context) await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
