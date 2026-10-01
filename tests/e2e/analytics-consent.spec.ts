import { test, expect, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";

test("production analytics requires consent, sends only approved payloads, and stops across panels on revoke/delete", async ({
  playwright,
}, testInfo) => {
  test.setTimeout(75000);
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-analytics-"));
  const server = await syntheticServer(profile);
  const extensionPath = path.resolve(".output/chrome-mv3");
  let context: BrowserContext | undefined;
  const errors: string[] = [];
  const batches: Record<string, unknown>[] = [];
  const paths: string[] = [];
  try {
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 420, height: 800 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--host-resolver-rules=MAP mylms.korea.ac.kr 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
        "--no-proxy-server",
        "--ignore-certificate-errors",
      ],
    });
    await context.route("https://eu.i.posthog.com/**", async (route) => {
      const request = route.request();
      paths.push(new URL(request.url()).pathname);
      if (request.method() === "POST") batches.push(request.postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: '{"status":1}',
      });
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    worker.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const id = new URL(worker.url()).host;
    const lms = await context.newPage();
    await lms.goto("https://mylms.korea.ac.kr/");
    const panel = await context.newPage();
    panel.on("pageerror", (error) => errors.push(error.message));
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    const storage = () =>
      worker.evaluate(() => chrome.storage.local.get("unidock.analytics.v1"));
    const events = () =>
      batches.flatMap(
        (batch) =>
          batch.batch as {
            event: string;
            distinct_id: string;
            properties: Record<string, unknown>;
          }[],
      );
    await panel.getByRole("button", { name: "정보", exact: true }).click();
    expect(await storage()).not.toHaveProperty("unidock.analytics.v1");
    expect(batches).toHaveLength(0);
    const consent = panel.getByRole("button", {
      name: "동의하고 통계 공유",
      exact: true,
    });
    await expect(consent).toBeVisible();
    const configured = await panel.evaluate(async () => {
      const status = await chrome.runtime.sendMessage({
        version: 1,
        type: "ANALYTICS_STATUS",
      });
      return status.available === true;
    });
    if (process.env.UNIDOCK_ANALYTICS_E2E) expect(configured).toBe(true);
    if (!configured) {
      // The ordinary production build without a key must remain a functioning, non-collecting app.
      await expect(consent).toBeDisabled();
      expect(events()).toHaveLength(0);
      await panel.screenshot({
        path: testInfo.outputPath("analytics-unconfigured.png"),
        fullPage: true,
      });
      return;
    }
    await expect(consent).toBeEnabled();
    for (const width of [320, 420]) {
      await panel.setViewportSize({ width, height: 900 });
      expect(
        await panel.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await panel.screenshot({
        path: testInfo.outputPath(`analytics-consent-${width}.png`),
        fullPage: true,
      });
    }
    await panel
      .getByRole("button", { name: "공유하지 않음", exact: true })
      .click();
    await expect
      .poll(storage)
      .toEqual({ "unidock.analytics.v1": { version: 1, enabled: false } });
    await panel.reload();
    await panel.getByRole("button", { name: "정보", exact: true }).click();
    await expect(
      panel.getByText("사용 통계 공유 안 함", { exact: true }),
    ).toBeVisible();
    expect(events()).toHaveLength(0);

    const other = await context.newPage();
    other.on("pageerror", (error) => errors.push(error.message));
    await other.goto(`chrome-extension://${id}/sidepanel.html`);
    await other.getByRole("button", { name: "정보", exact: true }).click();
    await consent.click();
    await expect(
      panel.getByText("사용 통계 공유 중", { exact: true }),
    ).toBeVisible();
    await expect(
      other.getByText("사용 통계 공유 중", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        () => events().filter((event) => event.event === "panel_opened").length,
      )
      .toBeGreaterThan(0);
    const firstId = events()[0]!.distinct_id;
    expect(firstId).toMatch(/^[a-f0-9-]{36}$/);

    await lms.bringToFront();
    await panel.getByRole("button", { name: "내 과목", exact: true }).click();
    await expect(panel.getByText("조회 완료 · 2개 과목")).toBeVisible();
    await panel
      .getByRole("button", { name: /Synthetic Operating Systems/ })
      .click();
    await expect(
      panel.getByText("Synthetic Final Project", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        events().some((event) => event.properties.action === "course_select"),
      )
      .toBe(true);
    await expect
      .poll(() =>
        events().some(
          (event) =>
            event.event === "feature_result" &&
            event.properties.feature === "assignments",
        ),
      )
      .toBe(true);
    // Real foreground time and a screen transition flush engagement (no fake JS clock).
    await panel.bringToFront();
    await panel.getByText("보기 설정", { exact: true }).click();
    await expect
      .poll(() => panel.evaluate(() => document.hasFocus()))
      .toBe(true);
    await panel.waitForTimeout(1200);
    await panel.getByRole("button", { name: "정보", exact: true }).click();
    await expect
      .poll(() =>
        events().some(
          (event) =>
            event.event === "panel_engagement" &&
            Number(event.properties.active_seconds) >= 1,
        ),
      )
      .toBe(true);

    const encoded = JSON.stringify(batches);
    for (const forbidden of [
      "Synthetic",
      "mylms.korea",
      "chrome-extension:",
      "courseSelector",
      "filename",
      "$current_url",
      "$browser",
      "$os",
      "$session_id",
    ])
      expect(encoded).not.toContain(forbidden);
    for (const event of events()) {
      expect([
        "panel_opened",
        "screen_viewed",
        "action_clicked",
        "feature_result",
        "panel_engagement",
      ]).toContain(event.event);
      expect(event.properties.$geoip_disable).toBe(true);
      expect(event.properties.$process_person_profile).toBe(false);
      expect(event.properties.$ip).toBeNull();
    }
    expect(new Set(paths)).toEqual(new Set(["/batch/"]));

    await other
      .getByRole("button", { name: "통계 공유 철회", exact: true })
      .click();
    await panel.getByRole("button", { name: "정보", exact: true }).click();
    await expect(
      panel.getByText("사용 통계 공유 안 함", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(storage)
      .toEqual({ "unidock.analytics.v1": { version: 1, enabled: false } });
    // Let already received requests settle, then verify further interactions do not send.
    const count = events().length;
    await panel.getByRole("button", { name: "자막 추출", exact: true }).click();
    await panel.getByRole("button", { name: "정보", exact: true }).click();
    await panel.reload();
    await panel.getByRole("button", { name: "정보", exact: true }).click();
    expect(events()).toHaveLength(count);
    await consent.click();
    await expect(
      panel.getByText("사용 통계 공유 중", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => events().some((event) => event.distinct_id !== firstId))
      .toBe(true);
    await panel.getByRole("button", { name: "자동 재생", exact: true }).click();
    await panel.getByText("안내 및 로컬 데이터", { exact: true }).click();
    await panel
      .getByRole("button", { name: "로컬 데이터 모두 삭제", exact: true })
      .click();
    await panel.getByRole("button", { name: "삭제 확인", exact: true }).click();
    await expect.poll(storage).toEqual({});
    await expect(
      other.getByText("사용 통계 공유 안 함", { exact: true }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "정보", exact: true }).click();
    await expect(
      panel.getByText("사용 통계 공유 안 함", { exact: true }),
    ).toBeVisible();
    await panel.screenshot({
      path: testInfo.outputPath("analytics-cleared.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
