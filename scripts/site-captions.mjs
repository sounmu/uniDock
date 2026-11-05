import { build, preview } from "vite";
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import console from "node:console";
import { URL } from "node:url";
import {
  captionOrigin,
  captionTranscript,
  installCaptionFixture,
} from "./site-captions-fixture.mjs";

// Render the real app entrypoint, drive its controls, then freeze its completed DOM.
// A queued create response models the API's existing-job path: no audio upload or
// paid inference. All HTTP except the local app is blocked or fulfilled here.
export async function captureSiteCaptions(target) {
  const outDir = ".site-captions-build";
  const evidenceDir = path.resolve("output/site-captions");
  await mkdir(target, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  let server;
  let browser;
  try {
    await build({
      configFile: false,
      logLevel: "error",
      define: {
        __UNIDOCK_PLAYBACK__: "false",
        __UNIDOCK_AI_CAPTIONS__: "true",
        __UNIDOCK_CAPTION_SERVER__: JSON.stringify(captionOrigin),
        __UNIDOCK_STATS_SERVER__: '""',
      },
      build: {
        outDir,
        rollupOptions: { input: "entrypoints/sidepanel/index.html" },
      },
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
      viewport: { width: 440, height: 600 },
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      colorScheme: "light",
    });
    await context.addInitScript(installCaptionFixture);
    const requests = [];
    const errors = [];
    let polls = 0;
    let failRestoredJob = false;
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      requests.push({
        method: route.request().method(),
        path: url.pathname,
        origin: url.origin,
      });
      assert.equal(url.origin, captionOrigin, "Unexpected external request");
      const method = route.request().method();
      if (url.pathname === "/v1/transcription-jobs" && method === "POST") {
        const payload = route.request().postDataJSON();
        assert.equal(payload.language, "ko");
        return route.fulfill({
          json: { id: "site-fixture-job", state: "queued" },
        });
      }
      if (
        url.pathname === "/v1/transcription-jobs/site-fixture-job" &&
        method === "GET"
      ) {
        if (failRestoredJob) return route.abort("failed");
        polls++;
        return route.fulfill({
          json:
            polls === 1
              ? {
                  id: "site-fixture-job",
                  state: "running",
                  progress: { stage: "transcribing", done: 6, total: 12 },
                }
              : {
                  id: "site-fixture-job",
                  state: "succeeded",
                  transcript_id: "site-fixture-transcript",
                },
        });
      }
      if (
        url.pathname === "/v1/transcripts/site-fixture-transcript" &&
        method === "GET"
      )
        return route.fulfill({ json: captionTranscript });
      await route.abort();
      throw new Error(`Unexpected fixture endpoint: ${method} ${url.pathname}`);
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(error);
    });
    await page.goto(`${origin}/entrypoints/sidepanel/index.html`);
    await page.getByRole("button", { name: "자막 추출", exact: true }).click();
    await page.getByRole("button", { name: "자막 감지", exact: true }).click();
    await expect(
      page.getByText("제공된 자막이 없어요", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "AI 자막 만들기", exact: true })
      .click();
    await expect(
      page.getByRole("group", { name: "AI 자막 생성 확인" }),
    ).toBeVisible();
    await page.screenshot({ path: path.join(evidenceDir, "confirmation.png") });
    await page
      .getByRole("button", { name: "음성 보내기", exact: true })
      .click();
    await expect(
      page.getByText("자막을 만들고 있어요", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: path.join(evidenceDir, "running.png") });
    for (const format of ["TXT", "JSON"]) {
      const download = page.getByRole("button", {
        name: `${format} 받기`,
        exact: true,
      });
      await expect(download).toBeVisible();
      await download.click();
      await expect(
        page.getByText(`output/ 폴더로 ${format} 다운로드를 시작했어요.`, {
          exact: true,
        }),
      ).toBeVisible();
    }
    const evidence = await page.evaluate(() => globalThis.__siteCaptionFixture);
    assert.equal(evidence.downloads.length, 2);
    assert.match(evidence.downloads[0].filename, /AI 자막\.txt$/);
    assert.match(evidence.downloads[1].filename, /AI 자막\.json$/);
    const exported = JSON.parse(evidence.downloads[1].body);
    assert.equal(exported.itemCount, captionTranscript.segments.length);
    assert.deepEqual(
      exported.items.map((item) => item.text),
      captionTranscript.segments.map((segment) => segment.text),
    );
    for (const segment of captionTranscript.segments)
      assert(evidence.downloads[0].body.includes(segment.text));
    assert.deepEqual(errors, []);
    assert.equal(polls, 2);
    await page.evaluate(() => globalThis.document.fonts.ready);
    await page.screenshot({ path: path.join(evidenceDir, "completed.png") });
    const css = await readFile("entrypoints/sidepanel/style.css", "utf8");
    const markup = await page.locator("#root").innerHTML();
    // Keep the actual rendered DOM and stylesheet. No React/Chrome runtime,
    // synthetic session, API responses, or bundled application JS is published.
    await writeFile(
      path.join(target, "captions.html"),
      `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>uniDock AI 자막 완료 · 가상 데이터 샘플</title><style>${css}</style></head><body><div id="root">${markup}</div></body></html>\n`,
    );
    await writeFile(
      path.join(evidenceDir, "capture.json"),
      JSON.stringify(
        {
          entrypoint: "entrypoints/sidepanel/index.html",
          requests,
          polls,
          ...evidence,
          errors,
        },
        null,
        2,
      ) + "\n",
    );
    // Seed a long transcript through the same storage boundary, then reopen.
    await page.evaluate(async () => {
      const name = "unidock.caption-transcripts.v1";
      const records = (await globalThis.chrome.storage.local.get(name))[name];
      const record = Object.values(records)[0];
      record.items = Array.from({ length: 350 }, (_, index) => ({
        index,
        time: `${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`,
        text: `${index + 1}. 해시 테이블에서 충돌이 발생하면 체이닝을 이용해 같은 위치에 여러 값을 보관합니다.`,
      }));
      await globalThis.chrome.storage.local.set({ [name]: records });
    });
    const requestCount = requests.length;
    await page.reload();
    await page.getByRole("button", { name: "자막 추출", exact: true }).click();
    await expect(page.locator(".ai-reader-text li")).toHaveCount(350);
    assert.equal(requests.length, requestCount, "Cache restore must not call the caption server");
    for (const width of [320, 440]) {
      await page.setViewportSize({ width, height: 700 });
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        await page.reload();
        await page.getByRole("button", { name: "자막 추출", exact: true }).click();
        await expect(page.locator(".ai-reader-text li")).toHaveCount(350);
        await page.locator(".ai-reader-text").evaluate((el) => { el.scrollTop = 0; });
        await page.screenshot({ animations: "disabled", path: path.join(evidenceDir, `reader-${width}-${colorScheme}.png`) });
        await page.locator(".ai-reader-text li").last().scrollIntoViewIfNeeded();
        await expect(page.locator(".ai-reader-text li").last()).toBeVisible();
        assert(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
        await page.screenshot({ animations: "disabled", path: path.join(evidenceDir, `reader-${width}-${colorScheme}-end.png`) });
      }
    }
    assert.equal(requests.length, requestCount);
    failRestoredJob = true;
    await page.evaluate(() => globalThis.chrome.storage.local.set({
      "unidock.caption-transcripts.v1": {},
    }));
    for (const width of [320, 440]) {
      await page.setViewportSize({ width, height: 700 });
      await page.emulateMedia({ colorScheme: width === 320 ? "light" : "dark" });
      await page.reload();
      await page.getByRole("button", { name: "자막 추출", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("자막 서버에 연결하지 못했습니다.");
      await expect(page.getByRole("button", { name: "다시 시도", exact: true })).toBeVisible();
      await page.screenshot({ animations: "disabled", path: path.join(evidenceDir, `restore-error-${width}.png`) });
      await page.getByRole("button", { name: "다시 시도", exact: true }).click();
      await expect(page.getByRole("group", { name: "AI 자막 생성 확인" })).toBeVisible();
    }
  } finally {
    if (browser) await browser.close();
    if (server)
      await new Promise((resolve, reject) =>
        server.httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(outDir, { recursive: true, force: true });
  }
}
