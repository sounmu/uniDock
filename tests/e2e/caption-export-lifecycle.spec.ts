import { expect, test, type BrowserContext } from "@playwright/test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";

const extensionPath = path.resolve(".output/chrome-mv3");

declare global {
  interface Window {
    captionExportGate?: {
      first(): Promise<void>;
      drained(): Promise<void>;
      release(): void;
      calls(): number;
      files(): Promise<
        { filename: string; id: number; mime: string; state: string }[]
      >;
      requested(): string[];
    };
  }
}

async function openCaptionPanel(context: BrowserContext, serverPort: number) {
  const lms = await context.newPage();
  await lms.goto("https://mylms.korea.ac.kr/");
  await lms.evaluate((port) => {
    const iframe = document.createElement("iframe");
    iframe.src = `https://kucom.korea.ac.kr:${port}/em/caption-fixture?stable=1`;
    document.body.append(iframe);
  }, serverPort);
  await expect(
    lms.frameLocator("iframe").getByText("Iframe caption text"),
  ).toBeVisible();
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const panel = await context.newPage();
  return {
    lms,
    panel,
    panelUrl: `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
  };
}

async function detectAndOpen(
  panel: import("@playwright/test").Page,
  lms: import("@playwright/test").Page,
) {
  await lms.bringToFront();
  await panel.getByRole("button", { name: "자막 추출", exact: true }).click();
  await panel.getByRole("button", { name: "자막 감지" }).click();
  await expect(
    panel.getByText("자막 1개 · 5분 동안 메모리에 보관"),
  ).toBeVisible();
  await panel.locator(".list-row").click();
}

test("a rapid caption export produces one matching TXT/JSON pair with real bytes", async ({
  playwright,
}) => {
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-caption-export-"));
  const server = await syntheticServer(profile);
  let context: BrowserContext | undefined;
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--host-resolver-rules=MAP mylms.korea.ac.kr 127.0.0.1:${server.port}, MAP kucom.korea.ac.kr 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
        "--no-proxy-server",
        "--ignore-certificate-errors",
      ],
    });
    const { lms, panel, panelUrl } = await openCaptionPanel(
      context,
      server.port,
    );
    await panel.addInitScript(() => {
      const original = chrome.downloads.download.bind(chrome.downloads);
      let calls = 0;
      const ids: number[] = [];
      const requested: string[] = [];
      let finishFirst!: () => void;
      let release!: () => void;
      const first = new Promise<void>((resolve) => (finishFirst = resolve));
      const held = new Promise<void>((resolve) => (release = resolve));
      chrome.downloads.download = (async (options) => {
        calls++;
        requested.push(options.filename ?? "");
        if (calls === 1) {
          finishFirst();
          await held;
        }
        const id = await original(options);
        ids.push(id);
        return id;
      }) as typeof chrome.downloads.download;
      window.captionExportGate = {
        first: () => first,
        drained: async () => undefined,
        release,
        calls: () => calls,
        files: async () =>
          (await Promise.all(ids.map((id) => chrome.downloads.search({ id }))))
            .flat()
            .map(({ filename, id, mime, state }) => ({
              filename,
              id,
              mime,
              state,
            })),
        requested: () => requested,
      };
    });
    await panel.goto(panelUrl);
    await detectAndOpen(panel, lms);

    await panel
      .getByRole("button", { name: "TXT·JSON 다운로드" })
      .evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
    await panel.evaluate(() => window.captionExportGate!.first());
    expect(await panel.evaluate(() => window.captionExportGate!.calls())).toBe(
      1,
    );
    await panel.evaluate(() => window.captionExportGate!.release());
    await expect(
      panel.getByText(/TXT·JSON 다운로드를 요청했습니다/),
    ).toBeVisible();
    expect(await panel.evaluate(() => window.captionExportGate!.calls())).toBe(
      2,
    );
    await expect
      .poll(() =>
        panel.evaluate(
          async () =>
            (await window.captionExportGate!.files()).filter(
              ({ state }) => state === "complete",
            ).length,
        ),
      )
      .toBe(2);
    const files = await panel.evaluate(() => window.captionExportGate!.files());
    expect(files).toHaveLength(2);
    expect(new Set(files.map(({ id }) => id)).size).toBe(2);
    expect(files.map(({ mime }) => mime).sort()).toEqual([
      "application/json",
      "text/plain",
    ]);
    const requested = await panel.evaluate(() =>
      window.captionExportGate!.requested(),
    );
    expect(requested).toHaveLength(2);
    expect(requested.every((filename) => filename.startsWith("output/"))).toBe(
      true,
    );
    const names = requested
      .map((filename) => filename.split(/[\\/]/).at(-1)!)
      .sort();
    expect(names.map((name) => name.replace(/\.(json|txt)$/, ""))).toEqual([
      names[0]!.replace(/\.(json|txt)$/, ""),
      names[0]!.replace(/\.(json|txt)$/, ""),
    ]);
    expect(names.map((name) => path.extname(name))).toEqual([".json", ".txt"]);
    expect(names[0]).toMatch(/^uniDock-\d{8}T\d{6}Z-[0-9a-f]{12}\.json$/);
    const jsonPath = files.find(
      ({ mime }) => mime === "application/json",
    )!.filename;
    const txtPath = files.find(({ mime }) => mime === "text/plain")!.filename;
    const [json, text] = await Promise.all([
      readFile(jsonPath!, "utf8"),
      readFile(txtPath!, "utf8"),
    ]);
    expect(text).toBe("00:00 Iframe caption text\n");
    expect(JSON.parse(json)).toMatchObject({
      itemCount: 1,
      items: [{ index: 0, time: "00:00", text: "Iframe caption text" }],
    });
  } finally {
    await context?.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("clearing while the TXT acknowledgement is held prevents the JSON request", async ({
  playwright,
}) => {
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(
    path.join(tmpdir(), "unidock-caption-export-cancel-"),
  );
  const server = await syntheticServer(profile);
  let context: BrowserContext | undefined;
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--host-resolver-rules=MAP mylms.korea.ac.kr 127.0.0.1:${server.port}, MAP kucom.korea.ac.kr 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
        "--no-proxy-server",
        "--ignore-certificate-errors",
      ],
    });
    const { lms, panel, panelUrl } = await openCaptionPanel(
      context,
      server.port,
    );
    await panel.addInitScript(() => {
      const original = chrome.downloads.download.bind(chrome.downloads);
      let calls = 0;
      const ids: number[] = [];
      let finishFirst!: () => void;
      let release!: () => void;
      let finishDrained!: () => void;
      const first = new Promise<void>((resolve) => (finishFirst = resolve));
      const held = new Promise<void>((resolve) => (release = resolve));
      const drained = new Promise<void>((resolve) => (finishDrained = resolve));
      chrome.downloads.download = (async (options) => {
        calls++;
        const result = await original(options);
        ids.push(result);
        if (calls === 1) {
          finishFirst();
          await held;
          queueMicrotask(() => queueMicrotask(finishDrained));
        }
        return result;
      }) as typeof chrome.downloads.download;
      window.captionExportGate = {
        first: () => first,
        drained: () => drained,
        release,
        calls: () => calls,
        files: async () =>
          (await Promise.all(ids.map((id) => chrome.downloads.search({ id }))))
            .flat()
            .map(({ filename, id, mime, state }) => ({
              filename,
              id,
              mime,
              state,
            })),
        requested: () => [],
      };
    });
    await panel.goto(panelUrl);
    await detectAndOpen(panel, lms);

    await panel.getByRole("button", { name: "TXT·JSON 다운로드" }).click();
    await panel.evaluate(() => window.captionExportGate!.first());
    await lms.reload();
    await expect(panel.locator(".detail-view")).toHaveCount(0);
    await panel.evaluate(() => window.captionExportGate!.release());
    await panel.evaluate(() => window.captionExportGate!.drained());

    expect(await panel.evaluate(() => window.captionExportGate!.calls())).toBe(
      1,
    );
    await expect(
      panel.getByText(/TXT 다운로드만|TXT·JSON 다운로드를 요청/),
    ).toHaveCount(0);
  } finally {
    await context?.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
