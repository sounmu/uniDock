import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";

test("production assignments apply draft filters and track only successful refreshes", async ({ playwright }, testInfo) => {
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-assignments-"));
  const server = await syntheticServer(profile);
  const extension = path.resolve(".output/chrome-mv3");
  const context = await playwright.chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, ignoreHTTPSErrors: true,
    colorScheme: "light", reducedMotion: "reduce",
    args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      `--host-resolver-rules=MAP mylms.korea.ac.kr 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
      "--no-proxy-server", "--ignore-certificate-errors",
    ],
  });
  let requests = 0, revision = 1;
  let fail: "network" | "login" | null = null;
  let holdNext = false;
  const held: { release?: () => void } = {};
  // Synthetic Canvas responses. The real extension still handles all messages,
  // account checks, course selectors, caching and rendering.
  await context.route((url) => url.pathname === "/api/v1/courses", (route) =>
    route.fulfill({ json: [
      { id: 101, name: "자료구조 (샘플)", course_code: "SAMPLE101" },
      { id: 102, name: "운영체제 (샘플)", course_code: "SAMPLE102" },
    ] }),
  );
  await context.route((url) => /\/api\/v1\/courses\/\d+\/assignments$/.test(url.pathname), async (route) => {
    requests++;
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((resolve) => { held.release = resolve; });
    }
    const error = fail;
    fail = null;
    if (error === "network") return route.abort("failed");
    if (error === "login") return route.fulfill({ status: 401, json: { errors: [{ message: "synthetic login required" }] } });
    const now = Date.now();
    return route.fulfill({ json: [
      { id: 201, name: `해시 테이블 구현 (샘플 ${revision})`, due_at: new Date(now + 3600000).toISOString(),
        published: true, locked_for_user: false, submission_types: ["online_upload"], submission: { workflow_state: "unsubmitted" } },
      { id: 202, name: "트리 순회 실습 (샘플)", due_at: new Date(now + 3 * 86400000).toISOString(),
        published: true, locked_for_user: false, submission_types: ["online_upload"], submission: { workflow_state: "unsubmitted" } },
      { id: 203, name: "제출한 과제 (샘플)", due_at: new Date(now + 86400000).toISOString(),
        published: true, locked_for_user: false, submission: { workflow_state: "submitted", submitted_at: new Date(now - 1000).toISOString() } },
      { id: 204, name: "마감 지난 과제 (샘플)", due_at: new Date(now - 86400000).toISOString(),
        published: true, locked_for_user: false, submission: { workflow_state: "unsubmitted" } },
    ] });
  });
  try {
    const lms = await context.newPage();
    await lms.goto("https://mylms.korea.ac.kr/courses");
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    await lms.bringToFront();
    await panel.getByRole("button", { name: "내 과목", exact: true }).click();
    await panel.locator("button.list-row").filter({ hasText: "자료구조 (샘플)" }).click();
    await expect(panel.getByRole("heading", { name: "남은 과제 2개", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "과제 새로고침", exact: true })).toBeVisible();
    const refresh = panel.getByRole("button", { name: "과제 새로고침", exact: true });
    const updated = panel.locator(".assignment-freshness time");
    const originalTime = await updated.getAttribute("datetime");
    for (const width of [320, 420]) {
      await panel.setViewportSize({ width, height: 800 });
      expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const placement = await panel.evaluate(() => {
        const refresh = document.querySelector(".assignment-refresh");
        const view = document.querySelector(".assignment-view-toggle");
        const context = document.querySelector(".assignment-course-actions");
        if (!refresh || !view || !context) throw new Error("Missing assignment controls");
        return {
          right: refresh.getBoundingClientRect().right,
          contextRight: context.getBoundingClientRect().right,
          refreshRadius: getComputedStyle(refresh).borderRadius,
          viewRadius: getComputedStyle(view).borderRadius,
        };
      });
      expect(Math.abs(placement.right - placement.contextRight)).toBeLessThan(1);
      expect(placement.refreshRadius).toBe(placement.viewRadius);
      await panel.screenshot({ path: testInfo.outputPath(`assignments-${width}.png`), fullPage: true });
    }
    const beforeFilter = requests;
    await panel.getByRole("button", { name: "보기 변경", exact: true }).click();
    const options = panel.getByRole("dialog", { name: "과제 보기 변경" });
    await options.getByRole("button", { name: "전체", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "남은 과제 2개", exact: true })).toBeVisible();
    await panel.screenshot({ path: testInfo.outputPath("assignment-options.png"), fullPage: true });
    await panel.keyboard.press("Escape");
    await expect(options).toHaveCount(0);
    await panel.getByRole("button", { name: "보기 변경", exact: true }).click();
    await options.getByRole("button", { name: "전체", exact: true }).click();
    await options.getByRole("button", { name: "4개 과제 보기", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "과제 4개", exact: true })).toBeVisible();
    expect(requests).toBe(beforeFilter);

    holdNext = true;
    await refresh.click();
    await expect.poll(() => Boolean(held.release)).toBe(true);
    try {
      await expect(panel.getByText("해시 테이블 구현 (샘플 1)", { exact: true })).toBeVisible();
      await expect(panel.getByText("제출한 과제 (샘플)", { exact: true })).toBeVisible();
      await expect(refresh).toHaveAttribute("aria-busy", "true");
      await expect(panel.locator(".assignment-freshness")).toHaveText("업데이트 중");
      await panel.screenshot({ path: testInfo.outputPath("assignment-refreshing.png"), fullPage: true });
      revision = 2;
    } finally {
      held.release?.();
      held.release = undefined;
    }
    await expect(panel.getByText("해시 테이블 구현 (샘플 2)", { exact: true })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "과제 4개", exact: true })).toBeVisible();
    expect(await updated.getAttribute("datetime")).not.toBe(originalTime);

    const lastSuccess = await updated.getAttribute("datetime");
    fail = "network";
    await refresh.click();
    await expect(panel.getByRole("alert")).toContainText("LMS에 연결하지 못했습니다");
    await expect(panel.getByText("해시 테이블 구현 (샘플 2)", { exact: true })).toHaveCount(0);
    expect(await updated.getAttribute("datetime")).toBe(lastSuccess);
    await panel.screenshot({ path: testInfo.outputPath("assignment-refresh-failed.png"), fullPage: true });
    const failedRequests = requests;
    revision = 3;
    await refresh.click();
    await expect(panel.getByText("해시 테이블 구현 (샘플 3)", { exact: true })).toBeVisible();
    expect(requests).toBe(failedRequests + 1);
    fail = "login";
    await refresh.click();
    await expect(panel.getByRole("alert")).toContainText("로그인 필요");
    await expect(panel.getByText("해시 테이블 구현 (샘플 3)", { exact: true })).toHaveCount(0);
    await expect(updated).toHaveCount(0);
  } finally {
    held.release?.();
    await context.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
