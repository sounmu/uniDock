import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const extensionPath = path.resolve(".output/chrome-mv3");
const origin = "https://mylms.korea.ac.kr";
const kuPlayer = "https://kucom.korea.ac.kr";

function playerHtml(id: string): string {
  return `<!doctype html><html><title>Synthetic Player ${id}</title><body>
    <script>
      const video = document.createElement("video");
      for (let i = 0; i < 10; i++) {
        const placeholder = document.createElement("video");
        placeholder.style.display = "none";
        document.body.append(placeholder);
      }
      video.id = "lecture";
      video.className = "vc-vplay-video1";
      const main = document.createElement("div");
      main.className = "vc-vplay-container non-selectable";
      document.body.append(main);
      // KU may keep the native video at zero width until playback initializes.
      video.style.width = "0px";
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      for (const type of ["playing", "pause", "ended", "ratechange", "error"])
        video.addEventListener(type, () => console.log("UNIDOCK_QA_" + type.toUpperCase() + ":${id}"));
      const canvas = document.createElement("canvas");
      canvas.width = 64; canvas.height = 48;
      const paint = canvas.getContext("2d");
      const stream = canvas.captureStream(24);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
      const parts = [];
      recorder.ondataavailable = (event) => parts.push(event.data);
      recorder.onstop = () => {
        const blob = new Blob(parts, { type: "video/webm" });
        video.src = URL.createObjectURL(blob);
        const start = document.createElement("button");
        start.className = "vc-front-screen-play-btn";
        start.textContent = "Start lecture";
        start.onclick = () => {
          start.style.display = "none";
          video.src = URL.createObjectURL(blob);
          video.load();
          void video.play();
        };
        document.body.append(start);
        const helper = document.createElement("video");
        helper.className = "vc-sdvideo-video";
        helper.id = "auxiliary";
        helper.preload = "auto";
        helper.muted = true;
        helper.src = video.src;
        helper.addEventListener("loadedmetadata", () => {
          setTimeout(() => { main.append(video); video.load(); }, 100);
        }, { once: true });
        document.body.append(helper);
        helper.load();
        stream.getTracks().forEach(track => track.stop());
      };
      recorder.start();
      let frame = 0;
      const draw = setInterval(() => {
        paint.fillStyle = frame % 2 ? "#872038" : "#f8f7f5";
        paint.fillRect(0, 0, 64, 48);
        if (++frame >= 200) { clearInterval(draw); recorder.stop(); }
      }, 20);
    </script>
  </body></html>`;
}

