import { expect, test, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";

const extensionPath = path.resolve(".output/chrome-mv3");
const origin = "https://mylms.korea.ac.kr";

interface DownloadTrace {
  held: boolean;
  heldTabId?: number;
  accepted?: {
    deadlineValid: boolean;
    documentId?: string;
    tabId?: number;
  };
  challenge?: {
    documentId?: string;
    rejected: boolean;
  };
  downloadCalls: number;
}

test("production downloads expire during tab lookup and reject a same-URL replacement document", async ({
  playwright,
}) => {
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-download-race-"));
  const server = await syntheticServer(profile);
  let context: BrowserContext | undefined;
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
    await context.tracing.start({ screenshots: true, snapshots: true });
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
    await expect(panel.getByText("조회 완료 · 2개 과목")).toBeVisible();
    await panel
      .getByRole("button", { name: /Synthetic Operating Systems/ })
      .click();
    await panel.getByRole("button", { name: "수업 자료", exact: true }).click();
    await expect(
      panel.getByRole("heading", { name: "수업 자료 · 2개 PDF" }),
    ).toBeVisible();

    await panel.evaluate(() => {
      const state = window as typeof window & {
        downloadResults: unknown[];
        createdDownloads: number;
        downloadRequests: unknown[];
      };
      state.downloadResults = [];
      state.createdDownloads = 0;
      state.downloadRequests = [];
      chrome.downloads.onCreated.addListener(() => {
        state.createdDownloads += 1;
      });
      const original = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = (async (
        ...args: Parameters<typeof original>
      ) => {
        const message = args[1] as { type?: string };
        try {
          const result = await original(...args);
          if (message?.type === "DOCUMENT_DOWNLOAD_REQUEST") {
            state.downloadRequests.push(message);
            state.downloadResults.push(result);
          }
          return result;
        } catch (error) {
          if (message?.type === "DOCUMENT_DOWNLOAD_REQUEST") {
            state.downloadRequests.push(message);
            state.downloadResults.push({ transportRejected: true });
          }
          throw error;
        }
      }) as typeof chrome.tabs.sendMessage;
    });

    const sourceTabId = await worker.evaluate(async (lmsOrigin) => {
      const tab = (await chrome.tabs.query({})).find(
        ({ url }) => url === `${lmsOrigin}/`,
      );
      if (tab?.id === undefined) throw new Error("Missing synthetic LMS tab");
      return tab.id;
    }, origin);
    await worker.evaluate((targetTabId) => {
      const root = globalThis as typeof globalThis & {
        downloadRace?: {
          trace: DownloadTrace;
          release?: () => void;
          armed: boolean;
          originalNow: () => number;
        };
      };
      const originalGet = chrome.tabs.get.bind(chrome.tabs);
      const originalSend = chrome.tabs.sendMessage.bind(chrome.tabs);
      const originalDownload = chrome.downloads.download.bind(
        chrome.downloads,
      ) as unknown as (
        options: chrome.downloads.DownloadOptions,
      ) => Promise<number>;
      const originalNow = Date.now.bind(Date);
      const trace: DownloadTrace = { held: false, downloadCalls: 0 };
      root.downloadRace = { trace, armed: true, originalNow };
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (
          message?.type === "DOWNLOAD_LMS_FILE" &&
          sender.tab?.id === targetTabId
        ) {
          trace.accepted = {
            deadlineValid:
              Number.isInteger(message.deadline) &&
              message.deadline > originalNow() &&
              message.deadline <= originalNow() + 23_000,
            documentId: sender.documentId,
            tabId: sender.tab.id,
          };
        }
        return false;
      });
      chrome.tabs.get = (async (tabId: number) => {
        if (root.downloadRace?.armed && tabId === targetTabId) {
          root.downloadRace.armed = false;
          trace.held = true;
          trace.heldTabId = tabId;
          await new Promise<void>((resolve) => {
            root.downloadRace!.release = resolve;
          });
        }
        return originalGet(tabId);
      }) as typeof chrome.tabs.get;
      chrome.tabs.sendMessage = (async (
        ...args: Parameters<typeof originalSend>
      ) => {
        const message = args[1] as { type?: string };
        if (message?.type !== "DOWNLOAD_SOURCE_CHECK")
          return originalSend(...args);
        try {
          const result = await originalSend(...args);
          trace.challenge = {
            documentId: args[2]?.documentId,
            rejected: false,
          };
          return result;
        } catch (error) {
          trace.challenge = {
            documentId: args[2]?.documentId,
            rejected: true,
          };
          throw error;
        }
      }) as typeof chrome.tabs.sendMessage;
      chrome.downloads.download = (async (
        options: chrome.downloads.DownloadOptions,
      ) => {
        trace.downloadCalls += 1;
        return originalDownload(options);
      }) as unknown as typeof chrome.downloads.download;
    }, sourceTabId);

    const initialNative = await panel.evaluate(() =>
      chrome.downloads.search({}),
    );
    expect(initialNative).toHaveLength(0);
    await panel.getByRole("checkbox", { name: "lecture.pdf 선택" }).check();
    await panel.getByRole("button", { name: "선택 다운로드 (1)" }).click();
    await expect
      .poll(() =>
        worker.evaluate(() =>
          Boolean(
            (
              globalThis as typeof globalThis & {
                downloadRace?: { trace: DownloadTrace };
              }
            ).downloadRace?.trace.held,
          ),
        ),
      )
      .toBe(true);
    await worker.evaluate(() => {
      const race = (
        globalThis as typeof globalThis & {
          downloadRace?: {
            release?: () => void;
            originalNow: () => number;
          };
        }
      ).downloadRace!;
      Date.now = () => race.originalNow() + 24_000;
      race.release?.();
    });
    await expect
      .poll(() =>
        panel.evaluate(
          () =>
            (window as typeof window & { downloadResults: unknown[] })
              .downloadResults.length,
        ),
      )
      .toBe(1);
    expect(
      await panel.evaluate(
        () =>
          (window as typeof window & { downloadResults: unknown[] })
            .downloadResults[0],
      ),
    ).toEqual({ status: "error", code: "TIMEOUT" });
    const expiredTrace = await worker.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            downloadRace?: { trace: DownloadTrace };
          }
        ).downloadRace!.trace,
    );
    expect(expiredTrace).toMatchObject({
      held: true,
      heldTabId: sourceTabId,
      accepted: {
        deadlineValid: true,
        tabId: sourceTabId,
      },
      downloadCalls: 0,
    });
    expect(expiredTrace.accepted?.documentId).toBeTruthy();
    expect(await panel.evaluate(() => chrome.downloads.search({}))).toEqual([]);
    expect(
      await panel.evaluate(
        () =>
          (window as typeof window & { createdDownloads: number })
            .createdDownloads,
      ),
    ).toBe(0);
    expect(server.downloads).toEqual([]);

    // The content script had accepted and spent this one-use handle before the
    // background deadline elapsed; a direct replay must not revive it.
    const replay = await panel.evaluate(async (tabId) => {
      const state = window as typeof window & { downloadRequests: unknown[] };
      const previous = state.downloadRequests[0] as {
        request: unknown;
      };
      return chrome.tabs.sendMessage(
        tabId,
        {
          version: 1,
          type: "DOCUMENT_DOWNLOAD_REQUEST",
          deadline: Date.now() + 23_000,
          request: previous.request,
        },
        { frameId: 0 },
      );
    }, sourceTabId);
    expect(replay).toEqual({ status: "error", code: "STALE_SELECTION" });
    await panel.evaluate(() => {
      const state = window as typeof window & {
        downloadResults: unknown[];
        downloadRequests: unknown[];
      };
      state.downloadResults = [];
      state.downloadRequests = [];
    });

    await worker.evaluate(() => {
      const race = (
        globalThis as typeof globalThis & {
          downloadRace?: {
            trace: DownloadTrace;
            armed: boolean;
            originalNow: () => number;
          };
        }
      ).downloadRace!;
      Date.now = race.originalNow;
      race.trace.held = false;
      race.trace.challenge = undefined;
      race.armed = true;
    });
    await panel
      .getByRole("button", { name: "목록 새로고침", exact: true })
      .click();
    await expect(
      panel.getByRole("heading", { name: "수업 자료 · 2개 PDF" }),
    ).toBeVisible();
    await panel.getByRole("checkbox", { name: "lecture.pdf 선택" }).check();
    await panel.getByRole("button", { name: "선택 다운로드 (1)" }).click();
    await expect
      .poll(() =>
        worker.evaluate(() =>
          Boolean(
            (
              globalThis as typeof globalThis & {
                downloadRace?: { trace: DownloadTrace };
              }
            ).downloadRace?.trace.held,
          ),
        ),
      )
      .toBe(true);
    await lms.reload({ waitUntil: "domcontentloaded" });
    expect(lms.url()).toBe(`${origin}/`);
    await worker.evaluate(() => {
      (
        globalThis as typeof globalThis & {
          downloadRace?: { release?: () => void };
        }
      ).downloadRace?.release?.();
    });
    await expect
      .poll(() =>
        panel.evaluate(
          () =>
            (window as typeof window & { downloadResults: unknown[] })
              .downloadResults.length,
        ),
      )
      .toBe(1);
    expect(
      await panel.evaluate(
        () =>
          (window as typeof window & { downloadResults: unknown[] })
            .downloadResults[0],
      ),
    ).toEqual({ transportRejected: true });
    await expect(
      panel.locator(".status-chip").filter({ hasText: /^실패$/ }),
    ).toHaveCount(1);
    const reloadTrace = await worker.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            downloadRace?: { trace: DownloadTrace };
          }
        ).downloadRace!.trace,
    );
    expect(reloadTrace.challenge).toEqual({
      documentId: reloadTrace.accepted?.documentId,
      rejected: true,
    });
    expect(reloadTrace.downloadCalls).toBe(0);
    expect(await panel.evaluate(() => chrome.downloads.search({}))).toEqual([]);
    expect(
      await panel.evaluate(
        () =>
          (window as typeof window & { createdDownloads: number })
            .createdDownloads,
      ),
    ).toBe(0);
    expect(server.downloads).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    if (context) {
      await context.tracing.stop({ path: test.info().outputPath("trace.zip") });
      await context.close();
    }
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
