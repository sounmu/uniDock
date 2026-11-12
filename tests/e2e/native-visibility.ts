import { test, type Browser } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Playwright's normal page session enables focus emulation. A second CDP
// session cannot undo that session's override, so these tests connect without
// default overrides to an isolated browser and observe real tab visibility.
export const nativeVisibilityTest = test.extend<{ nativeExtension: string | null }>({
  nativeExtension: [null, { option: true }],
  context: async ({ playwright, nativeExtension }, use) => {
    const { chromium } = playwright;
    const profile = await mkdtemp(path.join(tmpdir(), "unidock-visibility-"));
    const endpoint = Promise.withResolvers<string>();
    const child = spawn(chromium.executablePath(), [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-component-extensions-with-background-pages",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      ...(nativeExtension ? [
        `--disable-extensions-except=${nativeExtension}`,
        `--load-extension=${nativeExtension}`,
      ] : []),
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const closed = new Promise<void>((resolve) => child.once("close", () => {
      endpoint.reject(new Error("Visibility browser exited before connecting"));
      resolve();
    }));
    child.once("error", endpoint.reject);
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      const address = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)/.exec(stderr)?.[1];
      if (address) endpoint.resolve(address);
    });
    const timeout = setTimeout(() => endpoint.reject(new Error("Visibility browser did not start")), 15000);
    let browser: Browser | undefined;
    try {
      const address = await endpoint.promise;
      clearTimeout(timeout);
      browser = await chromium.connectOverCDP(address, { noDefaults: true });
      const context = browser.contexts()[0];
      if (!context) throw new Error("Missing native browser context");
      await context.route("**/*", (route) =>
        nativeExtension && route.request().url().startsWith("chrome-extension://")
          ? route.continue()
          : route.abort("blockedbyclient"),
      );
      await use(context);
    } finally {
      clearTimeout(timeout);
      await browser?.close();
      child.kill();
      await closed;
      await rm(profile, { recursive: true, force: true });
    }
  },
});
