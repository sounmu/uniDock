import { expect, test, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";

const extensionPath = path.resolve(".output/chrome-mv3");
const origin = "https://mylms.korea.ac.kr";

test("production transport accepts 1001 PDF items over two real API pages", async ({
  playwright,
}) => {
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-document-pages-"));
  const server = await syntheticServer(profile, { paginatedDocuments: true });
  let context: BrowserContext | undefined;
  const errors: string[] = [];
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 420, height: 800 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--host-resolver-rules=MAP mylms.korea.ac.kr 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
        "--no-proxy-server",
        "--ignore-certificate-errors",
      ],
    });
    context.on("page", (page) => {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
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
    await panel.evaluate(() => {
      const target = window as typeof window & { documentResult?: unknown };
      const original = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = (async (
        ...args: Parameters<typeof original>
      ) => {
        const result = await original(...args);
        const message = args[1] as {
          type?: string;
          request?: { type?: string };
        };
        if (
          message?.type === "CAPABILITY_LIST" &&
          message.request?.type === "DOCUMENTS_LIST"
        )
          target.documentResult = result;
        return result;
      }) as typeof chrome.tabs.sendMessage;
    });

    await lms.bringToFront();
    await panel.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect(panel.getByText("조회 완료 · 2개 과목")).toBeVisible();
    await panel
      .getByRole("button", { name: /Synthetic Operating Systems/ })
      .click();
    await panel.getByRole("button", { name: "강의 자료", exact: true }).click();

    await expect(
      panel.getByRole("heading", { name: "강의 자료 · 1001개" }),
    ).toBeVisible();
    await expect(panel.getByText("1–100 / 1001개")).toBeVisible();
    const result = await panel.evaluate(
      () =>
        (
          window as typeof window & {
            documentResult?: {
              status: string;
              documents?: {
                title: string;
                lmsHandle: string;
                downloadHandle: string;
              }[];
            };
          }
        ).documentResult,
    );
    expect(result?.status).toBe("success");
    expect(result?.documents).toHaveLength(1001);
    expect(result?.documents?.[0]?.title).toBe("0000.pdf");
    expect(result?.documents?.at(-1)?.title).toBe("1000-last.pdf");
    expect(
      new Set(
        result?.documents?.flatMap(({ lmsHandle, downloadHandle }) => [
          lmsHandle,
          downloadHandle,
        ]),
      ).size,
    ).toBe(2002);
    expect(
      server.requests
        .filter(
          ({ method, pathname }) =>
            method === "GET" &&
            pathname === "/api/v1/courses/101/modules/10/items",
        )
        .map(({ search }) => search),
    ).toEqual(["?per_page=100&include[]=content_details", "?page=2"]);
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
