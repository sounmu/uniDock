import { expect, test, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";

const extensionPath = path.resolve(".output/chrome-mv3");

interface ObservedFrame {
  documentId?: string;
  frameId: number;
  pageUrl: unknown;
}

declare global {
  interface Window {
    captionVerificationGate?: {
      initial(): Promise<ObservedFrame[]>;
      verification(): Promise<void>;
      target(): number;
      release(): void;
    };
    captionCancellationGate?: {
      initial(): Promise<void>;
      drained(): Promise<void>;
      calls(): number;
      release(): void;
    };
  }
}

test("clearing a held initial caption capture stops follow-on injections", async ({
  playwright,
}) => {
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-caption-cancel-"));
  const server = await syntheticServer(profile);
  let context: BrowserContext | undefined;
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--host-resolver-rules=MAP mylms.korea.ac.kr 127.0.0.1:${server.port}, MAP kucom.korea.ac.kr 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
        "--no-proxy-server",
        "--ignore-certificate-errors",
      ],
    });
    const lms = await context.newPage();
    await lms.goto("https://mylms.korea.ac.kr/");
    await lms.evaluate((port) => {
      const iframe = document.createElement("iframe");
      iframe.src = `https://kucom.korea.ac.kr:${port}/em/caption-fixture?stable=1`;
      document.body.append(iframe);
    }, server.port);
    await expect(
      lms
        .frameLocator('iframe[src*="caption-fixture"]')
        .getByText("Iframe caption text"),
    ).toBeVisible();

    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const panel = await context.newPage();
    await panel.addInitScript(() => {
      type Execute = typeof chrome.scripting.executeScript;
      const scripting = chrome.scripting as unknown as {
        executeScript: Execute;
      };
      const execute = scripting.executeScript.bind(chrome.scripting);
      let finishInitial!: () => void;
      let release!: () => void;
      let finishDrained!: () => void;
      let calls = 0;
      let held = false;
      const initial = new Promise<void>((resolve) => {
        finishInitial = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const drained = new Promise<void>((resolve) => {
        finishDrained = resolve;
      });
      scripting.executeScript = (async (injection) => {
        calls++;
        const result = await execute(injection);
        if (!held && injection.target.allFrames) {
          held = true;
          finishInitial();
          await gate;
          finishDrained();
        }
        return result;
      }) as Execute;
      window.captionCancellationGate = {
        initial: () => initial,
        drained: () => drained,
        calls: () => calls,
        release,
      };
    });
    await panel.goto(
      `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
    );
    await lms.bringToFront();
    await panel.getByRole("button", { name: "자막 추출", exact: true }).click();
    await panel.getByRole("button", { name: "자막 감지" }).click();
    await panel.evaluate(() => window.captionCancellationGate!.initial());

    await panel.getByRole("button", { name: "내 과목", exact: true }).click();
    await panel.evaluate(() => window.captionCancellationGate!.release());
    await panel.evaluate(() => window.captionCancellationGate!.drained());
    expect(
      await panel.evaluate(() => window.captionCancellationGate!.calls()),
    ).toBe(1);
    await expect(panel.getByRole("alert")).toHaveCount(0);

    await lms.bringToFront();
    await panel.getByRole("button", { name: "자막 추출", exact: true }).click();
    await panel.getByRole("button", { name: "자막 감지" }).click();
    await expect(
      panel.getByText("자막 1개 · 5분 동안 메모리에 보관"),
    ).toBeVisible();
  } finally {
    await context?.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("rejects same-document iframe URL changes and accepts stable iframe captions", async ({
  playwright,
}) => {
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-captions-"));
  const server = await syntheticServer(profile);
  let context: BrowserContext | undefined;
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--host-resolver-rules=MAP mylms.korea.ac.kr 127.0.0.1:${server.port}, MAP kucom.korea.ac.kr 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
        "--no-proxy-server",
        "--ignore-certificate-errors",
      ],
    });
    const lms = await context.newPage();
    await lms.goto("https://mylms.korea.ac.kr/");
    await lms.evaluate((port) => {
      const iframe = document.createElement("iframe");
      iframe.src = `https://kucom.korea.ac.kr:${port}/em/caption-fixture?changing=1`;
      document.body.append(iframe);
    }, server.port);
    const changingFrame = lms.frameLocator('iframe[src*="caption-fixture"]');
    await expect(changingFrame.getByText("Iframe caption text")).toBeVisible();

    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const panel = await context.newPage();
    // Keep this test on the service's final provenance check. The panel normally
    // also clears eagerly on a tab URL event from the child history mutation.
    await panel.addInitScript(() => {
      Object.defineProperty(chrome.tabs.onUpdated, "addListener", {
        configurable: true,
        value: () => undefined,
      });
    });
    await panel.goto(
      `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
    );
    await lms.bringToFront();
    await panel.getByRole("button", { name: "자막 추출", exact: true }).click();

    await panel.evaluate(() => {
      type Injection = {
        target: {
          tabId: number;
          allFrames?: boolean;
          documentIds?: string[];
        };
        world?: string;
      };
      type Execute = (
        injection: Injection,
      ) => Promise<chrome.scripting.InjectionResult<unknown>[]>;
      const scripting = chrome.scripting as unknown as {
        executeScript: Execute;
      };
      const execute = scripting.executeScript.bind(chrome.scripting);
      let finishInitial!: (frames: ObservedFrame[]) => void;
      let finishVerification!: () => void;
      let release!: () => void;
      let tabId: number | undefined;
      const initial = new Promise<ObservedFrame[]>((resolve) => {
        finishInitial = resolve;
      });
      const verification = new Promise<void>((resolve) => {
        finishVerification = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const observed = (
        results: chrome.scripting.InjectionResult<unknown>[],
      ): ObservedFrame[] =>
        results.map((result) => ({
          documentId: result.documentId,
          frameId: result.frameId,
          pageUrl:
            typeof result.result === "object" && result.result !== null
              ? Reflect.get(result.result, "pageUrl")
              : result.result,
        }));

      scripting.executeScript = async (injection) => {
        if (injection.world === "ISOLATED" && injection.target.allFrames) {
          const results = await execute(injection);
          tabId = injection.target.tabId;
          finishInitial(observed(results));
          return results;
        }
        if (
          injection.world === "ISOLATED" &&
          injection.target.documentIds !== undefined
        ) {
          finishVerification();
          await held;
        }
        return execute(injection);
      };
      window.captionVerificationGate = {
        initial: () => initial,
        verification: () => verification,
        target: () => {
          if (tabId === undefined) throw new Error("Missing caption target");
          return tabId;
        },
        release,
      };
    });

    await panel.getByRole("button", { name: "자막 감지" }).click();
    const initial = await panel.evaluate(() =>
      window.captionVerificationGate!.initial(),
    );
    await panel.evaluate(() => window.captionVerificationGate!.verification());
    const initialIframe = initial.find((frame) => frame.frameId !== 0);
    expect(initialIframe?.documentId).toBeTruthy();
    expect(initialIframe?.pageUrl).toBe(
      `https://kucom.korea.ac.kr:${server.port}/em/caption-fixture?changing=1`,
    );

    await changingFrame.locator("body").evaluate(() => {
      history.pushState(null, "", "?changing=1&changed=1");
    });
    const targetTabId = await panel.evaluate(() =>
      window.captionVerificationGate!.target(),
    );
    const changed = await worker.evaluate(
      async (tabId): Promise<ObservedFrame[]> =>
        (
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: "ISOLATED",
            func: () => location.href,
          })
        ).map((result) => ({
          documentId: result.documentId,
          frameId: result.frameId,
          pageUrl: result.result,
        })),
      targetTabId,
    );
    const changedIframe = changed.find(
      (frame) => frame.frameId === initialIframe!.frameId,
    );
    expect(changedIframe).toMatchObject({
      documentId: initialIframe!.documentId,
      pageUrl: `https://kucom.korea.ac.kr:${server.port}/em/caption-fixture?changing=1&changed=1`,
    });

    await panel.evaluate(() => window.captionVerificationGate!.release());
    await expect(panel.getByRole("alert")).toHaveText(
      "강의 문서가 변경되었습니다. 현재 강의에서 다시 감지하세요.",
    );
    await expect(panel.getByText(/시간이 초과/)).toHaveCount(0);

    await lms.locator("iframe").evaluate((iframe, port) => {
      (iframe as HTMLIFrameElement).src =
        `https://kucom.korea.ac.kr:${port}/em/caption-fixture?stable=1`;
    }, server.port);
    const stableFrame = lms.frameLocator('iframe[src*="stable=1"]');
    await expect(stableFrame.getByText("Iframe caption text")).toBeVisible();
    await panel.getByRole("button", { name: "자막 감지" }).click();
    await expect(
      panel.getByText("자막 1개 · 5분 동안 메모리에 보관"),
    ).toBeVisible();
  } finally {
    await context?.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
