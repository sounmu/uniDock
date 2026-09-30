import { expect, test, type BrowserContext } from "@playwright/test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";

const extensionPath = path.resolve(".output/chrome-mv3");
const origin = "https://mylms.korea.ac.kr";

test("a completed native PDF is not overwritten by a late timeout acknowledgement", async ({
  playwright,
}) => {
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-ack-race-"));
  const downloadDirectory = path.join(profile, "downloads");
  await mkdir(path.join(profile, "Default"));
  await writeFile(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({
      download: {
        default_directory: downloadDirectory,
        prompt_for_download: false,
      },
    }),
  );
  const server = await syntheticServer(profile);
  let context: BrowserContext | undefined;
  let releaseDownload: (() => void) | undefined;
  const errors: string[] = [];
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--host-resolver-rules=MAP mylms.korea.ac.kr 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
        "--no-proxy-server",
        "--ignore-certificate-errors",
      ],
    });
    const browser = context.browser();
    if (!browser) throw new Error("Missing synthetic browser");
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    await cdp.detach();
    context.on("page", (page) => {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
    });
    const lms = await context.newPage();
    await lms.goto(origin);
    await expect(
      lms.getByRole("heading", { name: "Synthetic LMS" }),
    ).toBeVisible();
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    worker.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await lms.bringToFront();
    await panel.getByRole("button", { name: "새로고침", exact: true }).click();
    await panel
      .getByRole("button", { name: /Synthetic Operating Systems/ })
      .click();
    await panel.getByRole("button", { name: "수업 자료", exact: true }).click();
    await expect(
      panel.getByRole("heading", { name: "수업 자료 · 2개 PDF" }),
    ).toBeVisible();

    // Delay only the content-script result seen by the panel. Chrome's native
    // download and its completion events remain entirely real.
    await panel.evaluate(() => {
      const root = window as typeof window & {
        downloadAckRace?: {
          actual?: unknown;
          release: () => void;
          requests: number;
        };
      };
      const original = chrome.tabs.sendMessage.bind(chrome.tabs);
      let release!: () => void;
      const held = new Promise<unknown>((resolve) => {
        release = () => resolve({ status: "error", code: "TIMEOUT" } as const);
      });
      root.downloadAckRace = { release, requests: 0 };
      chrome.tabs.sendMessage = (async (
        ...args: Parameters<typeof original>
      ) => {
        const message = args[1] as { type?: string };
        if (message?.type !== "DOCUMENT_DOWNLOAD_REQUEST")
          return original(...args);
        root.downloadAckRace!.requests += 1;
        root.downloadAckRace!.actual = await original(...args);
        return held;
      }) as typeof chrome.tabs.sendMessage;
    });

    releaseDownload = server.holdNextDownload();
    await panel.getByRole("checkbox", { name: "lecture.pdf 선택" }).check();
    await panel.getByRole("button", { name: "선택 다운로드 (1)" }).click();
    await expect.poll(() => server.downloads.length).toBe(1);
    await expect(
      panel.locator(".status-chip").filter({ hasText: /^요청됨$/ }),
    ).toHaveCount(1);
    releaseDownload();
    releaseDownload = undefined;
    await expect
      .poll(() =>
        panel.evaluate(async () =>
          (await chrome.downloads.search({})).find(
            ({ state }) => state === "complete",
          ),
        ),
      )
      .toMatchObject({
        byExtensionId: extensionId,
        state: "complete",
        mime: "application/pdf",
      });
    await expect(
      panel.locator(".status-chip").filter({ hasText: /^완료$/ }),
    ).toHaveCount(1);

    await panel.evaluate(() =>
      (
        window as typeof window & {
          downloadAckRace?: { release: () => void };
        }
      ).downloadAckRace?.release(),
    );
    await expect(panel.getByText("1/1", { exact: true })).toBeVisible();
    await expect(
      panel.locator(".status-chip").filter({ hasText: /^완료$/ }),
    ).toHaveCount(1);
    await expect(
      panel.getByText("PDF 다운로드를 시작하지 못했습니다", { exact: false }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole("checkbox", { name: "lecture.pdf 선택" }),
    ).toBeDisabled();

    const race = await panel.evaluate(
      () =>
        (
          window as typeof window & {
            downloadAckRace?: { actual?: unknown; requests: number };
          }
        ).downloadAckRace,
    );
    expect(race).toEqual({
      actual: { status: "success", downloaded: true },
      requests: 1,
    });
    const nativeDownloads = await panel.evaluate(() =>
      chrome.downloads.search({}),
    );
    expect(nativeDownloads).toHaveLength(1);
    expect(nativeDownloads[0]?.filename).toContain(
      "/uniDock/Synthetic Operating Systems/Week 1/lecture.pdf",
    );
    expect(await readFile(nativeDownloads[0]!.filename)).toEqual(server.pdf);
    expect(server.downloads).toEqual(["/courses/101/files/501/download"]);
    expect(errors).toEqual([]);
  } finally {
    releaseDownload?.();
    if (context) await context.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
