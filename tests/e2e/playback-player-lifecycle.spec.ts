/* eslint-disable @typescript-eslint/no-explicit-any -- page fixture exposes the transpiled class */
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

async function installPlaybackPlayer(page: Page) {
  const source = await readFile(path.resolve("src/playback/player.ts"), "utf8");
  const javascript = ts
    .transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.replace("export class PlaybackPlayer", "class PlaybackPlayer");
  await page.addScriptTag({
    content: `${javascript}\nwindow.PlaybackPlayer = PlaybackPlayer;`,
  });
}

test("SPA invalidation physically pauses owned native media", async ({
  page,
}) => {
  await page.goto("about:blank");
  await page.setContent(
    "<!doctype html><html><body><video muted playsinline></video></body></html>",
  );
  await installPlaybackPlayer(page);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext("2d")!;
    let frame = 0;
    (window as any).paint = setInterval(() => {
      context.fillStyle = frame++ % 2 ? "#872038" : "#f8f7f5";
      context.fillRect(0, 0, 64, 48);
    }, 40);
    const video = document.querySelector("video")!;
    video.srcObject = canvas.captureStream(24);
    (window as any).endedEvents = 0;
    (window as any).pauseEvents = 0;
    video.addEventListener("ended", () => (window as any).endedEvents++);
    video.addEventListener("pause", () => (window as any).pauseEvents++);
    await new Promise<void>((resolve) =>
      video.addEventListener("loadedmetadata", () => resolve(), { once: true }),
    );
    const player = new (window as any).PlaybackPlayer(video);
    (window as any).player = player;
    (window as any).started = await player.start();
  });

  await expect
    .poll(() =>
      page.evaluate(() => ({
        state: (window as any).started.state,
        paused: document.querySelector("video")!.paused,
        time: document.querySelector("video")!.currentTime,
      })),
    )
    .toMatchObject({ state: "playing", paused: false });

  const stoppedAt = await page.evaluate(() => {
    history.pushState({}, "", "#spa-route");
    (window as any).player.invalidate();
    return document.querySelector("video")!.currentTime;
  });
  await page.waitForTimeout(500);
  const evidence = await page.evaluate(() => {
    const video = document.querySelector("video")!;
    return {
      state: (window as any).player.status.state,
      paused: video.paused,
      time: video.currentTime,
      endedEvents: (window as any).endedEvents,
      pauseEvents: (window as any).pauseEvents,
    };
  });

  expect(evidence.state).toBe("stopped");
  expect(evidence.paused).toBe(true);
  expect(evidence.pauseEvents).toBeGreaterThan(0);
  expect(evidence.endedEvents).toBe(0);
  expect(evidence.time - stoppedAt).toBeLessThan(0.05);
  expect(page.isClosed()).toBe(false);
});

test("native play is physically rejected after an adapter pause", async ({
  page,
}) => {
  await page.goto("about:blank");
  await page.setContent(
    "<!doctype html><html><body><video muted playsinline></video></body></html>",
  );
  await installPlaybackPlayer(page);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext("2d")!;
    (window as any).paint = setInterval(() => {
      context.fillRect(0, 0, 64, 48);
    }, 40);
    const video = document.querySelector("video")!;
    video.srcObject = canvas.captureStream(24);
    await new Promise<void>((resolve) =>
      video.addEventListener("loadedmetadata", () => resolve(), { once: true }),
    );
    const player = new (window as any).PlaybackPlayer(video);
    (window as any).player = player;
    await player.start();
    player.pause();
    (window as any).pausedAt = video.currentTime;
    await video.play().catch(() => undefined);
  });

  await page.waitForTimeout(500);
  const evidence = await page.evaluate(() => {
    const video = document.querySelector("video")!;
    return {
      state: (window as any).player.status.state,
      paused: video.paused,
      elapsed: video.currentTime - (window as any).pausedAt,
    };
  });
  expect(evidence.state).toBe("paused");
  expect(evidence.paused).toBe(true);
  expect(evidence.elapsed).toBeLessThan(0.05);
});
