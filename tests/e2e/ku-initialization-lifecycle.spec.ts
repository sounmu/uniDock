/* eslint-disable @typescript-eslint/no-explicit-any -- page fixtures use test-only window state */
import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { nativeVisibilityTest } from "./native-visibility";

async function installInitializer(page: Page) {
  const source = await readFile(
    path.resolve("src/playback/ku-player.ts"),
    "utf8",
  );
  const javascript = ts
    .transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.replace(
      "export function initializeKuLecture",
      "function initializeKuLecture",
    );
  await page.addScriptTag({
    content: `${javascript}\nwindow.initializeKuLecture = initializeKuLecture;`,
  });
}

async function fixture(
  page: Page,
  action: "same" | "late" | "replace" | "multi",
) {
  await page.goto("about:blank");
  await page.setContent(`<!doctype html><html><body>
    <div class="vc-vplay-container"><video class="vc-vplay-video1" muted playsinline></video></div>
    <button class="vc-front-screen-play-btn">Start</button>
  </body></html>`);
  await installInitializer(page);
  await page.evaluate(async (action) => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext("2d")!;
    let frame = 0;
    // Keep real native media alive well beyond the 15-second deadline.
    (window as any).paint = setInterval(() => {
      context.fillStyle = frame++ % 2 ? "#872038" : "#f8f7f5";
      context.fillRect(0, 0, 64, 48);
    }, 40);
    const stream = canvas.captureStream(24);
    (window as any).stream = stream;
    (window as any).events = [];
    const initial = document.querySelector("video")!;
    (window as any).initial = initial;
    initial.srcObject = stream;
    for (const name of ["playing", "pause"])
      initial.addEventListener(name, (event) =>
        (window as any).events.push({
          name: `initial-${name}`,
          trusted: event.isTrusted,
          at: performance.now(),
        }),
      );
    await new Promise<void>((resolve) =>
      initial.addEventListener("loadedmetadata", () => resolve(), {
        once: true,
      }),
    );
    const button = document.querySelector("button")!;
    button.addEventListener("click", () => {
      void initial.play();
      if (action === "late") {
        setTimeout(() => {
          (window as any).lateAttempted = true;
          void initial.play();
        }, 700);
      } else if (action === "replace" || action === "multi") {
        setTimeout(() => {
          const replacement = document.createElement("video");
          replacement.className = "vc-vplay-video1";
          replacement.muted = true;
          replacement.playsInline = true;
          replacement.playbackRate = 2;
          replacement.defaultPlaybackRate = 2;
          replacement.srcObject = stream;
          for (const name of ["playing", "pause"])
            replacement.addEventListener(name, (event) =>
              (window as any).events.push({
                name: `replacement-${name}`,
                trusted: event.isTrusted,
                at: performance.now(),
              }),
            );
          initial.replaceWith(replacement);
          void replacement.play();
          if (action === "multi") {
            setTimeout(() => {
              const second = document.createElement("video");
              second.className = "vc-vplay-video1";
              second.muted = true;
              second.playsInline = true;
              second.srcObject = stream;
              second.addEventListener("pause", (event) =>
                (window as any).events.push({
                  name: "second-pause",
                  trusted: event.isTrusted,
                  at: performance.now(),
                }),
              );
              replacement.replaceWith(second);
              (window as any).secondAttempted = true;
              void second.play();
            }, 250);
          }
        }, 250);
      }
    });
  }, action);
}

async function start(page: Page, abortAfter?: number, abortOnReady = false) {
  await page.evaluate(
    ({ abortAfter, abortOnReady }) => {
      const controller = new AbortController();
      (window as any).controller = controller;
      (window as any).startedAt = performance.now();
      (window as any).initialization = (window as any)
        .initializeKuLecture(
          document.querySelector("video"),
          () => true,
          controller.signal,
        )
        .then(
          (ready: { video: HTMLVideoElement; handoff(): boolean }) => {
            if (abortOnReady) controller.abort();
            (window as any).result = {
              state: "ready",
              rate: ready.video.playbackRate,
              defaultRate: ready.video.defaultPlaybackRate,
              handedOff: ready.handoff(),
              paused: ready.video.paused,
            };
          },
          () => {
            (window as any).result = { state: "cancelled" };
          },
        );
      if (abortAfter !== undefined)
        setTimeout(() => controller.abort(), abortAfter);
    },
    { abortAfter, abortOnReady },
  );
}

