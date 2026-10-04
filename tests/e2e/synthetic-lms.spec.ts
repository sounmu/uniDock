import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";
import { playbackBuild } from "./build-shape";
declare global {
  interface Window {
    downloadEvidence?: Promise<chrome.downloads.DownloadItem[]>;
    handoffClipboardWrites?: number;
    releaseHandoffClipboard?: () => void;
  }
}
const extensionPath = path.resolve(".output/chrome-mv3");
const origin = "https://mylms.korea.ac.kr";

test("loads the production MV3 and queries a synthetic LMS through real runtime messaging", async ({
  playwright,
}, testInfo) => {
  // Given: isolated profile and real HTTPS bytes for the Chrome download manager.
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-playwright-"));
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
  const errors: string[] = [];
  const capture = async (page: Page, name: string) => {
    for (const width of [320, 420]) {
      await page.setViewportSize({ width, height: 800 });
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      const main = await page.getByRole("main").boundingBox();
      const navigation = page.getByRole("navigation", { name: "주 메뉴" });
      const menu = await navigation.boundingBox();
      expect(main).not.toBeNull();
      expect(menu).not.toBeNull();
      expect(main!.x).toBe(0);
      expect(main!.width).toBe(width);
      expect(menu!.y + menu!.height).toBeLessThanOrEqual(main!.y);
      const buttons = await navigation.getByRole("button").all();
      const boxes = await Promise.all(
        buttons.map((button) => button.boundingBox()),
      );
      expect(boxes).toHaveLength(4);
      for (const box of boxes) {
        expect(box).not.toBeNull();
        expect(box!.y).toBe(boxes[0]!.y);
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      const screenshot = testInfo.outputPath(`${name}-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach(`${name}-${width}`, {
        path: screenshot,
        contentType: "image/png",
      });
    }
  };
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 420, height: 800 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--host-resolver-rules=MAP mylms.korea.ac.kr 127.0.0.1:${server.port}, MAP chatgpt.com 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
        "--no-proxy-server",
        "--ignore-certificate-errors",
      ],
    });
    const browser = context.browser();
    if (!browser) throw new Error("Missing synthetic browser");
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    await cdp.detach();
    await context.tracing.start({ screenshots: true, snapshots: true });
    context.on("page", (page) =>
      page.on("pageerror", (error) => errors.push(error.message)),
    );
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
    // When: the production panel sends through tabs -> content -> API/background.
    await panel.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect(panel.getByText("조회 완료 · 2개 과목")).toBeVisible();
    expect(server.coursesSeen()).toBe(true);
    await expect(
      panel
        .getByRole("navigation", { name: "주 메뉴", exact: true })
        .getByRole("button"),
    ).toHaveCount(4);
    const initialCourseRequests = server.coursesCount();
    await panel.getByRole("button", { name: "내 과목", exact: true }).click();
    await expect(panel.getByText("조회 완료 · 2개 과목")).toBeVisible();
    expect(server.coursesCount()).toBe(initialCourseRequests);
    await panel.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect(panel.getByText("조회 완료 · 2개 과목")).toBeVisible();
    expect(server.coursesCount()).toBe(initialCourseRequests + 1);
    await capture(panel, "courses");
    await panel
      .getByRole("button", { name: /Synthetic Operating Systems/ })
      .click();
    await expect(
      panel.getByText("Synthetic Final Project", { exact: true }),
    ).toBeVisible();
    await panel.getByText("보기 설정", { exact: true }).click();
    await expect(
      panel.getByRole("checkbox", { name: "남은 과제만" }),
    ).toBeChecked();
    await expect(
      panel.getByRole("combobox", { name: "마감 기간" }),
    ).toHaveValue("all");
    await expect(
      panel.getByRole("combobox", { name: "정렬", exact: true }),
    ).toHaveValue("original");
    await capture(panel, "assignments-settings");
    await panel
      .getByRole("button", { name: /Synthetic Final Project/ })
      .click();
    await expect(panel.locator(".detail-view dl")).toBeVisible();
    await capture(panel, "assignment-detail");
    await panel.getByRole("button", { name: "← 목록" }).click();
    await panel.getByRole("button", { name: "강의 자료", exact: true }).click();
    await expect(
      panel.getByRole("heading", { name: "강의 자료 · 2개" }),
    ).toBeVisible();
    await capture(panel, "materials-ready");
    await panel
      .getByRole("checkbox", { name: "전체 선택", exact: true })
      .check();
    await panel.getByRole("button", { name: /lecture.pdf/ }).click();
    const opened = context.waitForEvent("page");
    await panel.getByRole("button", { name: "LMS에서 열기" }).click();
    const documentPage = await opened;
    await documentPage.waitForLoadState("domcontentloaded");
    expect(documentPage.url()).toBe(`${origin}/courses/101/modules/items/900`);
    await documentPage.close();
    await panel.getByRole("button", { name: "← 목록" }).click();
    await expect(
      panel.getByRole("checkbox", { name: "전체 선택", exact: true }),
    ).toBeChecked();
    // Subscribe before triggering; no sleeps or download-history polling.
    await panel.evaluate(() => {
      window.downloadEvidence = new Promise((resolve, reject) => {
        const items = new Map<number, chrome.downloads.DownloadItem>();
        const finish = () => {
          clearTimeout(timeout);
          chrome.downloads.onCreated.removeListener(created);
          chrome.downloads.onChanged.removeListener(changed);
        };
        const accept = (item: chrome.downloads.DownloadItem) => {
          items.set(item.id, item);
          if (item.state === "interrupted") {
            finish();
            reject(new Error(`Download interrupted: ${item.error}`));
          }
          if (
            items.size === 2 &&
            [...items.values()].every((value) => value.state === "complete")
          ) {
            finish();
            resolve([...items.values()]);
          }
        };
        const created = (item: chrome.downloads.DownloadItem) => accept(item);
        const changed = (delta: chrome.downloads.DownloadDelta) => {
          if (items.has(delta.id))
            void chrome.downloads.search({ id: delta.id }).then(
              (values) => {
                values.forEach(accept);
              },
              (error: unknown) => {
                finish();
                reject(error);
              },
            );
        };
        const timeout = setTimeout(() => {
          finish();
          reject(
            new Error(
              `Missing download completion event: ${JSON.stringify([...items.values()].map(({ id, byExtensionId, state, filename, mime }) => ({ id, byExtensionId, state, filename, mime })))}`,
            ),
          );
        }, 15000);
        chrome.downloads.onCreated.addListener(created);
        chrome.downloads.onChanged.addListener(changed);
      });
    });
    await panel.getByRole("button", { name: "선택 다운로드 (2)" }).click();
    const downloads = await panel.evaluate(() => window.downloadEvidence);
    // Then: actual completed files, bytes, paths, MIME and UI status agree.
    expect(downloads).toHaveLength(2);
    for (const item of downloads ?? []) {
      expect(item.byExtensionId).toBe(extensionId);
      expect(item.state).toBe("complete");
      expect(item.mime).toBe("application/pdf");
      expect(item.filename).toContain(
        "/uniDock/Synthetic Operating Systems/Week 1/",
      );
      expect(item.filename.startsWith(downloadDirectory)).toBe(true);
      expect(await readFile(item.filename)).toEqual(server.pdf);
    }
    expect(server.downloads).toEqual([
      "/courses/101/files/501/download",
      "/courses/101/files/502/download",
    ]);
    await expect(
      panel.locator(".status-chip").filter({ hasText: /^완료$/ }),
    ).toHaveCount(2);
    await capture(panel, "materials-complete");
    await expect(
      panel.getByRole("button", { name: "다운로드 폴더 열기" }),
    ).toBeVisible();
    await panel.evaluate(() => {
      window.handoffClipboardWrites = 0;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () => {
            window.handoffClipboardWrites! += 1;
            return new Promise<void>((resolve) => {
              window.releaseHandoffClipboard = resolve;
            });
          },
        },
      });
    });
    const requestStart = server.requests.length;
    const handoff = context.waitForEvent("page");
    const handoffButton = panel.getByRole("button", {
      name: "ChatGPT에서 질문하기",
    });
    await handoffButton.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(handoffButton).toBeDisabled();
    expect(await panel.evaluate(() => window.handoffClipboardWrites)).toBe(1);
    expect(
      context.pages().filter((page) => page.url() === "https://chatgpt.com/"),
    ).toHaveLength(0);
    await panel.evaluate(() => window.releaseHandoffClipboard?.());
    const chat = await handoff;
    await chat.waitForLoadState("domcontentloaded");
    expect(chat.url()).toBe("https://chatgpt.com/");
    expect(
      context.pages().filter((page) => page.url() === "https://chatgpt.com/"),
    ).toHaveLength(1);
    const chatRequests = server.requests
      .slice(requestStart)
      .filter(({ host }) => host.startsWith("chatgpt.com"));
    expect(chatRequests.length).toBeGreaterThan(0);
    expect(chatRequests.every(({ method }) => method === "GET")).toBe(true);
    expect(server.downloads).toEqual([
      "/courses/101/files/501/download",
      "/courses/101/files/502/download",
    ]);
    await chat.close();
    await lms.bringToFront();
    await panel
      .getByRole("button", { name: "할 일·일정", exact: true })
      .click();
    await expect(
      panel.getByText("조회 완료 · 3개 항목 · 한국 시간"),
    ).toBeVisible();
    await expect(panel.getByText("Synthetic Submitted Essay")).toHaveCount(0);
    await expect(panel.getByText("Synthetic Undated Reading")).toBeVisible();
    await expect(panel.getByText("Synthetic Early Deadline")).toBeVisible();
    await expect(
      panel.locator(".status-chip").filter({ hasText: /^미제출$/ }),
    ).toHaveCount(3);
    await panel.getByText("보기 설정", { exact: true }).click();
    const sort = panel.getByRole("combobox", { name: "정렬", exact: true });
    await sort.selectOption("due");
    await expect(panel.locator("li strong").first()).toHaveText(
      "Synthetic Early Deadline",
    );
    await capture(panel, "tasks-settings");
    await sort.selectOption("original");
    await expect(panel.locator("li strong").first()).toHaveText(
      "Synthetic Final Project",
    );
    await capture(panel, "tasks");
    await panel.getByRole("button", { name: "일정", exact: true }).click();
    await expect(panel.getByText("조회된 항목이 없습니다.")).toBeVisible();
    await capture(panel, "schedule-empty");
    await panel.getByText("보기 설정", { exact: true }).click();
    await expect(panel.getByLabel("시작일 (선택)")).toBeVisible();
    await capture(panel, "schedule-settings");
    await panel.getByRole("button", { name: "자막 추출", exact: true }).click();
    await capture(panel, "captions");
    await panel.getByRole("button", { name: "자막 감지" }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "TXT·JSON 다운로드" }),
    ).toHaveCount(0);
    await capture(panel, "captions-error");
    await lms.evaluate(() => {
      const list = document.createElement("ul");
      list.id = "cs-script-list";
      const row = document.createElement("li");
      row.className = "cs-script-item";
      const time = document.createElement("span");
      time.className = "cs-script-item-time";
      time.textContent = "00:01";
      const text = document.createElement("span");
      text.className = "cs-script-item-text";
      text.textContent = "Synthetic caption";
      row.append(time, text);
      list.append(row);
      document.body.append(list);
    });
    await panel.getByRole("button", { name: "자막 감지" }).click();
    await expect(panel.locator(".list-row")).toHaveCount(1);
    await capture(panel, "captions-result");
    await panel.locator(".list-row").click();
    await expect(
      panel.getByRole("button", { name: "TXT·JSON 다운로드" }),
    ).toBeVisible();
    await capture(panel, "caption-detail");
    await panel.getByRole("button", { name: "← 목록" }).click();
    await expect(panel.locator(".list-row")).toBeFocused();
    const playbackMenu = panel.getByRole("button", {
      name: "자동 재생",
      exact: true,
    });
    if (playbackBuild()) {
      await playbackMenu.click();
      await expect(playbackMenu).toHaveAttribute("aria-current", "page");
      await expect(playbackMenu).toHaveCSS(
        "background-color",
        "rgb(135, 32, 56)",
      );
      await expect(playbackMenu).toHaveCSS("color", "rgb(255, 255, 255)");
      await expect(playbackMenu.locator("svg")).toHaveCSS(
        "color",
        "rgb(255, 255, 255)",
      );
      await capture(panel, "playback");
    } else {
      // Release builds keep the menu entry as a pending notice only.
      const notice = panel.getByRole("tooltip", {
        name: "현재 검토 중인 기능입니다.",
      });
      await expect(playbackMenu).toHaveAttribute("aria-disabled", "true");
      await expect(playbackMenu).toHaveAccessibleDescription(
        "현재 검토 중인 기능입니다.",
      );
      await expect(notice).toBeHidden();
      await playbackMenu.hover();
      await expect(notice).toBeVisible();
      // Playwright treats aria-disabled as not actionable; a user's click
      // still lands on the button and must be a no-op.
      await playbackMenu.click({ force: true });
      await expect(playbackMenu).not.toHaveAttribute("aria-current", "page");
      await expect(
        panel.getByRole("region", { name: "자동 재생" }),
      ).toHaveCount(0);
      await capture(panel, "playback-pending");
      await panel.mouse.move(0, 0);
      await expect(notice).toBeHidden();
      // Keyboard focus (focus-visible) shows the same notice without hover.
      await playbackMenu.focus();
      await panel.keyboard.press("Tab");
      await panel.keyboard.press("Shift+Tab");
      await expect(playbackMenu).toBeFocused();
      await expect(notice).toBeVisible();
    }
    await panel.getByRole("button", { name: "정보", exact: true }).click();
    await expect(
      panel.getByRole("heading", { name: "정보", exact: true }),
    ).toBeVisible();
    await capture(panel, "info");
    await panel.getByRole("button", { name: "내 과목", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "내 과목", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(panel.getByRole("heading", { name: "내 과목" })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    if (context) {
      await context.tracing.stop({
        path: testInfo.outputPath("runtime-messaging-trace.zip"),
      });
      await context.close();
    }
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
