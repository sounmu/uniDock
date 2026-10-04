import { test, expect, chromium, type Browser } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";

// Playwright's command-line extension loading cannot reload an extension in
// place, so this drives the real install/update path over CDP instead.
test("install and update reconnect an already open LMS tab without a reload", async () => {
  test.setTimeout(90000);
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-reinject-"));
  const server = await syntheticServer(profile);
  const extension = path.resolve(".output/chrome-mv3");
  const port = 9300 + Math.floor(Math.random() * 600);
  const chrome = spawn(
    chromium.executablePath(),
    [
      `--user-data-dir=${path.join(profile, "user")}`,
      `--remote-debugging-port=${port}`,
      "--headless=new",
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      // Playwright adds this itself on Linux; a directly spawned Chromium on
      // CI runners without unprivileged user namespaces exits immediately.
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      `--host-resolver-rules=MAP mylms.korea.ac.kr 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
      "--no-proxy-server",
      "--ignore-certificate-errors",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let browser: Browser | undefined;
  try {
    await expect
      .poll(
        async () =>
          (browser ??= await chromium
            .connectOverCDP(`http://127.0.0.1:${port}`)
            .catch(() => undefined)) !== undefined,
        { timeout: 15000 },
      )
      .toBe(true);
    const context = browser!.contexts()[0]!;
    const cdp = await browser!.newBrowserCDPSession();
    const errors: string[] = [];
    // The LMS tab exists before the extension does: no manifest injection.
    const lms = await context.newPage();
    await lms.goto("https://mylms.korea.ac.kr/");
    let navigations = 0;
    lms.on("framenavigated", (frame) => {
      if (frame === lms.mainFrame()) navigations++;
    });
    const coursesWork = async (id: string) => {
      const panel = await context.newPage();
      panel.on("pageerror", (error) => errors.push(error.message));
      await panel.goto(`chrome-extension://${id}/sidepanel.html`);
      await lms.bringToFront();
      await expect
        .poll(
          async () => {
            // Right after an update the new copy can need a moment to land;
            // a bounded click lets the poll retry instead of waiting forever.
            await panel
              .getByRole("button", { name: "새로고침" })
              .click({ timeout: 3000 })
              .catch(() => {});
            await panel.waitForTimeout(300);
            return panel
              .getByRole("button", { name: /Synthetic Operating Systems/ })
              .isVisible();
          },
          { timeout: 15000 },
        )
        .toBe(true);
      // Same-version installs never claim a new version.
      await expect(panel.locator('[aria-label="업데이트 안내"]')).toHaveCount(
        0,
      );
      await panel.close();
    };

    const { id } = await cdp.send("Extensions.loadUnpacked", {
      path: extension,
    });
    await coursesWork(id);
    // Loading the same unpacked path again is an "update": it orphans the
    // copy injected above, and the new worker must inject a fresh one.
    await cdp.send("Extensions.loadUnpacked", { path: extension });
    await coursesWork(id);

    expect(navigations).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close().catch(() => {});
    // Chromium keeps writing its profile until the process is gone.
    const exited =
      chrome.exitCode !== null || chrome.signalCode !== null
        ? Promise.resolve()
        : once(chrome, "exit");
    chrome.kill();
    await exited;
    await server.close();
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
});
