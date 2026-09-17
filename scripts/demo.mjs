import { URL } from "node:url";

import { chromium, expect } from "@playwright/test";
import { mkdtemp, rm, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { demoOrigin, demoResponses } from "./demo-data.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "npm run demo — 가상 LMS와 uniDock 촬영용 브라우저 열기\nnode scripts/demo.mjs --smoke — 자동 동작 확인 및 캡처 후 종료\n종료: 브라우저 닫기 또는 Ctrl+C. 데이터: scripts/demo-data.mjs",
  );
  process.exit(0);
}
if (args.some((arg) => arg !== "--smoke")) {
  console.error("지원하지 않는 옵션입니다. --help를 확인하세요.");
  process.exit(1);
}
const smoke = args.includes("--smoke");
const extensionPath = path.resolve(".output/chrome-mv3");
await stat(path.join(extensionPath, "manifest.json"));
const profile = await mkdtemp(path.join(tmpdir(), "unidock-demo-"));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: smoke,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--disable-background-networking",
    ],
  });
  process.once("SIGINT", () => {
    void context.close();
  });
  process.once("SIGTERM", () => {
    void context.close();
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "chrome-extension:") return route.continue();
    if (url.origin !== demoOrigin || route.request().method() !== "GET")
      return route.abort();
    const data = demoResponses.get(url.pathname);
    if (data) return route.fulfill({ json: data });
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<!doctype html><html lang="ko"><meta charset="utf-8"><title>uniDock · 가상 데이터 데모</title><h1>uniDock 촬영용 데모</h1><p>가상 데이터를 사용한 데모 화면입니다. 실제 계정이나 LMS 서버에 연결하지 않습니다.</p><p>오른쪽 uniDock에서 조회를 누르세요. 패널이 닫히면 도구 모음의 확장 프로그램 메뉴에서 uniDock을 클릭하세요.</p><p>과목 · 과제 · 마감일 · Upcoming · Todo · 녹화 강의 목록을 확인할 수 있습니다.</p><p>강의 재생과 자막은 이 데모에 포함하지 않습니다.</p></html>',
      });
    return route.fulfill({
      status: 404,
      contentType: "text/plain; charset=utf-8",
      body: "촬영용 데모에 없는 화면입니다. 실제 LMS에는 연결하지 않습니다.",
    });
  });
  const lms = context.pages()[0] ?? (await context.newPage());
  await lms.goto(demoOrigin);
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await lms.bringToFront();
  await panel.getByRole("button", { name: "조회", exact: true }).click();
  await expect(
    panel.getByText("컴퓨터과학 입문", { exact: true }),
  ).toBeVisible();
  if (smoke) {
    await mkdir("output/demo", { recursive: true });
    await panel.screenshot({ path: "output/demo/courses.png" });
    await panel.getByRole("button", { name: "과제 보기" }).first().click();
    await expect(
      panel.getByText("중간 프로젝트 계획서", { exact: true }),
    ).toBeVisible();
    for (const name of ["마감일", "녹화 강의", "전체 일정", "Todo"]) {
      await panel.getByRole("button", { name, exact: true }).click();
      await expect(panel.getByText(/조회 완료/)).toBeVisible();
      await panel.screenshot({ path: `output/demo/${name}.png` });
    }
    const blocked = await lms.evaluate(async () => {
      try {
        await globalThis.fetch("https://example.com/");
        return false;
      } catch {
        return true;
      }
    });
    if (!blocked) throw new Error("External network was not blocked");
    console.log(
      "데모 검증 완료: 과목·과제·마감일·Upcoming·Todo·녹화 강의, 외부 요청 차단. output/demo/",
    );
  } else {
    await panel.evaluate(async () => {
      const window = await globalThis.chrome.windows.getCurrent();
      await globalThis.chrome.sidePanel.open({ windowId: window.id });
    });
    await panel.close();
    await lms.bringToFront();
    console.log(
      "촬영용 브라우저가 열렸습니다. 오른쪽 uniDock에서 조회를 누르세요. 종료: 창 닫기 또는 Ctrl+C.",
    );
    await new Promise((resolve) => context.once("close", resolve));
  }
} finally {
  if (context) await context.close();
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
