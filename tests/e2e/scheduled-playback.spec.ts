import { expect, test } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { PLAYBACK_ALARM } from "../../src/playback/runtime";

const extensionPath = path.resolve(".output/chrome-mv3");
const origin = "https://mylms.korea.ac.kr";
const kuPlayer = "https://kucom.korea.ac.kr";

function playerHtml(id: string): string {
  return `<!doctype html><html><title>Synthetic Player ${id}</title><body>
    <script>
      const video = document.createElement("video");
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
        video.src = URL.createObjectURL(new Blob(parts, { type: "video/webm" }));
        document.body.append(video);
        video.load();
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.start();
      let frame = 0;
      function draw() {
        paint.fillStyle = frame % 2 ? "#872038" : "#f8f7f5";
        paint.fillRect(0, 0, 64, 48);
        if (++frame < 240) requestAnimationFrame(draw);
        else recorder.stop();
      }
      requestAnimationFrame(draw);
    </script>
  </body></html>`;
}

test("production extension schedules and controls two synthetic native videos", async ({
  playwright,
}, testInfo) => {
  test.setTimeout(240_000);
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-playback-"));
  let context: BrowserContext | undefined;
  let accountId = 71;
  const actions: string[] = [];
  const pending = new Map<string, Array<(value: string) => void>>();
  const signals = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  function record(text: string) {
    if (!text.startsWith("UNIDOCK_QA_")) return;
    actions.push(text);
    const listeners = pending.get(text);
    if (listeners?.length) for (const resolve of listeners) resolve(text);
    else signals.add(text);
    pending.delete(text);
  }
  function next(text: string): Promise<string> {
    if (signals.delete(text)) return Promise.resolve(text);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        pending.delete(text);
        reject(new Error(`Missing native event ${text}`));
      }, 100_000);
      timers.add(timer);
      const listeners = pending.get(text) ?? [];
      listeners.push((value) => {
        clearTimeout(timer);
        timers.delete(timer);
        resolve(value);
      });
      pending.set(text, listeners);
    });
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
    const listen = (page: Page) =>
      page.on("console", (message) => record(message.text()));
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
      const item = /^\/courses\/101\/modules\/items\/(501|502|503)$/.exec(
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
      const values: Record<string, unknown> = {
        "/api/v1/users/self": { id: accountId },
        "/api/v1/courses": [{ id: 101, name: "합성 운영체제" }],
        "/api/v1/courses/101/assignments": [],
        "/api/v1/planner/items": [],
        "/api/v1/announcements": [],
        "/api/v1/courses/101/modules": [
          {
            id: 20,
            name: "1주차",
            published: true,
            items_count: 3,
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
              {
                id: 503,
                type: "ExternalTool",
                title: "세 번째 합성 영상",
                html_url: `${origin}/courses/101/modules/items/503`,
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
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await lms.bringToFront();
    await panel.getByRole("button", { name: "자동 재생" }).click();
    const enabled = panel.getByRole("checkbox", { name: "자동 재생 사용" });
    await expect(enabled).toBeEnabled();
    await expect(enabled).not.toBeChecked();
    await enabled.click();
    await expect(enabled).toBeChecked();
    const courseEnabled = panel.getByRole("checkbox", {
      name: "합성 운영체제",
    });
    await courseEnabled.click();
    await expect(courseEnabled).toBeChecked();
    await panel.getByLabel("시작 시각 (한국 시간)").fill("0");
    await panel.getByLabel("종료 시각 (한국 시간)").fill("24");
    await panel
      .getByLabel("확인할 과목")
      .selectOption({ label: "합성 운영체제" });
    await panel.getByRole("button", { name: "녹화 후보 조회" }).click();
    await expect(
      panel.getByText("첫 번째 합성 영상", { exact: false }).first(),
    ).toBeVisible();
    const deadline = new Date(Date.now() + 3 * 3_600_000 + 9 * 3_600_000)
      .toISOString()
      .slice(0, 16);
    const firstPlaying = next("UNIDOCK_QA_PLAYING:501");
    for (const title of ["첫 번째 합성 영상", "두 번째 합성 영상"]) {
      const row = panel
        .locator("li")
        .filter({ hasText: title })
        .filter({
          has: panel.getByRole("button", { name: "정보 확인" }),
        })
        .first();
      await row.getByRole("button", { name: "정보 확인" }).click();
      await panel.getByLabel("LMS 마감 시각 (한국 시간)").fill(deadline);
      await panel.getByLabel("영상 길이 (분)").fill("1");
      await panel
        .getByRole("button", { name: "LMS 미이수 확인 후 예약" })
        .click();
      await expect(
        panel.locator(".playback-panel .notice").filter({ hasText: title }),
      ).toHaveCount(0);
    }
    actions.push(
      `PREFLIGHT:${(await panel.locator(".playback-panel").innerText()).slice(0, 650)}`,
    );
    await panel.screenshot({
      path: testInfo.outputPath("playback-preflight.png"),
      fullPage: true,
    });
    await panel.getByRole("button", { name: "전체 일정" }).click();
    await panel.getByRole("button", { name: "목록" }).click();
    await expect(
      panel.locator('[data-playback-kind="viewing-deadline"]'),
    ).toHaveCount(2);
    await expect(
      panel.locator('[data-playback-kind="reservation"]'),
    ).toHaveCount(2);
    await panel.screenshot({
      path: testInfo.outputPath("playback-calendar-markers.png"),
      fullPage: true,
    });
    await panel.getByRole("button", { name: "자동 재생" }).click();
    await panel.setViewportSize({ width: 320, height: 700 });
    expect(
      await panel.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await panel.screenshot({
      path: testInfo.outputPath("playback-320.png"),
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
    await panel.setViewportSize({ width: 375, height: 760 });
    await firstPlaying;
    actions.push("first native playing; ordinary rate");
    await expect(panel.locator(".playback-panel h3")).toContainText("재생 중");
    const firstPage = context
      .pages()
      .find((page) => /\/courses\/101\/modules\/items\/501$/.test(page.url()));
    expect(firstPage).toBeDefined();
    const speed = await firstPage!
      .frameLocator('iframe[src*="kucom.korea.ac.kr"]')
      .locator("video")
      .evaluate((video: HTMLVideoElement) => video.playbackRate);
    expect(speed).toBe(1);
    await panel.screenshot({
      path: testInfo.outputPath("playback-running.png"),
      fullPage: true,
    });

    const paused = next("UNIDOCK_QA_PAUSE:501");
    await panel.getByRole("button", { name: "일시정지" }).click();
    await paused;
    await expect(panel.locator(".playback-panel h3")).toContainText("일시정지");
    await panel.evaluate(() => {
      const key = "unidock.playback.v1";
      const scope = window as typeof window & {
        __finishedRun?: Promise<{ stopped: boolean; finishedIds: string[] }>;
      };
      scope.__finishedRun = new Promise((resolve, reject) => {
        const listener = (
          changes: Record<string, chrome.storage.StorageChange>,
          area: string,
        ) => {
          if (area === "local" && changes[key]) void check();
        };
        const timeout = setTimeout(() => {
          chrome.storage.onChanged.removeListener(listener);
          reject(
            new Error("First native ended did not commit playback completion"),
          );
        }, 25_000);
        async function check() {
          const saved = (await chrome.storage.local.get(key))[key] as
            { stopped: boolean; finishedIds: string[] } | undefined;
          if (saved?.finishedIds.includes("101:501")) {
            clearTimeout(timeout);
            chrome.storage.onChanged.removeListener(listener);
            resolve({ stopped: saved.stopped, finishedIds: saved.finishedIds });
          }
        }
        chrome.storage.onChanged.addListener(listener);
        void check();
      });
    });
    const replay = next("UNIDOCK_QA_PLAYING:501");
    const ended = next("UNIDOCK_QA_ENDED:501");
    await panel.getByRole("button", { name: "재개" }).click();
    await replay;
    await ended;
    let committed: { stopped: boolean; finishedIds: string[] };
    try {
      committed = await panel.evaluate(
        () =>
          (
            window as typeof window & {
              __finishedRun: Promise<{
                stopped: boolean;
                finishedIds: string[];
              }>;
            }
          ).__finishedRun,
      );
    } catch (error) {
      const state = await panel.evaluate(async () => {
        const saved = (await chrome.storage.local.get("unidock.playback.v1"))[
          "unidock.playback.v1"
        ] as { stopped: boolean; finishedIds: string[]; player: unknown };
        return {
          stopped: saved?.stopped,
          finishedIds: saved?.finishedIds,
          player: saved?.player,
          alarms: (await chrome.alarms.getAll()).map(
            ({ name, scheduledTime }) => ({
              name,
              scheduledTime,
            }),
          ),
          tabs: (await chrome.tabs.query({})).map(({ id, active, url }) => ({
            id,
            active,
            url,
          })),
        };
      });
      throw new Error(
        `${String(error)}; ${JSON.stringify({ state, actions })}`,
        { cause: error },
      );
    }
    actions.push(`FIRST_COMMITTED:${JSON.stringify(committed)}`);
    const nextPlaying = next("UNIDOCK_QA_PLAYING:502");
    try {
      await nextPlaying;
    } catch (error) {
      const nextState = await panel.evaluate(async () => {
        const saved = (await chrome.storage.local.get("unidock.playback.v1"))[
          "unidock.playback.v1"
        ] as { stopped: boolean; finishedIds: string[]; player: unknown };
        const alarms = await chrome.alarms.getAll();
        return {
          stopped: saved?.stopped,
          finishedIds: saved?.finishedIds,
          player: saved?.player,
          alarms: alarms.map(({ name, scheduledTime }) => ({
            name,
            scheduledTime,
          })),
        };
      });
      throw new Error(
        `${String(error)}; ${JSON.stringify({ actions, nextState })}`,
        { cause: error },
      );
    }
    await expect(panel.locator(".playback-panel h3")).toContainText("재생 중");
    await expect(
      panel.getByText("재생 종료 1건", { exact: false }),
    ).toBeVisible();
    await expect(
      panel.locator(".playback-panel p").filter({ hasText: "현재:" }),
    ).toContainText("확인 필요");
    await panel.screenshot({
      path: testInfo.outputPath("playback-next.png"),
      fullPage: true,
    });
    await panel.getByRole("button", { name: "전체 중지" }).click();
    await expect(panel.locator(".playback-panel h3")).toContainText("중지됨");
    expect(
      context
        .pages()
        .filter((page) => /\/courses\/101\/modules\/items\//.test(page.url())),
    ).toHaveLength(0);

    const activeContext = context;
    await test.step(
      "Confirm and revise third recording deadline",
      async () => {
        await enabled.click();
        await expect(enabled).toBeChecked();
        await panel.getByLabel("마감 전 여유 (시간)").fill("0");
        await panel
          .getByLabel("확인할 과목")
          .selectOption({ label: "합성 운영체제" });
        const originalThird = new Date(
          Date.now() + 2 * 3_600_000 + 9 * 3_600_000,
        )
          .toISOString()
          .slice(0, 16);
        const revisedThird = new Date(
          Date.now() + 3 * 3_600_000 + 9 * 3_600_000,
        )
          .toISOString()
          .slice(0, 16);
        async function confirmThird(value: string) {
          await lms.bringToFront();
          const load = panel.getByRole("button", { name: "녹화 후보 조회" });
          await expect(load).toBeEnabled();
          await load.click();
          await expect(load).toBeDisabled();
          await expect(load).toBeEnabled();
          const candidate = panel
            .locator("li")
            .filter({ hasText: "세 번째 합성 영상" })
            .filter({ has: panel.getByRole("button", { name: "정보 확인" }) })
            .first();
          await expect(
            candidate.getByRole("button", { name: "정보 확인" }),
          ).toBeEnabled();
          await candidate.getByRole("button", { name: "정보 확인" }).click();
          await panel.getByLabel("LMS 마감 시각 (한국 시간)").fill(value);
          await panel.getByLabel("영상 길이 (분)").fill("1");
          await panel
            .getByRole("button", { name: "LMS 미이수 확인 후 예약" })
            .click();
          await expect(
            panel.getByLabel("LMS 마감 시각 (한국 시간)"),
          ).toHaveCount(0);
        }
        await confirmThird(originalThird);
        await confirmThird(revisedThird);
        const storedDeadline = await panel.evaluate(async () => {
          const saved = (await chrome.storage.local.get("unidock.playback.v1"))[
            "unidock.playback.v1"
          ] as { confirmations: { id: string; deadline: string }[] };
          return saved.confirmations.find(({ id }) => id === "101:503")
            ?.deadline;
        });
        expect(storedDeadline).toBe(
          new Date(`${revisedThird}:00+09:00`).toISOString(),
        );
        actions.push("MANUAL_DEADLINE_REVISED:503");
      },
      { timeout: 45_000 },
    );
    await test.step(
      "Close active third player tab without replay",
      async () => {
        const thirdPlaying = next("UNIDOCK_QA_PLAYING:503");
        await panel.getByLabel("마감 전 여유 (시간)").fill("24");
        await thirdPlaying;
        const thirdPage = activeContext
          .pages()
          .find((page) =>
            /\/courses\/101\/modules\/items\/503$/.test(page.url()),
          );
        expect(thirdPage).toBeDefined();
        await thirdPage!.close();
        actions.push("ACTIVE_PLAYER_TAB_CLOSED:503");
        await expect(panel.locator(".playback-panel h3")).toContainText("실패");
        expect(
          activeContext
            .pages()
            .filter((page) =>
              /\/courses\/101\/modules\/items\//.test(page.url()),
            ),
        ).toHaveLength(0);
      },
      { timeout: 45_000 },
    );
    await test.step(
      "Ignore a late real playback alarm after stop",
      async () => {
        await panel.getByRole("button", { name: "전체 중지" }).click();
        await expect(panel.locator(".playback-panel h3")).toContainText(
          "중지됨",
        );
        await panel.evaluate((alarmName) => {
          const scope = window as typeof window & {
            __lateAlarm?: Promise<void>;
          };
          scope.__lateAlarm = new Promise((resolve, reject) => {
            const listener = (alarm: chrome.alarms.Alarm) => {
              if (alarm.name !== alarmName) return;
              clearTimeout(timeout);
              chrome.alarms.onAlarm.removeListener(listener);
              resolve();
            };
            const timeout = setTimeout(() => {
              chrome.alarms.onAlarm.removeListener(listener);
              reject(new Error("Stale playback alarm did not fire"));
            }, 60_000);
            chrome.alarms.onAlarm.addListener(listener);
          });
        }, PLAYBACK_ALARM);
        await panel.evaluate(
          (alarmName) =>
            chrome.alarms.create(alarmName, {
              when: Date.now() + 1000,
            }),
          PLAYBACK_ALARM,
        );
        await panel.evaluate(
          () =>
            (window as typeof window & { __lateAlarm: Promise<void> })
              .__lateAlarm,
        );
        actions.push("STALE_ALARM_IGNORED_AFTER_STOP");
        expect(
          activeContext
            .pages()
            .filter((page) =>
              /\/courses\/101\/modules\/items\//.test(page.url()),
            ),
        ).toHaveLength(0);
        await panel.screenshot({
          path: testInfo.outputPath("playback-closed-tab-late-alarm.png"),
          fullPage: true,
        });
      },
      { timeout: 75_000 },
    );

    const browser = context.browser();
    if (!browser) throw new Error("No synthetic browser");
    const cdp = await browser.newBrowserCDPSession();
    try {
      const targets = await cdp.send("Target.getTargets");
      const target = targets.targetInfos.find(
        (item) =>
          item.type === "service_worker" &&
          item.url.startsWith(`chrome-extension://${extensionId}/`),
      );
      if (!target) throw new Error("MV3 worker target missing");
      await cdp.send("Target.closeTarget", { targetId: target.targetId });
    } finally {
      await cdp.detach();
    }
    await panel.getByRole("button", { name: "상태 새로고침" }).click();
    await expect(panel.locator(".playback-panel h3")).toContainText("중지됨");
    expect(
      context
        .pages()
        .filter((page) => /\/courses\/101\/modules\/items\//.test(page.url())),
    ).toHaveLength(0);
    await panel.screenshot({
      path: testInfo.outputPath("playback-worker-restart.png"),
      fullPage: true,
    });

    accountId = 72;
    await panel.getByRole("button", { name: "상태 새로고침" }).click();
    await expect(panel.locator(".playback-panel .notice.error")).toBeVisible();
    await panel.getByRole("button", { name: "상태 새로고침" }).click();
    await expect(
      panel.getByRole("checkbox", { name: "자동 재생 사용" }),
    ).not.toBeChecked();
    await panel.screenshot({
      path: testInfo.outputPath("playback-account-change.png"),
      fullPage: true,
    });

    await panel.close();
    await lms.close();
    await context.close();
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: process.env.CI === "true",
      viewport: { width: 375, height: 760 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    await context.route(`${origin}/**`, (route) =>
      route.fulfill({ status: 404, body: "synthetic session ended" }),
    );
    await context.route(`${kuPlayer}/**`, (route) =>
      route.fulfill({ status: 404, body: "synthetic player ended" }),
    );
    const restored = await context.newPage();
    await restored.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    const stored = await restored.evaluate(
      async () =>
        (await chrome.storage.local.get("unidock.playback.v1"))[
          "unidock.playback.v1"
        ] as { settings: { enabled: boolean }; stopped: boolean } | undefined,
    );
    expect(stored?.settings.enabled ?? false).toBe(false);
    expect(
      context
        .pages()
        .filter((page) => /\/courses\/101\/modules\/items\//.test(page.url())),
    ).toHaveLength(0);
    await restored.screenshot({
      path: testInfo.outputPath("playback-browser-restart.png"),
      fullPage: true,
    });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await testInfo.attach("native-playback-actions", {
      body: Buffer.from(actions.join("\n")),
      contentType: "text/plain",
    });
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
