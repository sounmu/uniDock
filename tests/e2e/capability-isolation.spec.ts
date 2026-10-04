import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";
import { playbackBuild } from "./build-shape";

const extensionPath = path.resolve(".output/chrome-mv3");
const origin = "https://mylms.korea.ac.kr";

type CapturedList = {
  request: { type: string };
  result: {
    status: string;
    recordings?: { launchHandle: string }[];
    documents?: { lmsHandle: string; downloadHandle: string }[];
  };
};

async function captureTransportLists(panel: Page) {
  await panel.evaluate(() => {
    const target = window as typeof window & { capturedLists: unknown[] };
    target.capturedLists = [];
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = (async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      const message = args[1] as { type?: string; request?: unknown };
      if (message?.type === "CAPABILITY_LIST")
        target.capturedLists.push({ request: message.request, result });
      return result;
    }) as typeof chrome.tabs.sendMessage;
  });
}

async function openCourseRecordings(panel: Page, lms: Page) {
  await lms.bringToFront();
  await panel.getByRole("button", { name: "새로고침", exact: true }).click();
  await expect(panel.getByText("조회 완료 · 2개 과목")).toBeVisible();
  await panel
    .getByRole("button", { name: /Synthetic Operating Systems/ })
    .click();
  await panel.getByRole("button", { name: "녹화 강의", exact: true }).click();
  await expect(panel.getByText("조회 완료 · 2개 강의 후보")).toBeVisible();
}

async function openRecording(
  panel: Page,
  context: BrowserContext,
  title: string,
) {
  await panel.getByRole("button", { name: new RegExp(title) }).click();
  const opened = context.waitForEvent("page");
  await panel.getByRole("button", { name: "LTI 탭 열기 ↗" }).click();
  const page = await opened;
  await page.waitForLoadState("domcontentloaded");
  return page;
}

test("two production panel consumers retain independent capability catalogs", async ({
  playwright,
}) => {
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-scoped-panels-"));
  const server = await syntheticServer(profile);
  let context: BrowserContext | undefined;
  const errors: string[] = [];
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--host-resolver-rules=MAP mylms.korea.ac.kr 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
        "--no-proxy-server",
        "--ignore-certificate-errors",
      ],
    });
    context.on("page", (page) => {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
    });
    const lms = await context.newPage();
    await lms.goto(origin);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const panelA = await context.newPage();
    const panelB = await context.newPage();
    await Promise.all([
      panelA.goto(`chrome-extension://${extensionId}/sidepanel.html`),
      panelB.goto(`chrome-extension://${extensionId}/sidepanel.html`),
    ]);
    await captureTransportLists(panelA);
    await captureTransportLists(panelB);

    await openCourseRecordings(panelA, lms);
    await openCourseRecordings(panelB, lms);
    const [capturedA, capturedB] = await Promise.all([
      panelA.evaluate(
        () =>
          (window as typeof window & { capturedLists: CapturedList[] })
            .capturedLists,
      ),
      panelB.evaluate(
        () =>
          (window as typeof window & { capturedLists: CapturedList[] })
            .capturedLists,
      ),
    ]);
    const handlesA = capturedA.find(
      ({ request }) => request.type === "RECORDINGS_LIST",
    )!.result.recordings!;
    const handlesB = capturedB.find(
      ({ request }) => request.type === "RECORDINGS_LIST",
    )!.result.recordings!;
    expect(handlesA.map(({ launchHandle }) => launchHandle)).not.toEqual(
      handlesB.map(({ launchHandle }) => launchHandle),
    );

    const openedA = await openRecording(panelA, context, "Synthetic Lecture A");
    expect(openedA.url()).toBe(`${origin}/courses/101/modules/items/902`);
    await openedA.close();
    const openedB = await openRecording(panelB, context, "Synthetic Lecture A");
    expect(openedB.url()).toBe(`${origin}/courses/101/modules/items/902`);
    await openedB.close();

    await lms.bringToFront();
    await panelB.getByRole("button", { name: "← 목록" }).click();
    await panelB
      .getByRole("button", { name: "강의 자료", exact: true })
      .click();
    await expect(
      panelB.getByRole("heading", { name: "강의 자료 · 2개" }),
    ).toBeVisible();
    await panelB
      .getByRole("button", { name: "목록 새로고침", exact: true })
      .click();
    await expect(
      panelB.getByRole("heading", { name: "강의 자료 · 2개" }),
    ).toBeVisible();

    await panelA.getByRole("button", { name: "← 목록" }).click();
    const survivingA = await openRecording(
      panelA,
      context,
      "Synthetic Lecture B",
    );
    expect(survivingA.url()).toBe(`${origin}/courses/101/modules/items/903`);
    await survivingA.close();

    await panelB.getByRole("button", { name: /lecture.pdf/ }).click();
    const documentOpened = context.waitForEvent("page");
    await panelB.getByRole("button", { name: "LMS에서 열기" }).click();
    const documentPage = await documentOpened;
    await documentPage.waitForLoadState("domcontentloaded");
    expect(documentPage.url()).toBe(`${origin}/courses/101/modules/items/900`);
    await documentPage.close();
    await panelB.getByRole("button", { name: "← 목록" }).click();
    await panelB.getByRole("button", { name: "자료 전체 다운로드" }).click();
    await expect.poll(() => server.downloads.length).toBe(2);
    expect(server.downloads).toEqual([
      "/courses/101/files/501/download",
      "/courses/101/files/502/download",
    ]);

    // Release builds omit playback; its catalog isolation is covered by test:e2e:playback.
    if (playbackBuild()) {
      await lms.bringToFront();
      const playbackRefresh = await panelB.evaluate(() =>
        chrome.runtime.sendMessage({ version: 1, type: "PLAYBACK_REFRESH" }),
      );
      if (playbackRefresh.status === "error")
        throw new Error(`Playback refresh failed: ${playbackRefresh.code}`);
      expect(playbackRefresh.status).toBe("success");
      expect(playbackRefresh.snapshot.courses).toContainEqual(
        expect.objectContaining({ name: "Synthetic Operating Systems" }),
      );
      await panelB
        .getByRole("button", { name: "자동 재생", exact: true })
        .click();
      const playback = panelB.getByRole("region", { name: "자동 재생" });
      await playback.getByRole("button", { name: "새로고침" }).click();
      await expect(
        panelB.getByRole("button", { name: "영상 선택" }),
      ).toBeEnabled();
      await panelB.getByRole("button", { name: "영상 선택" }).click();
      await panelB
        .getByLabel("과목 선택")
        .selectOption({ label: "Synthetic Operating Systems" });
      await expect(
        panelB.getByText("Synthetic Lecture A", { exact: true }),
      ).toBeVisible();

      const finalB = await panelB.evaluate(
        () =>
          (window as typeof window & { capturedLists: CapturedList[] })
            .capturedLists,
      );
      expect(
        finalB.filter(({ request }) => request.type === "RECORDINGS_LIST"),
      ).toHaveLength(2);
      const playbackHandles = finalB
        .filter(({ request }) => request.type === "RECORDINGS_LIST")[1]!
        .result.recordings!.map(({ launchHandle }) => launchHandle);
      expect(playbackHandles).not.toEqual(
        handlesB.map(({ launchHandle }) => launchHandle),
      );
    }
    expect(errors).toEqual([]);
  } finally {
    if (context) await context.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
