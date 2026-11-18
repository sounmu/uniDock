import { build, preview } from "vite";
import { chromium, expect } from "@playwright/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { URL } from "node:url";

// Drive the real playback-enabled side panel with a synthetic worker reply
// (a playing playlist), then freeze its rendered DOM. No LMS or network.
function installPlaybackFixture() {
  const event = { addListener() {}, removeListener() {} };
  const titles = [
    ["101:1001", "7주차 1차시 · 힙과 우선순위 큐"],
    ["101:1002", "7주차 2차시 · 힙 정렬"],
    ["101:1003", "8주차 1차시 · 해시 함수"],
    ["101:1004", "8주차 2차시 · 충돌 해결"],
    ["101:1005", "9주차 1차시 · 그래프 표현"],
  ];
  const [current, ...queue] = titles.map(([id]) => ({ id, courseId: "101" }));
  const snapshot = {
    courses: [{ id: "101", name: "자료구조" }],
    labels: Object.fromEntries(titles),
    queue,
    status: "playing",
    current,
  };
  const tab = { id: 7, windowId: 1, url: "https://mylms.korea.ac.kr/", title: "LMS" };
  const values = {};
  const storage = {
    get: async (key) => (typeof key === "string" ? { [key]: values[key] } : {}),
    set: async (patch) => void Object.assign(values, patch),
    remove: async () => {},
  };
  globalThis.chrome = {
    runtime: {
      id: "fixture",
      getURL: (p) => `chrome-extension://fixture/${p}`,
      getManifest: () => ({ version: "0.0.0" }),
      onMessage: event,
      sendMessage: async (message) => {
        if (String(message?.type).startsWith("PLAYBACK_"))
          return { status: "success", snapshot };
        if (message?.type === "UPDATE_NOTICE_TAKE") return { updated: false };
        if (message?.type === "ANALYTICS_STATUS")
          return { available: false, enabled: false, notice: null };
        return { status: "error", code: "OPEN_LMS" };
      },
    },
    storage: { local: storage, session: storage, onChanged: event },
    tabs: { query: async () => [tab], get: async () => tab, onUpdated: event, onRemoved: event, onActivated: event },
    windows: { onFocusChanged: event },
    permissions: { contains: async () => true, request: async () => true },
    downloads: { onCreated: event, onChanged: event },
  };
}

export async function capturePlayback(target) {
  const outDir = ".store-playback-build";
  let server;
  let browser;
  try {
    await build({
      configFile: false,
      logLevel: "error",
      define: {
        __UNIDOCK_PLAYBACK__: "true",
        __UNIDOCK_AI_CAPTIONS__: "false",
        __UNIDOCK_STATS_SERVER__: '""',
      },
      build: { outDir, rollupOptions: { input: "entrypoints/sidepanel/index.html" } },
    });
    server = await preview({
      configFile: false,
      logLevel: "error",
      build: { outDir },
      preview: { host: "127.0.0.1", port: 0 },
    });
    const address = server.httpServer.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext({
      viewport: { width: 420, height: 700 },
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      colorScheme: "light",
    });
    await context.addInitScript(installPlaybackFixture);
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/entrypoints/sidepanel/index.html`);
    await page.getByRole("button", { name: "자동 재생", exact: true }).click();
    await expect(page.getByText("자동 재생 · 재생 중", { exact: true })).toBeVisible();
    await expect(page.locator(".playback-queue li")).toHaveCount(5);
    assert.deepEqual(errors, []);
    await page.evaluate(() => globalThis.document.fonts.ready);
    const css = await readFile("entrypoints/sidepanel/style.css", "utf8");
    const markup = await page.locator("#root").innerHTML();
    await writeFile(
      path.join(target, "playback-panel.html"),
      `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root">${markup}</div></body></html>\n`,
    );
  } finally {
    if (browser) await browser.close();
    if (server)
      await new Promise((resolve, reject) =>
        server.httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(outDir, { recursive: true, force: true });
  }
}