test("production playback stays bound to the listing document across LMS tabs", async ({
  playwright,
}) => {
  test.setTimeout(120_000);
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-source-binding-"));
  let context: BrowserContext | undefined;
  const apiRequests = new Map<string, number>();
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: process.env.CI === "true",
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    await context.route(`${origin}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/api/v1/"))
        apiRequests.set(url.pathname, (apiRequests.get(url.pathname) ?? 0) + 1);
      const json: Record<string, unknown> = {
        "/api/v1/users/self": { id: 71 },
        "/api/v1/courses": [{ id: 101, name: "합성 운영체제" }],
        "/api/v1/courses/101/assignments": [],
        "/api/v1/planner/items": [],
        "/api/v1/courses/101/modules": [
          {
            id: 20,
            name: "1주차",
            published: true,
            items_count: 2,
            items: [
              {
                id: 501,
                type: "ExternalTool",
                title: "첫 영상",
                html_url: `${origin}/courses/101/modules/items/501`,
              },
              {
                id: 502,
                type: "ExternalTool",
                title: "둘째 영상",
                html_url: `${origin}/courses/101/modules/items/502`,
              },
            ],
          },
        ],
      };
      if (url.pathname in json) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: json[url.pathname],
        });
        return;
      }
      if (/^\/courses\/101\/modules\/items\/(501|502)$/.test(url.pathname)) {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><title>Synthetic item</title><body>item</body></html>",
        });
        return;
      }
      if (url.pathname === "/") {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><title>Synthetic LMS</title><body>LMS</body></html>",
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });

    const a = await context.newPage();
    await a.goto(`${origin}/?source=A`);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    expect(
      await panel.evaluate(() =>
        chrome.runtime.sendMessage({ version: 1, type: "PLAYBACK_REFRESH" }),
      ),
    ).toMatchObject({ status: "success" });

    const b = await context.newPage();
    await b.goto(`${origin}/?source=B`);
    const c = await context.newPage();
    await c.goto(`${origin}/?source=C`);
    await c.bringToFront();

    const listFrom = async (page: Page) => {
      const pageUrl = page.url();
      return panel.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({
          url: [`${new URL(url).origin}/*`],
        });
        const tab = tabs.find((candidate) => candidate.url === url);
        if (tab?.id === undefined) throw new Error("missing listing tab");
        const result = (await chrome.tabs.sendMessage(
          tab.id,
          { version: 1, type: "RECORDINGS_LIST", course: "합성 운영체제" },
          { frameId: 0 },
        )) as {
          status: string;
          recordings?: { launchHandle: string }[];
          documentToken?: string;
        };
        if (
          result.status !== "success" ||
          result.recordings?.length !== 2 ||
          !result.documentToken
        )
          throw new Error("missing bound catalog");
        return {
          sourceTabId: tab.id,
          documentToken: result.documentToken,
          handles: result.recordings.map(({ launchHandle }) => launchHandle),
        };
      }, pageUrl);
    };

    const listing = await listFrom(b);
    apiRequests.clear();
    expect(
      await panel.evaluate((command) => chrome.runtime.sendMessage(command), {
        version: 1,
        type: "PLAYBACK_START",
        handles: listing.handles,
        sourceTabId: listing.sourceTabId,
        documentToken: listing.documentToken,
      }),
    ).toMatchObject({ status: "success" });
    expect(apiRequests.get("/api/v1/users/self")).toBe(3);
    expect(apiRequests.get("/api/v1/courses")).toBe(1);
    expect(apiRequests.get("/api/v1/courses/101/modules")).toBe(1);
    await panel.evaluate(() =>
      chrome.runtime.sendMessage({ version: 1, type: "PLAYBACK_STOP_ALL" }),
    );

    await b.reload();
    expect(
      await panel.evaluate((command) => chrome.runtime.sendMessage(command), {
        version: 1,
        type: "PLAYBACK_START",
        handles: [listing.handles[1]!],
        sourceTabId: listing.sourceTabId,
        documentToken: listing.documentToken,
      }),
    ).toEqual({ status: "error", code: "RELOAD_TAB" });

    const reloadedListing = await listFrom(b);
    await b.close();
    await c.bringToFront();
    expect(
      await panel.evaluate((command) => chrome.runtime.sendMessage(command), {
        version: 1,
        type: "PLAYBACK_START",
        handles: [reloadedListing.handles[0]!],
        sourceTabId: reloadedListing.sourceTabId,
        documentToken: reloadedListing.documentToken,
      }),
    ).toEqual({ status: "error", code: "RELOAD_TAB" });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("production extension plays a click-ordered playlist and explicitly recovers login", async ({
  playwright,
}, testInfo) => {
  test.setTimeout(180_000);
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-playlist-"));
  let context: BrowserContext | undefined;
  let loggedIn = true;
  let identityRequests = 0;
  let identityGate:
    | {
        started: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  const actions: string[] = [];

  function record(text: string) {
    if (!text.startsWith("UNIDOCK_QA_")) return;
    actions.push(text);
  }

  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: process.env.CI === "true",
      viewport: { width: 375, height: 760 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    const listen = (page: Page) => {
      page.on("console", (message) => {
        record(message.text());
        if (message.type() === "error")
          actions.push(`CONSOLE_ERROR:${message.text()}`);
      });
      page.on("pageerror", (error) =>
        actions.push(`PAGE_ERROR:${error.message}`),
      );
    };
    context.on("page", listen);
    for (const page of context.pages()) listen(page);

    await context.route(`${origin}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><title>Synthetic LMS</title><body><h1>Synthetic LMS</h1></body></html>",
        });
        return;
      }
      const item = /^\/courses\/101\/modules\/items\/(501|502)$/.exec(
        url.pathname,
      );
      if (item) {
        actions.push(`LMS_ITEM:${item[1]}`);
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<!doctype html><html><title>Module Item</title><body><iframe allow="autoplay" src="${kuPlayer}/em/native?id=${item[1]}"></iframe></body></html>`,
        });
        return;
      }
      if (url.pathname === "/api/v1/users/self" && !loggedIn) {
        identityRequests++;
        await route.fulfill({ status: 401, body: "login required" });
        return;
      }
      if (url.pathname === "/api/v1/users/self") {
        identityRequests++;
        const gate = identityGate;
        if (gate) {
          gate.started.resolve();
          await gate.release.promise;
          if (identityGate === gate) identityGate = undefined;
        }
      }
      const values: Record<string, unknown> = {
        "/api/v1/users/self": { id: 71 },
        "/api/v1/courses": [{ id: 101, name: "합성 운영체제" }],
        "/api/v1/courses/101/assignments": [],
        "/api/v1/planner/items": [],
        "/api/v1/courses/101/modules": [
          {
            id: 20,
            name: "1주차",
            published: true,
            items_count: 2,
            items: [
              {
                id: 501,
                type: "ExternalTool",
                title: "첫 번째 합성 영상",
                html_url: `${origin}/courses/101/modules/items/501`,
              },
              {
                id: 502,
                type: "ExternalTool",
                title: "두 번째 합성 영상",
                html_url: `${origin}/courses/101/modules/items/502`,
              },
            ],
          },
        ],
      };
      if (url.pathname in values) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(values[url.pathname]),
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });
    await context.route(`${kuPlayer}/em/**`, async (route) => {
      const id = new URL(route.request().url()).searchParams.get("id") ?? "";
      actions.push(`PLAYER_FRAME:${id}`);
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: playerHtml(id),
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
      if (message.type() === "error")
        actions.push(`WORKER_CONSOLE_ERROR:${message.text()}`);
    });
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    const secondPanel = await context.newPage();
    await secondPanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await lms.bringToFront();
    await panel.getByRole("button", { name: "자동 재생" }).click();
    await secondPanel.getByRole("button", { name: "자동 재생" }).click();
    await secondPanel.getByRole("button", { name: "영상 선택" }).click();
    await expect(secondPanel.getByLabel("과목 선택")).toContainText(
      "합성 운영체제",
    );
    await secondPanel.getByRole("button", { name: "← 목록" }).click();
    await panel.getByRole("button", { name: "영상 선택" }).click();
    await panel
      .getByLabel("과목 선택")
      .selectOption({ label: "합성 운영체제" });

    const second = panel.getByRole("checkbox", { name: "두 번째 합성 영상" });
    const first = panel.getByRole("checkbox", { name: "첫 번째 합성 영상" });
    await second.check();
    await first.check();
    await expect(second.locator("xpath=following-sibling::*[1]")).toHaveText(
      "1",
    );
    await expect(first.locator("xpath=following-sibling::*[1]")).toHaveText(
      "2",
    );

    await panel
      .locator(".detail-view")
      .getByRole("button", { name: "자동 재생", exact: true })
      .click();
    await expect(panel.locator(".playback-panel h1")).toContainText("재생 중", {
      timeout: 30_000,
    });
    await expect(panel.locator(".playback-current")).toContainText(
      "두 번째 합성 영상",
    );
    await expect(panel.locator(".playback-queue")).toContainText(
      "첫 번째 합성 영상",
    );
    const secondPage = context
      .pages()
      .find((page) => /\/courses\/101\/modules\/items\/502$/.test(page.url()));
    expect(secondPage).toBeDefined();
    await expect
      .poll(() =>
        secondPage!
          .frameLocator('iframe[src*="kucom.korea.ac.kr"]')
          .locator("video#lecture")
          .evaluate((video: HTMLVideoElement) => video.paused),
      )
      .toBe(false);
    expect(
      await secondPage!
        .frameLocator('iframe[src*="kucom.korea.ac.kr"]')
        .locator("video#auxiliary")
        .evaluate((video: HTMLVideoElement) => video.paused),
    ).toBe(true);
    expect(
      await secondPage!
        .frameLocator('iframe[src*="kucom.korea.ac.kr"]')
        .locator("video#lecture")
        .evaluate((video: HTMLVideoElement) => video.playbackRate),
    ).toBe(1);

    const beforeOtherWindow = await secondPage!
      .frameLocator('iframe[src*="kucom.korea.ac.kr"]')
      .locator("video#lecture")
      .evaluate((video: HTMLVideoElement) => video.currentTime);
    const crossWindow = await worker.evaluate(
      async ({ playerUrl, otherUrl }) => {
        const playerTab = (await chrome.tabs.query({})).find(
          (tab) => tab.url === playerUrl,
        );
        if (playerTab?.id === undefined || playerTab.windowId === undefined)
          throw new Error("missing dedicated player tab");
        const created = await chrome.windows.create({
          url: otherUrl,
          focused: true,
          type: "normal",
        });
        const otherTab = created?.tabs?.[0];
        if (!created || created.id === undefined || otherTab?.id === undefined)
          throw new Error("missing second window tab");
        await chrome.tabs.update(otherTab.id, { active: true });
        const [currentPlayer, currentOther] = await Promise.all([
          chrome.tabs.get(playerTab.id),
          chrome.tabs.get(otherTab.id),
        ]);
        return {
          playerTabId: currentPlayer.id,
          playerWindowId: currentPlayer.windowId,
          playerActive: currentPlayer.active,
          otherTabId: currentOther.id,
          otherWindowId: currentOther.windowId,
          otherActive: currentOther.active,
          createdWindowId: created.id,
        };
      },
      {
        playerUrl: secondPage!.url(),
        otherUrl: `chrome-extension://${extensionId}/sidepanel.html`,
      },
    );
    expect(crossWindow.playerWindowId).not.toBe(crossWindow.otherWindowId);
    expect(crossWindow.playerActive).toBe(true);
    expect(crossWindow.otherActive).toBe(true);
    actions.push(`CROSS_WINDOW_IDS:${JSON.stringify(crossWindow)}`);
    await expect(panel.locator(".playback-panel h1")).toContainText("재생 중");
    await expect
      .poll(() =>
        secondPage!
          .frameLocator('iframe[src*="kucom.korea.ac.kr"]')
          .locator("video#lecture")
          .evaluate(
            (video: HTMLVideoElement, before) =>
              !video.paused && video.currentTime > before,
            beforeOtherWindow,
          ),
      )
      .toBe(true);
    await worker.evaluate(
      (windowId) => chrome.windows.remove(windowId),
      crossWindow.createdWindowId,
    );

    // Switching away is a real inactive-tab pause acknowledgement. Leave the
    // production content heartbeat window elapsed, then explicitly resume the
    // same native adapter with a fresh background authorization.
    expect(
      await worker.evaluate(async (tabUrl) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((tab) => tab.url === tabUrl)?.active;
      }, secondPage!.url()),
    ).toBe(true);
    await panel.bringToFront();
    await expect(panel.locator(".playback-panel h1")).toContainText("일시정지");
    expect(
      await worker.evaluate(async (tabUrl) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((tab) => tab.url === tabUrl)?.active;
      }, secondPage!.url()),
    ).toBe(false);
    await expect
      .poll(() =>
        secondPage!
          .frameLocator('iframe[src*="kucom.korea.ac.kr"]')
          .locator("video#lecture")
          .evaluate((video: HTMLVideoElement) => video.paused),
      )
      .toBe(true);
    const pausedAt = await secondPage!
      .frameLocator('iframe[src*="kucom.korea.ac.kr"]')
      .locator("video#lecture")
      .evaluate((video: HTMLVideoElement) => video.currentTime);
    await secondPage!.waitForTimeout(21000);
    expect(context.pages()).toContain(secondPage);
    await panel.getByRole("button", { name: "자동 재생 재개" }).click();
    await expect(panel.locator(".playback-panel h1")).toContainText("재생 중");
    expect(
      await worker.evaluate(async (tabUrl) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((tab) => tab.url === tabUrl)?.active;
      }, secondPage!.url()),
    ).toBe(true);
    await expect
      .poll(() =>
        secondPage!
          .frameLocator('iframe[src*="kucom.korea.ac.kr"]')
          .locator("video#lecture")
          .evaluate(
            (video: HTMLVideoElement, before) =>
              !video.paused && video.currentTime > before,
            pausedAt,
          ),
      )
      .toBe(true);

    loggedIn = false;
    await panel.getByRole("button", { name: "새로고침" }).click();
    await expect(panel.locator(".playback-panel h1")).toContainText(
      "로그인 필요",
    );
    await expect(panel.locator(".playback-queue")).toContainText(
      "첫 번째 합성 영상",
    );
    await expect
      .poll(
        () =>
          context!
            .pages()
            .filter((page) =>
              /\/courses\/101\/modules\/items\//.test(page.url()),
            ).length,
      )
      .toBe(0);

    await panel.getByRole("button", { name: "새로고침" }).click();
    await expect
      .poll(
        () =>
          context!
            .pages()
            .filter((page) =>
              /\/courses\/101\/modules\/items\//.test(page.url()),
            ).length,
      )
      .toBe(0);

    loggedIn = true;
    await panel.getByRole("button", { name: "로그인 확인 후 재개" }).click();
    await expect(panel.locator(".playback-panel h1")).toContainText("재생 중", {
      timeout: 30_000,
    });
    const replayPage = context
      .pages()
      .find((page) => /\/courses\/101\/modules\/items\/502$/.test(page.url()));
    expect(replayPage).toBeDefined();
    const replayVideo = replayPage!
      .frameLocator('iframe[src*="kucom.korea.ac.kr"]')
      .locator("video#lecture");
    await expect(replayVideo).toBeAttached({ timeout: 20_000 });
    // Let the native media run to completion: no seeking or synthetic ended.
    await expect(panel.locator(".playback-current")).toContainText(
      "첫 번째 합성 영상",
      { timeout: 30_000 },
    );

    await panel.screenshot({
      path: testInfo.outputPath("playback-running.png"),
      fullPage: true,
    });
    await panel.setViewportSize({ width: 188, height: 700 });
    expect(
      await panel.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await panel.screenshot({
      path: testInfo.outputPath("playback-200pct-equivalent.png"),
      fullPage: true,
    });
    await expect(secondPanel.locator(".playback-panel h1")).toContainText(
      "재생 중",
    );
    const beforeHeldRefresh = identityRequests;
    identityGate = {
      started: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    await panel.getByRole("button", { name: "새로고침" }).click();
    await identityGate.started.promise;
    await secondPanel.getByRole("button", { name: "자동 재생 끄기" }).click();
    await expect(secondPanel.locator(".playback-panel h1")).toContainText(
      "중지됨",
    );
    // The held LMS response is still gated: tab closure and the second panel's
    // state are physical/message barriers, not fixed-sleep timing evidence.
    expect(identityRequests).toBe(beforeHeldRefresh + 1);
    await expect
      .poll(
        () =>
          context!
            .pages()
            .filter((page) =>
              /\/courses\/101\/modules\/items\//.test(page.url()),
            ).length,
      )
      .toBe(0);
    identityGate.release.resolve();
    const consoleErrors = actions.filter(
      (entry) =>
        entry.startsWith("CONSOLE_ERROR:") ||
        entry.startsWith("PAGE_ERROR:") ||
        entry.startsWith("WORKER_CONSOLE_ERROR:"),
    );
    // The deliberate synthetic 401 used to exercise login recovery is the
    // only expected browser-console error.
    expect(consoleErrors).toEqual([
      "CONSOLE_ERROR:Failed to load resource: the server responded with a status of 401 (Unauthorized)",
    ]);
  } finally {
    await testInfo.attach("native-playback-actions", {
      body: Buffer.from(actions.join("\n")),
      contentType: "text/plain",
    });
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("a deferred old start failure cannot invalidate a newer stop and start", async ({
  playwright,
}) => {
  test.setTimeout(90_000);
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-start-race-"));
  let context: BrowserContext | undefined;
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: process.env.CI === "true",
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    await context.route(`${origin}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><title>Synthetic LMS</title><body>Synthetic LMS</body></html>",
        });
        return;
      }
      if (/^\/courses\/101\/modules\/items\/(501|502)$/.test(url.pathname)) {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><title>Synthetic module item</title></html>",
        });
        return;
      }
      const values: Record<string, unknown> = {
        "/api/v1/users/self": { id: 71 },
        "/api/v1/courses": [{ id: 101, name: "합성 운영체제" }],
        "/api/v1/courses/101/assignments": [],
        "/api/v1/planner/items": [],
        "/api/v1/courses/101/modules": [
          {
            id: 20,
            name: "1주차",
            published: true,
            items_count: 2,
            items: [
              {
                id: 501,
                type: "ExternalTool",
                title: "첫 번째 합성 영상",
                html_url: `${origin}/courses/101/modules/items/501`,
              },
              {
                id: 502,
                type: "ExternalTool",
                title: "두 번째 합성 영상",
                html_url: `${origin}/courses/101/modules/items/502`,
              },
            ],
          },
        ],
      };
      if (url.pathname in values) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(values[url.pathname]),
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });

    const lms = await context.newPage();
    await lms.goto(origin);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    expect(
      await panel.evaluate(() =>
        chrome.runtime.sendMessage({ version: 1, type: "PLAYBACK_REFRESH" }),
      ),
    ).toMatchObject({ status: "success" });

    const listing = await panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        url: ["https://mylms.korea.ac.kr/*"],
      });
      if (tab?.id === undefined) throw new Error("missing synthetic LMS tab");
      const result = (await chrome.tabs.sendMessage(
        tab.id,
        {
          version: 1,
          type: "RECORDINGS_LIST",
          course: "합성 운영체제",
        },
        { frameId: 0 },
      )) as {
        status: string;
        recordings?: { launchHandle?: string }[];
        documentToken?: string;
      };
      const values =
        result.status === "success"
          ? (result.recordings ?? [])
              .map((item) => item.launchHandle)
              .filter((value): value is string => typeof value === "string")
          : [];
      if (values.length !== 2 || !result.documentToken)
        throw new Error("missing playback handles");
      return {
        handles: values,
        sourceTabId: tab.id,
        documentToken: result.documentToken,
      };
    });
    const handles = listing.handles;

    // Fault injection is confined to the service worker's Chrome transport:
    // content discovery/catalog ownership remains untouched. The real 25s
    // boundedMessage timer callback is gated so it produces its production
    // PlaybackRuntimeError("TIMEOUT") without waiting for wall-clock expiry.
    await worker.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __unidockRace?: {
          entered: boolean;
          timeoutArmed: boolean;
          forwarded: string[];
          release: () => void;
          restore: () => void;
        };
      };
      const originalSend = chrome.tabs.sendMessage.bind(chrome.tabs);
      const send = originalSend as (
        tabId: number,
        message: unknown,
        options?: chrome.tabs.MessageSendOptions,
      ) => Promise<unknown>;
      const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
      const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
      let firstResolve = true;
      let timeoutCallback: (() => void) | undefined;
      const sentinel = 2_147_483_000;
      const state = {
        entered: false,
        timeoutArmed: false,
        forwarded: [] as string[],
        release: () => timeoutCallback?.(),
        restore: () => {
          chrome.tabs.sendMessage = originalSend;
          globalThis.setTimeout = originalSetTimeout;
          globalThis.clearTimeout = originalClearTimeout;
          delete scope.__unidockRace;
        },
      };
      chrome.tabs.sendMessage = ((tabId, message, options) => {
        const value = message as { type?: string; handles?: string[] };
        if (value.type === "PLAYBACK_RESOLVE_BATCH") {
          if (firstResolve) {
            firstResolve = false;
            state.entered = true;
            return new Promise(() => {});
          }
          if (Array.isArray(value.handles))
            state.forwarded.push(...value.handles);
        }
        return send(
          tabId as number,
          message,
          options as chrome.tabs.MessageSendOptions | undefined,
        );
      }) as typeof chrome.tabs.sendMessage;
      globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
        if (delay === 25_000 && typeof callback === "function") {
          // Keep the timeout belonging to the intentionally held first
          // resolution. A compatible later resolution is allowed to proceed
          // concurrently and must not replace this gate.
          if (!timeoutCallback) {
            timeoutCallback = () => callback();
            state.timeoutArmed = true;
          }
          return sentinel;
        }
        return originalSetTimeout(callback, delay);
      }) as typeof globalThis.setTimeout;
      globalThis.clearTimeout = ((id?: number) => {
        if (id !== sentinel) originalClearTimeout(id);
      }) as typeof globalThis.clearTimeout;
      scope.__unidockRace = state;
    });

    await panel.evaluate(
      ({ handle, sourceTabId, documentToken }) => {
        const scope = globalThis as typeof globalThis & {
          __unidockRequests?: { old: Promise<unknown> };
        };
        scope.__unidockRequests = {
          old: chrome.runtime.sendMessage({
            version: 1,
            type: "PLAYBACK_START",
            handles: [handle],
            sourceTabId,
            documentToken,
          }),
        };
      },
      { handle: handles[0]!, ...listing },
    );
    await expect
      .poll(() =>
        worker.evaluate(() => {
          const state = (
            globalThis as typeof globalThis & {
              __unidockRace?: { entered: boolean; timeoutArmed: boolean };
            }
          ).__unidockRace;
          return {
            entered: !!state?.entered,
            timeoutArmed: !!state?.timeoutArmed,
          };
        }),
      )
      .toEqual({ entered: true, timeoutArmed: true });

    await panel.evaluate(
      ({ handle, sourceTabId, documentToken }) => {
        const scope = globalThis as typeof globalThis & {
          __unidockRequests?: {
            old: Promise<unknown>;
            stop?: Promise<unknown>;
            next?: Promise<unknown>;
          };
        };
        if (!scope.__unidockRequests) throw new Error("missing old request");
        scope.__unidockRequests.stop = chrome.runtime.sendMessage({
          version: 1,
          type: "PLAYBACK_STOP_ALL",
        });
        scope.__unidockRequests.next = chrome.runtime.sendMessage({
          version: 1,
          type: "PLAYBACK_START",
          handles: [handle],
          sourceTabId,
          documentToken,
        });
      },
      { handle: handles[1]!, ...listing },
    );
    const prompt = await panel.evaluate(async () => {
      const requests = (
        globalThis as typeof globalThis & {
          __unidockRequests?: {
            stop?: Promise<unknown>;
            next?: Promise<unknown>;
          };
        }
      ).__unidockRequests;
      if (!requests?.stop || !requests.next)
        throw new Error("missing prompt requests");
      return Promise.all([requests.stop, requests.next]);
    });
    expect(prompt[0]).toMatchObject({
      status: "success",
      snapshot: { status: "stopped" },
    });
    expect(prompt[1]).toMatchObject({
      status: "success",
      snapshot: { status: "starting", current: { id: "101:502" } },
    });
    expect(
      await worker.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __unidockRace?: { forwarded: string[] };
            }
          ).__unidockRace?.forwarded ?? [],
      ),
    ).toEqual([handles[1]]);

    await worker.evaluate(() => {
      const state = (
        globalThis as typeof globalThis & {
          __unidockRace?: { release: () => void };
        }
      ).__unidockRace;
      if (!state) throw new Error("missing race gate");
      state.release();
    });
    const oldResult = await panel.evaluate(async () => {
      const requests = (
        globalThis as typeof globalThis & {
          __unidockRequests?: {
            old: Promise<unknown>;
            stop?: Promise<unknown>;
            next?: Promise<unknown>;
          };
        }
      ).__unidockRequests;
      return requests?.old;
    });
    expect(oldResult).toEqual({ status: "error", code: "BUSY" });
    expect(
      await worker.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __unidockRace?: { forwarded: string[] };
            }
          ).__unidockRace?.forwarded ?? [],
      ),
    ).toEqual([handles[1]]);
    await worker.evaluate(() => {
      (
        globalThis as typeof globalThis & {
          __unidockRace?: { restore: () => void };
        }
      ).__unidockRace?.restore();
    });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("a production stale watchdog delivery cannot stop its replacement", async ({
  playwright,
}) => {
  test.setTimeout(90_000);
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-watchdog-race-"));
  let context: BrowserContext | undefined;
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: process.env.CI === "true",
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    await context.route(`${origin}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><title>Synthetic LMS</title><body>Synthetic LMS</body></html>",
        });
        return;
      }
      if (/^\/courses\/101\/modules\/items\/(501|502)$/.test(url.pathname)) {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><title>Synthetic module item</title></html>",
        });
        return;
      }
      const values: Record<string, unknown> = {
        "/api/v1/users/self": { id: 71 },
        "/api/v1/courses": [{ id: 101, name: "합성 운영체제" }],
        "/api/v1/courses/101/assignments": [],
        "/api/v1/planner/items": [],
        "/api/v1/courses/101/modules": [
          {
            id: 20,
            name: "1주차",
            published: true,
            items_count: 2,
            items: [501, 502].map((id) => ({
              id,
              type: "ExternalTool",
              title: `합성 영상 ${id}`,
              html_url: `${origin}/courses/101/modules/items/${id}`,
            })),
          },
        ],
      };
      if (url.pathname in values) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(values[url.pathname]),
        });
        return;
      }
      await route.fulfill({ status: 404, body: "not found" });
    });

    const lms = await context.newPage();
    await lms.goto(origin);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    expect(
      await panel.evaluate(() =>
        chrome.runtime.sendMessage({ version: 1, type: "PLAYBACK_REFRESH" }),
      ),
    ).toMatchObject({ status: "success" });
    const listing = await panel.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        url: ["https://mylms.korea.ac.kr/*"],
      });
      if (tab?.id === undefined) throw new Error("missing synthetic LMS tab");
      const result = (await chrome.tabs.sendMessage(
        tab.id,
        {
          version: 1,
          type: "RECORDINGS_LIST",
          course: "합성 운영체제",
        },
        { frameId: 0 },
      )) as {
        status: string;
        recordings?: { launchHandle?: string }[];
        documentToken?: string;
      };
      const handles =
        result.status === "success"
          ? (result.recordings ?? [])
              .map(({ launchHandle }) => launchHandle)
              .filter((value): value is string => typeof value === "string")
          : [];
      if (handles.length !== 2 || !result.documentToken)
        throw new Error("missing playback handles");
      return {
        handles,
        sourceTabId: tab.id,
        documentToken: result.documentToken,
      };
    });
    const handles = listing.handles;

    // Gate only alarm scheduling. We later deliver the captured old name
    // through Chrome itself, exercising the production onAlarm listener.
    await worker.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __watchdogFault?: {
          names: string[];
          delivered: string[];
          deliver: (name: string) => Promise<void>;
          restore: () => void;
        };
      };
      const originalCreate = chrome.alarms.create.bind(chrome.alarms);
      const names: string[] = [];
      const delivered: string[] = [];
      chrome.alarms.create = (async (
        name: string,
        info: chrome.alarms.AlarmCreateInfo,
      ) => {
        if (name.startsWith("unidock.playback.watchdog:")) {
          names.push(name);
          return;
        }
        await originalCreate(name, info);
      }) as typeof chrome.alarms.create;
      const listener = (alarm: chrome.alarms.Alarm) => {
        if (names.includes(alarm.name)) delivered.push(alarm.name);
      };
      chrome.alarms.onAlarm.addListener(listener);
      scope.__watchdogFault = {
        names,
        delivered,
        deliver: async (name) => {
          await originalCreate(name, { when: Date.now() - 1 });
        },
        restore: () => {
          chrome.alarms.create = originalCreate;
          chrome.alarms.onAlarm.removeListener(listener);
          delete scope.__watchdogFault;
        },
      };
    });

    expect(
      await panel.evaluate(
        ({ handle, sourceTabId, documentToken }) =>
          chrome.runtime.sendMessage({
            version: 1,
            type: "PLAYBACK_START",
            handles: [handle],
            sourceTabId,
            documentToken,
          }),
        { handle: handles[0]!, ...listing },
      ),
    ).toMatchObject({ status: "success" });
    const oldName = await worker.evaluate(() => {
      const names = (
        globalThis as typeof globalThis & {
          __watchdogFault?: { names: string[] };
        }
      ).__watchdogFault?.names;
      if (!names?.[0]) throw new Error("old watchdog was not armed");
      return names[0];
    });
    expect(
      await panel.evaluate(
        ({ handle, sourceTabId, documentToken }) =>
          chrome.runtime.sendMessage({
            version: 1,
            type: "PLAYBACK_START",
            handles: [handle],
            sourceTabId,
            documentToken,
          }),
        { handle: handles[1]!, ...listing },
      ),
    ).toMatchObject({
      status: "success",
      snapshot: { status: "starting", current: { id: "101:502" } },
    });
    expect(
      await worker.evaluate(() => {
        const names = (
          globalThis as typeof globalThis & {
            __watchdogFault?: { names: string[] };
          }
        ).__watchdogFault?.names;
        return names?.length === 2 && names[0] !== names[1];
      }),
    ).toBe(true);

    await worker.evaluate(async (name) => {
      const fault = (
        globalThis as typeof globalThis & {
          __watchdogFault?: { deliver: (value: string) => Promise<void> };
        }
      ).__watchdogFault;
      if (!fault) throw new Error("missing watchdog fault gate");
      await fault.deliver(name);
    }, oldName);
    await expect
      .poll(() =>
        worker.evaluate(
          (name) =>
            (
              globalThis as typeof globalThis & {
                __watchdogFault?: { delivered: string[] };
              }
            ).__watchdogFault?.delivered.includes(name) ?? false,
          oldName,
        ),
      )
      .toBe(true);
    expect(
      await panel.evaluate(() =>
        chrome.runtime.sendMessage({ version: 1, type: "PLAYBACK_STATUS" }),
      ),
    ).toMatchObject({
      status: "success",
      snapshot: { status: "starting", current: { id: "101:502" } },
    });
    await worker.evaluate(() => {
      (
        globalThis as typeof globalThis & {
          __watchdogFault?: { restore: () => void };
        }
      ).__watchdogFault?.restore();
    });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
