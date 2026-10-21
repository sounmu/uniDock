import { expect, test, type BrowserContext } from "@playwright/test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";

const extensionPath = path.resolve(".output/chrome-mv3");
const origin = "https://mylms.korea.ac.kr";

test("a stale native download lookup cannot complete a refreshed matching row", async ({
  playwright,
}) => {
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(
    path.join(tmpdir(), "unidock-observation-race-"),
  );
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
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
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
    await panel.getByRole("button", { name: "강의 자료", exact: true }).click();
    await expect(
      panel.getByRole("heading", { name: "강의 자료 · 2개" }),
    ).toBeVisible();

    // Hold every hook lookup for the first real Chrome download ID. Calls to
    // originalSearch below still inspect Chrome's actual download manager.
    await panel.evaluate(() => {
      const root = window as typeof window & {
        downloadSearchRace?: {
          heldId?: number;
          held: Promise<chrome.downloads.DownloadItem[]>;
          release: (items: chrome.downloads.DownloadItem[]) => void;
          originalSearch: typeof chrome.downloads.search;
        };
      };
      const originalSearch = chrome.downloads.search.bind(chrome.downloads);
      let release!: (items: chrome.downloads.DownloadItem[]) => void;
      const held = new Promise<chrome.downloads.DownloadItem[]>((resolve) => {
        release = resolve;
      });
      root.downloadSearchRace = { held, release, originalSearch };
      chrome.downloads.search = ((query: chrome.downloads.DownloadQuery) => {
        const race = root.downloadSearchRace!;
        if (query.id !== undefined && race.heldId === undefined)
          race.heldId = query.id;
        return query.id === race.heldId ? race.held : originalSearch(query);
      }) as typeof chrome.downloads.search;
    });

    releaseFirst = server.holdNextDownload();
    await panel.getByRole("checkbox", { name: "lecture.pdf 선택" }).check();
    await panel.getByRole("button", { name: "선택 다운로드 (1)" }).click();
    await expect
      .poll(() =>
        panel.evaluate(
          () =>
            (
              window as typeof window & {
                downloadSearchRace?: { heldId?: number };
              }
            ).downloadSearchRace?.heldId,
        ),
      )
      .toBeGreaterThan(0);
    releaseFirst();
    releaseFirst = undefined;
    await expect
      .poll(() =>
        panel.evaluate(async () => {
          const race = (
            window as typeof window & {
              downloadSearchRace: {
                heldId: number;
                originalSearch: typeof chrome.downloads.search;
              };
            }
          ).downloadSearchRace;
          return (await race.originalSearch({ id: race.heldId }))[0]?.state;
        }),
      )
      .toBe("complete");
    const oldItem = await panel.evaluate(async () => {
      const race = (
        window as typeof window & {
          downloadSearchRace: {
            heldId: number;
            originalSearch: typeof chrome.downloads.search;
          };
        }
      ).downloadSearchRace;
      return (await race.originalSearch({ id: race.heldId }))[0];
    });
    expect(oldItem?.byExtensionId).toBe(extensionId);
    expect(oldItem?.mime).toBe("application/pdf");
    if (!oldItem) throw new Error("Missing first native download");
    await panel.evaluate(({ id }) => chrome.downloads.erase({ id }), {
      id: oldItem.id,
    });
    await rm(oldItem.filename);

    // Reset the list, request the same destination again, and keep that new
    // transfer open while the stale completed lookup is released.
    await panel
      .getByRole("button", { name: "목록 새로고침", exact: true })
      .click();
    releaseSecond = server.holdNextDownload();
    await panel.getByRole("checkbox", { name: "lecture.pdf 선택" }).check();
    await panel.getByRole("button", { name: "선택 다운로드 (1)" }).click();
    await expect.poll(() => server.downloads.length).toBe(2);
    await expect
      .poll(() =>
        panel.evaluate(async () => {
          const race = (
            window as typeof window & {
              downloadSearchRace: {
                heldId: number;
                originalSearch: typeof chrome.downloads.search;
              };
            }
          ).downloadSearchRace;
          return (await race.originalSearch({})).some(
            ({ id, state }) => id !== race.heldId && state === "in_progress",
          );
        }),
      )
      .toBe(true);
    await panel.evaluate((completed) => {
      (
        window as typeof window & {
          downloadSearchRace: {
            release: (items: chrome.downloads.DownloadItem[]) => void;
          };
        }
      ).downloadSearchRace.release([completed]);
    }, oldItem);
    await expect(
      panel.locator(".status-chip").filter({ hasText: /^요청됨$/ }),
    ).toHaveCount(1);

    releaseSecond();
    releaseSecond = undefined;
    await expect
      .poll(() =>
        panel.evaluate(async () => {
          const race = (
            window as typeof window & {
              downloadSearchRace: {
                heldId: number;
                originalSearch: typeof chrome.downloads.search;
              };
            }
          ).downloadSearchRace;
          return (await race.originalSearch({})).find(
            ({ id }) => id !== race.heldId,
          );
        }),
      )
      .toMatchObject({
        state: "complete",
        byExtensionId: extensionId,
        mime: "application/pdf",
        filename: expect.stringMatching(
          /\/uniDock\/Synthetic Operating Systems\/Week 1\/lecture\.pdf$/,
        ),
      });
    await expect(
      panel.locator(".status-chip").filter({ hasText: /^완료$/ }),
    ).toHaveCount(1);
    expect(server.downloads).toEqual([
      "/courses/101/files/501/download",
      "/courses/101/files/501/download",
    ]);
    expect(errors).toEqual([]);
  } finally {
    releaseFirst?.();
    releaseSecond?.();
    if (context) await context.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
