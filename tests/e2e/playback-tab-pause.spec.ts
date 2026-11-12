import { expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { nativeVisibilityTest } from "./native-visibility";
import { playbackBuild, PLAYBACK_SKIP_REASON } from "./build-shape";

const test = nativeVisibilityTest.extend({
  nativeExtension: path.resolve(".output/chrome-mv3"),
});

// Real, synthetic 12-second VP8/Opus media. No private lecture data is used.
for (const resumeVia of ["player", "panel", "panel-current"] as const) {
  test(`LMS tab pause is reported and ${resumeVia} resume continues the same playlist`, async ({ context }, testInfo) => {
    test.skip(!playbackBuild(), PLAYBACK_SKIP_REASON);
    test.setTimeout(60000);
    const origin = "https://mylms.korea.ac.kr";
    const firstUrl = `${origin}/courses/101/modules/items/902`;
    const nextUrl = `${origin}/courses/101/modules/items/903`;
    await context.route(`${origin}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/synthetic.webm") {
        await route.fulfill({
          contentType: "video/webm",
          body: await readFile(path.resolve("tests/fixtures/media/hidden-tab.webm")),
        });
        return;
      }
      if (/^\/courses\/101\/modules\/items\/90[23]$/.test(pathname)) {
        await route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><title>Synthetic LMS player</title>
            <video muted playsinline src="/synthetic.webm"></video>
            <button onclick="document.querySelector('video').muted=false">Enable sound</button>
            <button onclick="document.querySelector('video').play().catch(error => {
              if (error.name !== 'AbortError') throw error;
            })">Play lecture</button>
            <script>
              const video = document.querySelector("video");
              window.sitePauses = 0;
              document.addEventListener("visibilitychange", () => {
                if (document.hidden) {
                  window.sitePauses++;
                  video.pause();
                }
              });
            </script>`,
        });
        return;
      }
      const responses: Record<string, unknown> = {
        "/api/v1/users/self": { id: 71 },
        "/api/v1/courses": [{ id: 101, name: "Synthetic course" }],
        "/api/v1/courses/101/modules": [{
          id: 10, name: "Week 1", published: true, items_count: 2,
          items: [
            { id: 902, type: "ExternalTool", title: "First synthetic lecture", html_url: firstUrl },
            { id: 903, type: "ExternalTool", title: "Next synthetic lecture", html_url: nextUrl },
          ],
        }],
        "/api/v1/courses/101/discussion_topics": [],
      };
      if (pathname in responses) {
        await route.fulfill({ json: responses[pathname] });
        return;
      }
      await route.fulfill({ contentType: "text/html", body: "<h1>Synthetic LMS</h1>" });
    });

    const lms = await context.newPage();
    await lms.goto(origin);
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    await expect(panel.getByRole("heading", { name: "홈", exact: true })).toBeVisible();
    await lms.bringToFront();
    // The panel is represented by a hidden tab, so dispatch its real React
    // controls without waiting for a hidden-page animation frame.
    const clickPanel = async (name: string) => {
      const button = panel.getByRole("button", { name, exact: true });
      await expect(button).toBeEnabled();
      await button.evaluate((element: HTMLButtonElement) => element.click());
    };
    await clickPanel("자동 재생");
    await clickPanel("영상 선택");
    await expect(panel.getByLabel("과목 선택").locator("option")).toHaveCount(2);
    await panel.getByLabel("과목 선택").selectOption({ index: 1 });
    for (const name of ["First synthetic lecture", "Next synthetic lecture"]) {
      const choice = panel.getByRole("checkbox", { name: new RegExp(name) });
      await expect(choice).toBeEnabled();
      await choice.evaluate((element: HTMLInputElement) => element.click());
      await expect(choice).toBeChecked();
    }
    const opened = context.waitForEvent("page");
    await clickPanel("자동 재생");
    const lecture = await opened;
    await expect.poll(() => lecture.url()).toBe(firstUrl);
    await expect(panel.locator(".playback-panel h1")).toContainText("재생 중");
    // Make the video genuinely user-activated/unmuted before hiding. The pause
    // under test is the synthetic LMS handler, not Chrome's always-muted path.
    await lecture.getByRole("button", { name: "Enable sound", exact: true }).click();
    const cdp = await context.newCDPSession(lecture);
    const inspect = async () => {
      const result = await cdp.send("Runtime.evaluate", {
        userGesture: false, returnByValue: true,
        expression: `(() => {
          const v=document.querySelector("video");
          return {paused:v.paused,time:v.currentTime,muted:v.muted,
            hidden:document.hidden,sitePauses:window.sitePauses};
        })()`,
      });
      return result.result.value as {
        paused: boolean; time: number; muted: boolean; hidden: boolean; sitePauses: number;
      };
    };
    await expect.poll(async () => (await inspect()).time).toBeGreaterThan(0.5);
    expect(await inspect()).toMatchObject({ paused: false, muted: false, hidden: false });

    await lms.bringToFront();
    await expect.poll(inspect).toMatchObject({ hidden: true, paused: true });
    const paused = await inspect();
    expect(paused.hidden).toBe(true);
    expect(paused.sitePauses).toBeGreaterThan(0);
    await expect(panel.locator(".playback-panel h1")).toContainText("일시정지");
    await expect(panel.locator(".playback-panel").getByRole("status"))
      .toContainText("강의 탭에서 재생 버튼을 누르면");
    await expect(panel.locator(".playback-current")).toContainText("First synthetic lecture");
    await expect(panel.locator(".playback-queue")).toContainText("Next synthetic lecture");
    if (resumeVia === "player") {
      for (const width of [390, 1440]) {
        await panel.setViewportSize({ width, height: 900 });
        await panel.screenshot({ path: testInfo.outputPath(`lms-paused-${width}.png`), fullPage: true });
      }
    }
    await lecture.bringToFront();
    await cdp.send("Runtime.evaluate", {
      userGesture: false, awaitPromise: true,
      expression: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    });
    expect(await inspect()).toMatchObject({ paused: true, hidden: false });
    expect(Math.abs((await inspect()).time - paused.time)).toBeLessThan(0.1);

    const pausedVideo = await lecture.locator("video").evaluateHandle((video: HTMLVideoElement) => video);
    const positionResets = await pausedVideo.evaluateHandle((video) => {
      const events: string[] = [];
      for (const type of ["seeking", "emptied"])
        video.addEventListener(type, () => { events.push(type); });
      return events;
    });
    const lectureNavigations: string[] = [];
    lecture.on("framenavigated", (frame) => {
      if (frame === lecture.mainFrame()) lectureNavigations.push(frame.url());
    });
    const nextOpened = context.waitForEvent("page");
    if (resumeVia === "player") {
      await lecture.getByRole("button", { name: "Play lecture", exact: true }).click();
    } else {
      if (resumeVia === "panel") await lms.bringToFront();
      // panel-current keeps the lecture active while clicking the real control
      // in the hidden panel tab, as an open side panel would.
      await clickPanel("강의 탭에서 재개");
    }
    await expect(panel.locator(".playback-panel h1")).toContainText("재생 중");
    await expect.poll(async () => (await inspect()).time).toBeGreaterThan(paused.time + 0.3);
    // The play event is asynchronous: its currentTime already includes real
    // playback. Preserve position by ruling out seeks and media resets instead.
    expect(await positionResets.evaluate((events) => events)).toEqual([]);
    expect(await pausedVideo.evaluate((video) =>
      video.isConnected && video === document.querySelector("video"))).toBe(true);
    expect(lectureNavigations).toEqual([]);
    expect((await inspect()).hidden).toBe(false);
    expect(context.pages().filter((page) => page.url() === firstUrl)).toEqual([lecture]);
    await expect(panel.locator(".playback-current")).toContainText("First synthetic lecture");
    await expect(panel.locator(".playback-panel").getByRole("status")).toHaveCount(0);

    // Let actual media end; do not seek or fabricate completion.
    const next = await nextOpened;
    await expect.poll(() => next.url()).toBe(nextUrl);
    expect(lectureNavigations).toEqual([]);
    expect(context.pages().filter((page) => page.url() === firstUrl)).toEqual([lecture]);
    await positionResets.dispose();
    await pausedVideo.dispose();
    await expect(panel.locator(".playback-current")).toContainText("Next synthetic lecture");
    await expect(panel.locator(".playback-panel h1")).toContainText("재생 중");
    await clickPanel("자동 재생 끄기");
    await expect(panel.locator(".playback-panel h1")).toContainText("중지됨");
    await expect.poll(() => next.locator("video").evaluate((video: HTMLVideoElement) => video.paused))
      .toBe(true);
    const stopped = await panel.evaluate(() =>
      chrome.runtime.sendMessage({ version: 1, type: "PLAYBACK_STATUS" }));
    // Manual viewing remains possible after STOP, but must not restart or
    // consume the automation queue, even when the manually played video ends.
    await next.getByRole("button", { name: "Play lecture", exact: true }).click();
    await expect.poll(() => next.locator("video").evaluate((video: HTMLVideoElement) => video.paused))
      .toBe(false);
    await expect.poll(() => next.locator("video").evaluate((video: HTMLVideoElement) => video.ended),
      { timeout: 20000 }).toBe(true);
    await expect(panel.locator(".playback-panel h1")).toContainText("중지됨");
    expect(await panel.evaluate(() =>
      chrome.runtime.sendMessage({ version: 1, type: "PLAYBACK_STATUS" }))).toEqual(stopped);
    await cdp.detach();
  });
}
