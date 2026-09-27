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

test("finite native media keeps completion proof across only an unchanged pause", async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.goto("about:blank");
  await page.setContent("<!doctype html><html><body></body></html>");
  await installPlaybackPlayer(page);

  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext("2d")!;
    const stream = canvas.captureStream(24);
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8",
    });
    const parts: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) =>
      parts.push(event.data),
    );
    const stopped = new Promise<void>((resolve) =>
      recorder.addEventListener("stop", () => resolve(), { once: true }),
    );
    recorder.start(200);
    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
      const draw = setInterval(() => {
        context.fillStyle =
          Math.floor(performance.now() / 40) % 2 ? "#872038" : "#f8f7f5";
        context.fillRect(0, 0, 64, 48);
        if (performance.now() - startedAt >= 3_200) {
          clearInterval(draw);
          recorder.stop();
          resolve();
        }
      }, 20);
    });
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    const mediaUrl = URL.createObjectURL(
      new Blob(parts, { type: "video/webm" }),
    );

    const exercise = async (seekWhilePaused: boolean) => {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.src = mediaUrl;
      document.body.append(video);
      await new Promise<void>((resolve) =>
        video.addEventListener("loadedmetadata", () => resolve(), {
          once: true,
        }),
      );
      const states: string[] = [];
      const player = new (window as any).PlaybackPlayer(video, {
        onStateChange: ({ state }: { state: string }) => states.push(state),
      });
      let paused = false;
      const completed = new Promise<void>((resolve) => {
        video.addEventListener("timeupdate", () => {
          if (
            paused ||
            video.currentTime < 1.2 ||
            video.duration - video.currentTime <= 0.25 ||
            video.duration - video.currentTime >= 0.85
          )
            return;
          paused = true;
          player.pause();
          if (seekWhilePaused) video.currentTime -= 0.1;
          setTimeout(() => {
            const resumed = player.resume();
            if (!seekWhilePaused) {
              // Block immediately after native play starts. The adapter must
              // accept a later `playing` baseline at its naturally advanced
              // position rather than comparing it with the frozen pause point.
              const blockedUntil = performance.now() + 120;
              while (performance.now() < blockedUntil) {
                // Intentional deterministic event-delivery delay.
              }
            }
            void resumed;
          }, 100);
        });
        video.addEventListener("ended", () => setTimeout(resolve, 0), {
          once: true,
        });
      });
      await player.start();
      await completed;
      return {
        paused,
        state: player.status.state,
        reason: player.status.reason,
        endedStates: states.filter((state) => state === "ended").length,
      };
    };

    (window as any).unchangedPause = await exercise(false);
    (window as any).seekedPause = await exercise(true);
  });

  expect(await page.evaluate(() => (window as any).unchangedPause)).toEqual({
    paused: true,
    state: "ended",
    reason: undefined,
    endedStates: 1,
  });
  expect(await page.evaluate(() => (window as any).seekedPause)).toEqual({
    paused: true,
    state: "paused",
    reason: "unverified-end",
    endedStates: 0,
  });
});
