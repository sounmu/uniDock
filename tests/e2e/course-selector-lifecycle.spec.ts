import { expect, test, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";
import { playbackBuild } from "./build-shape";

const extensionPath = path.resolve(".output/chrome-mv3");
const origin = "https://mylms.korea.ac.kr";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type CapturedQuery = {
  tabId: number;
  message: {
    type?: string;
    scope?: string;
    courseSelector?: string;
    request?: { type?: string; courseSelector?: string };
  };
  result: {
    status?: string;
    code?: string;
    courses?: { name: string; courseSelector: string }[];
    assignments?: { title: string }[];
  };
};

test("production pickers keep duplicate and redacted courses bound to opaque selectors", async ({
  playwright,
}) => {
  test.setTimeout(90_000);
  await stat(path.join(extensionPath, "manifest.json"));
  const profile = await mkdtemp(
    path.join(tmpdir(), "unidock-course-selectors-"),
  );
  const server = await syntheticServer(profile, { selectorCourses: true });
  let context: BrowserContext | undefined;
  const errors: string[] = [];

  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
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

    const issuingLms = await context.newPage();
    await issuingLms.goto(origin);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.evaluate(() => {
      const target = window as typeof window & { capturedQueries: unknown[] };
      target.capturedQueries = [];
      const original = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = (async (
        ...args: Parameters<typeof original>
      ) => {
        const result = await original(...args);
        const message = args[1] as { type?: string };
        if (
          message?.type === "CAPABILITY_LIST" ||
          message?.type?.endsWith("_LIST")
        )
          target.capturedQueries.push({
            tabId: args[0],
            message,
            result,
          });
        return result;
      }) as typeof chrome.tabs.sendMessage;
    });
    await issuingLms.bringToFront();
    const issuingTabId = await panel.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({ url: `${url}/*` }))[0];
      if (tab?.id === undefined) throw new Error("Missing issuing LMS tab");
      return tab.id;
    }, origin);

    await panel.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect(panel.getByText("조회 완료 · 4개 과목")).toBeVisible();
    await expect(
      panel.getByRole("button", { name: /Duplicate Course/ }),
    ).toHaveCount(2);
    await expect(
      panel.getByRole("button", { name: /\[REDACTED\]/ }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: /이름 없는 과목/ }),
    ).toBeVisible();

    const initialCourses = await panel.evaluate(() =>
      (
        window as typeof window & { capturedQueries: CapturedQuery[] }
      ).capturedQueries.find(
        ({ message }) => message.request?.type === "COURSES_LIST",
      ),
    );
    expect(initialCourses?.tabId).toBe(issuingTabId);
    expect(initialCourses?.result.courses).toHaveLength(4);
    expect(
      initialCourses?.result.courses?.every(({ courseSelector }) =>
        uuid.test(courseSelector),
      ),
    ).toBe(true);
    expect(
      new Set(
        initialCourses?.result.courses?.map(
          ({ courseSelector }) => courseSelector,
        ),
      ).size,
    ).toBe(4);

    const otherLms = await context.newPage();
    await otherLms.goto(`${origin}/?active=other`);
    const otherTabId = await panel.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({ url }))[0];
      if (tab?.id === undefined) throw new Error("Missing second LMS tab");
      return tab.id;
    }, `${origin}/?active=other`);
    await otherLms.bringToFront();
    await panel
      .getByRole("button", { name: /Duplicate Course/ })
      .nth(1)
      .click();
    let assignmentQuery: CapturedQuery | undefined;
    await expect
      .poll(async () => {
        assignmentQuery = await panel.evaluate(() =>
          (
            window as typeof window & { capturedQueries: CapturedQuery[] }
          ).capturedQueries.find(
            ({ message }) =>
              (message.request ?? message).type === "ASSIGNMENTS_LIST",
          ),
        );
        return assignmentQuery?.result;
      })
      .toMatchObject({
        status: "success",
        assignments: [{ title: "Second duplicate assignment" }],
      });
    expect(assignmentQuery?.tabId).toBe(issuingTabId);
    expect(assignmentQuery?.tabId).not.toBe(otherTabId);
    expect(
      (assignmentQuery?.message.request ?? assignmentQuery?.message)
        ?.courseSelector,
    ).toBe(initialCourses?.result.courses?.[1]?.courseSelector);
    await expect(
      panel.getByText("Second duplicate assignment", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByText("First duplicate assignment")).toHaveCount(0);

    await panel.getByRole("button", { name: "강의 자료", exact: true }).click();
    await expect(
      panel.getByRole("heading", { name: "강의 자료 · 1개" }),
    ).toBeVisible();
    await expect(panel.getByText("second-duplicate.pdf")).toBeVisible();
    expect(
      server.requests.some(
        ({ pathname }) => pathname === "/api/v1/courses/302/modules",
      ),
    ).toBe(true);
    expect(
      server.requests.some(
        ({ pathname }) => pathname === "/api/v1/courses/301/modules",
      ),
    ).toBe(false);

    await otherLms.close();
    await issuingLms.bringToFront();
    // Release builds omit playback; its picker is covered by test:e2e:playback.
    if (playbackBuild()) {
      await panel
        .getByRole("button", { name: "자동 재생", exact: true })
        .click();
      const playback = panel.getByRole("region", { name: "자동 재생" });
      const pickerButton = playback.getByRole("button", { name: "영상 선택" });
      await expect(pickerButton).toBeEnabled();
      const coursesBeforePicker = server.coursesCount();
      await pickerButton.click();
      const select = panel.getByLabel("과목 선택");
      await expect(select.locator("option")).toHaveCount(5);
      await expect(
        select.locator("option", { hasText: "이름 없는 과목" }),
      ).toHaveCount(1);
      expect(server.coursesCount()).toBe(coursesBeforePicker);
      const duplicateOptions = select.locator("option", {
        hasText: "Duplicate Course",
      });
      const secondDuplicateValue = await duplicateOptions
        .nth(1)
        .getAttribute("value");
      expect(secondDuplicateValue).toMatch(uuid);
      await select.selectOption(secondDuplicateValue!);
      await expect(
        panel.getByText("Second duplicate recording", { exact: true }),
      ).toBeVisible();

      const captured = await panel.evaluate(
        () =>
          (window as typeof window & { capturedQueries: CapturedQuery[] })
            .capturedQueries,
      );
      const courseQueries = captured.filter(
        ({ message }) => message.request?.type === "COURSES_LIST",
      );
      expect(courseQueries).toHaveLength(2);
      const playbackCourses = courseQueries[1]!.result.courses!;
      expect(playbackCourses.map(({ name }) => name)).toEqual(
        initialCourses!.result.courses!.map(({ name }) => name),
      );
      expect(
        playbackCourses.map(({ courseSelector }) => courseSelector),
      ).not.toEqual(
        initialCourses!.result.courses!.map(
          ({ courseSelector }) => courseSelector,
        ),
      );
      expect(
        playbackCourses.every(({ courseSelector }) =>
          uuid.test(courseSelector),
        ),
      ).toBe(true);
      const playbackRecordingQuery = captured.find(
        ({ message }) =>
          message.request?.type === "RECORDINGS_LIST" &&
          message.request.courseSelector === secondDuplicateValue,
      );
      expect(playbackRecordingQuery).toBeTruthy();
    }

    const oldSelector = initialCourses!.result.courses![1]!.courseSelector;
    const requestsBeforeReloadCheck = server.coursesCount();
    await issuingLms.reload();
    await expect
      .poll(() =>
        panel.evaluate(
          ({ tabId, courseSelector }) =>
            chrome.tabs
              .sendMessage(
                tabId,
                {
                  version: 1,
                  type: "ASSIGNMENTS_LIST",
                  courseSelector,
                },
                { frameId: 0 },
              )
              .catch(() => undefined),
          { tabId: issuingTabId, courseSelector: oldSelector },
        ),
      )
      .toEqual({ status: "error", code: "STALE_SELECTION" });
    expect(server.coursesCount()).toBe(requestsBeforeReloadCheck);
    expect(server.requests.every(({ method }) => method === "GET")).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