test.use({
  launchOptions: {
    ignoreDefaultArgs: [
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  },
});

test.describe("KU initialization native lifecycle", () => {
  test.beforeEach(async ({ context }) => {
    await context.route("**/*", (route) => route.abort("blockedbyclient"));
  });

  test("cancellation pauses owned native media, including late/replacement playback", async ({
    page,
  }, testInfo) => {
    test.setTimeout(45_000);

    await fixture(page, "same");
    await start(page);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).events.some(
            (event: any) => event.name === "initial-playing" && event.trusted,
          ),
        ),
      )
      .toBe(true);
    await page.evaluate(() => (window as any).controller.abort());
    await expect
      .poll(() =>
        page.evaluate(() => ({
          result: (window as any).result?.state,
          paused: (document.querySelector("video") as HTMLVideoElement).paused,
          trustedPause: (window as any).events.some(
            (event: any) => event.name === "initial-pause" && event.trusted,
          ),
        })),
      )
      .toEqual({ result: "cancelled", paused: true, trustedPause: true });
    expect(page.isClosed()).toBe(false);
    await page.evaluate(() => {
      const initial = (window as any).initial as HTMLVideoElement;
      initial.remove();
      (window as any).detachedAttempted = true;
      void initial.play();
    });
    await page.waitForTimeout(250);
    await expect
      .poll(() =>
        page.evaluate(() => ({
          attempted: (window as any).detachedAttempted === true,
          paused: ((window as any).initial as HTMLVideoElement).paused,
        })),
      )
      .toEqual({ attempted: true, paused: true });
    const hiddenEvidence = await page.evaluate(() => {
      const events = (window as any).events as Array<any>;
      const playing = events.find((event) => event.name === "initial-playing");
      const pause = events.find((event) => event.name === "initial-pause");
      return {
        hidden: document.hidden,
        pauseMs: pause.at - playing.at,
      };
    });
    await testInfo.attach("native-abort-pause.json", {
      body: Buffer.from(JSON.stringify(hiddenEvidence)),
      contentType: "application/json",
    });

    await page.bringToFront();
    await fixture(page, "replace");
    await start(page, 100);
    await expect
      .poll(() =>
        page.evaluate(() => ({
          result: (window as any).result?.state,
          paused: (document.querySelector("video") as HTMLVideoElement).paused,
          trustedPause: (window as any).events.some(
            (event: any) => event.name === "replacement-pause" && event.trusted,
          ),
        })),
      )
      .toEqual({ result: "cancelled", paused: true, trustedPause: true });

    await fixture(page, "multi");
    await start(page, 100);
    await expect
      .poll(() =>
        page.evaluate(() => ({
          attempted: (window as any).secondAttempted === true,
          paused: (document.querySelector("video") as HTMLVideoElement).paused,
          trustedPause: (window as any).events.some(
            (event: any) => event.name === "second-pause" && event.trusted,
          ),
        })),
      )
      .toEqual({ attempted: true, paused: true, trustedPause: true });

    await fixture(page, "late");
    await start(page, 100);
    await expect
      .poll(() => page.evaluate(() => (window as any).lateAttempted === true))
      .toBe(true);
    await page.waitForTimeout(250);
    await expect
      .poll(() =>
        page.evaluate(
          () => (document.querySelector("video") as HTMLVideoElement).paused,
        ),
      )
      .toBe(true);
  });

  nativeVisibilityTest("authorized KU initialization survives a real hidden-tab transition", async ({
    context,
    page,
  }, testInfo) => {
    await fixture(page, "replace");
    const keeper = await context.newPage();
    const browser = context.browser();
    if (!browser) throw new Error("Native visibility requires a connected browser");
    const browserSession = await browser.newBrowserCDPSession();
    const version = await browserSession.send("Browser.getVersion");
    const targets = await Promise.all([
      { name: "video", page },
      { name: "keeper", page: keeper },
    ].map(async (target) => {
      const session = await context.newCDPSession(target.page);
      const { targetInfo } = await session.send("Target.getTargetInfo");
      const window = await browserSession.send("Browser.getWindowForTarget", {
        targetId: targetInfo.targetId,
      });
      await session.send("Runtime.evaluate", {
        userGesture: false,
        expression: `(() => {
          window.visibilityEvidence = [];
          const record = (event) => window.visibilityEvidence.push({
            event: event.type,
            at: performance.timeOrigin + performance.now(),
            hidden: document.hidden,
            visibility: document.visibilityState,
            focused: document.hasFocus(),
            initialization: window.result?.state ?? null,
          });
          document.addEventListener("visibilitychange", record);
          window.addEventListener("focus", record);
          window.addEventListener("blur", record);
          record({ type: "observer-installed" });
        })()`,
      });
      return { name: target.name, session, targetId: targetInfo.targetId, window };
    }));
    const samples: { at: number; step: string; states: unknown[] }[] = [];
    const sample = async (step: string) => {
      const states = await Promise.all(targets.map(async (target) => {
        try {
          // Diagnostic reads must not grant activation or emulate focus.
          const { result, exceptionDetails } = await target.session.send("Runtime.evaluate", {
            userGesture: false,
            returnByValue: true,
            expression: `({
              hidden: document.hidden,
              visibility: document.visibilityState,
              focused: document.hasFocus(),
              activation: {
                active: navigator.userActivation.isActive,
                everActive: navigator.userActivation.hasBeenActive,
              },
              initialization: window.result ?? null,
              events: window.visibilityEvidence,
            })`,
          });
          return {
            name: target.name, targetId: target.targetId, window: target.window,
            state: result.value, error: exceptionDetails?.text,
          };
        } catch (error) {
          return { name: target.name, error: error instanceof Error ? error.message : String(error) };
        }
      }));
      samples.push({ at: Date.now(), step, states });
      return states;
    };
    try {
      expect(targets[0]?.window.windowId, "Both fixtures must be tabs in the same Chrome window")
        .toBe(targets[1]?.window.windowId);
      await sample("before-video-activation");
      await page.bringToFront();
      await sample("video-activation-ack");
      await expect.poll(() => sample("initial-visible-state"), {
        message: "Video visible and keeper hidden before starting initialization",
      }).toMatchObject([
        { name: "video", state: { hidden: false, visibility: "visible" } },
        { name: "keeper", state: { hidden: true, visibility: "hidden" } },
      ]);
      await start(page);
      await sample("initialization-started");
      await keeper.bringToFront();
      await sample("keeper-activation-ack");
      // An activation acknowledgement is not the visibility observation.
      await expect.poll(() => sample("hidden-state-poll"), {
        message: "Real tab switch must hide the video tab and show the keeper",
      }).toMatchObject([
        { name: "video", state: { hidden: true, visibility: "hidden" } },
        { name: "keeper", state: { hidden: false, visibility: "visible" } },
      ]);
      await expect.poll(() => sample("initialization-result"), {
        message: "KU initialization must finish while its tab remains hidden",
      }).toMatchObject([
        { name: "video", state: {
          hidden: true,
          initialization: {
            state: "ready",
            rate: 1,
            defaultRate: 1,
            handedOff: true,
            paused: false,
          },
        } },
        { name: "keeper", state: { hidden: false } },
      ]);
    } finally {
      await sample("final");
      const evidencePath = testInfo.outputPath("native-tab-transition.json");
      await writeFile(evidencePath, JSON.stringify({
        version, platform: process.platform, arch: process.arch, node: process.version,
        repeat: testInfo.repeatEachIndex, retry: testInfo.retry, samples,
      }, null, 2));
      await testInfo.attach("native-tab-transition.json", {
        path: evidencePath,
        contentType: "application/json",
      });
      await Promise.all(targets.map((target) => target.session.detach()));
      await browserSession.detach();
      await keeper.close();
    }
  });

  test("visible timeout pauses long media and happy replacement hands off at 1x", async ({
    page,
  }, testInfo) => {
    test.setTimeout(35_000);
    await page.bringToFront();
    await fixture(page, "same");
    await start(page);
    await expect
      .poll(() => page.evaluate(() => (window as any).result?.state), {
        timeout: 18_000,
      })
      .toBe("cancelled");
    const timeoutEvidence = await page.evaluate(() => {
      const pause = ((window as any).events as Array<any>).find(
        (event) => event.name === "initial-pause" && event.trusted,
      );
      return {
        elapsed: pause.at - (window as any).startedAt,
        paused: (document.querySelector("video") as HTMLVideoElement).paused,
        hidden: document.hidden,
      };
    });
    expect(timeoutEvidence.hidden).toBe(false);
    expect(timeoutEvidence.paused).toBe(true);
    expect(timeoutEvidence.elapsed).toBeGreaterThanOrEqual(14_500);
    expect(page.isClosed()).toBe(false);
    await testInfo.attach("native-timeout-pause.json", {
      body: Buffer.from(JSON.stringify(timeoutEvidence)),
      contentType: "application/json",
    });

    await fixture(page, "replace");
    await start(page);
    await expect
      .poll(() => page.evaluate(() => (window as any).result))
      .toEqual({
        state: "ready",
        rate: 1,
        defaultRate: 1,
        handedOff: true,
        paused: false,
      });
    expect(
      await page.evaluate(() =>
        ((window as any).events as Array<any>).some(
          (event) => event.name === "initial-pause" && event.trusted,
        ),
      ),
    ).toBe(true);
    await page.evaluate(async () => {
      const selected = document.querySelector("video") as HTMLVideoElement;
      selected.pause();
      await selected.play();
      (window as any).selectedResumed = true;
    });
    await page.waitForTimeout(250);
    await expect
      .poll(() =>
        page.evaluate(() => ({
          resumed: (window as any).selectedResumed === true,
          paused: (document.querySelector("video") as HTMLVideoElement).paused,
        })),
      )
      .toEqual({ resumed: true, paused: false });
    await page.evaluate(() => {
      const retired = (window as any).initial as HTMLVideoElement;
      retired.className = "retired-primary";
      (window as any).retiredAttempted = true;
      void retired.play();
    });
    await expect
      .poll(() =>
        page.evaluate(() => ({
          attempted: (window as any).retiredAttempted === true,
          paused: ((window as any).initial as HTMLVideoElement).paused,
        })),
      )
      .toEqual({ attempted: true, paused: true });

    await fixture(page, "replace");
    await start(page, undefined, true);
    await expect
      .poll(() => page.evaluate(() => (window as any).result))
      .toEqual({
        state: "ready",
        rate: 1,
        defaultRate: 1,
        handedOff: false,
        paused: true,
      });
  });
});
