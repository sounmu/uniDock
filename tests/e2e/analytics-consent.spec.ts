import { test, expect, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";

const COLLECTOR = "https://stats.test";
type Report = Record<string, unknown> & {
  date: string;
  active_installs: number;
  core_installs: number;
  service_entries: Record<string, number>;
  service_installs: Record<string, number>;
  operations: Record<string, Record<string, Record<string, number>>>;
};

for (const reset of ["off", "erase"] as const) {
  test(`daily reach includes its denominator after unsent ${reset}`, async ({
    playwright,
  }) => {
    test.skip(
      process.env.UNIDOCK_STATS_SERVER !== COLLECTOR,
      "requires the synthetic collector build",
    );
    // Observe the normal first-send event. Core builds use the runtime timer
    // and do not grant chrome.alarms; no privileged test trigger is needed.
    test.setTimeout(180_000);
    const profile = await mkdtemp(path.join(tmpdir(), "unidock-reach-"));
    let context: BrowserContext | undefined;
    const captured = Promise.withResolvers<Report>();
    let requests = 0;
    try {
      context = await playwright.chromium.launchPersistentContext(profile, {
        channel: "chromium",
        headless: true,
        args: [
          `--disable-extensions-except=${path.resolve(".output/chrome-mv3")}`,
          `--load-extension=${path.resolve(".output/chrome-mv3")}`,
          "--host-resolver-rules=MAP * ~NOTFOUND",
          "--no-proxy-server",
        ],
      });
      await context.route(`${COLLECTOR}/v1/reports`, async (route) => {
        requests++;
        const body: Report = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: '{"status":"accepted"}',
        });
        captured.resolve(body);
      });
      const worker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent("serviceworker"));
      const id = new URL(worker.url()).host;
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${id}/sidepanel.html`);
      await panel.evaluate(async (mode) => {
        const command = (message: object) =>
          chrome.runtime.sendMessage({ version: 1, ...message });
        await command({ type: "ANALYTICS_SET", enabled: false });
        await command({ type: "ANALYTICS_SET", enabled: true });
        await command({
          type: "ANALYTICS_SIGNAL",
          signal: { kind: "service", service: "courses" },
        });
        if (mode === "off") {
          await command({ type: "ANALYTICS_SET", enabled: false });
          await command({ type: "ANALYTICS_SET", enabled: true });
        } else {
          await command({ type: "LOCAL_DATA_DELETE_ALL" });
        }
        await command({
          type: "ANALYTICS_SIGNAL",
          signal: { kind: "core", result: "tasks_shown" },
        });
        await command({
          type: "ANALYTICS_SIGNAL",
          signal: { kind: "service", service: "tasks" },
        });
      }, reset);
      expect(requests).toBe(0);
      expect(await captured.promise).toMatchObject({
        active_installs: 1,
        core_installs: 1,
        service_installs: { tasks: 1 },
      });
      expect(requests).toBe(1);
    } finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
}

test("aggregate statistics: first-run notice, daily dedupe, closed payloads, OFF across panels and clear-data", async ({
  playwright,
}, testInfo) => {
  // The first report is sealed one minute after the first counted activity.
  test.setTimeout(180_000);
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-analytics-"));
  const server = await syntheticServer(profile);
  const extensionPath = path.resolve(".output/chrome-mv3");
  let context: BrowserContext | undefined;
  const errors: string[] = [];
  const bodies: string[] = [];
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
    await context.route(`${COLLECTOR}/**`, async (route) => {
      const request = route.request();
      paths.push(new URL(request.url()).pathname);
      if (request.method() === "POST") bodies.push(request.postData() ?? "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: '{"status":"accepted"}',
      });
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    worker.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const id = new URL(worker.url()).host;
    const local = (key: string) =>
      worker.evaluate(
        async (name) => (await chrome.storage.local.get(name))[name],
        key,
      );
    const reports = () => bodies.map((body) => JSON.parse(body) as Report);
    const lms = await context.newPage();
    await lms.goto("https://mylms.korea.ac.kr/");
    const panel = await context.newPage();
    panel.on("pageerror", (error) => errors.push(error.message));
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);

    const status = await panel.evaluate(() =>
      chrome.runtime.sendMessage({ version: 1, type: "ANALYTICS_STATUS" }),
    );
    const notice = panel.getByLabel("사용 통계 안내");
    if (process.env.UNIDOCK_STATS_SERVER) expect(status.available).toBe(true);
    if (!status.available) {
      // A build without a collector stays a working, non-collecting app.
      await panel.getByRole("button", { name: "설정", exact: true }).click();
      await expect(
        panel.getByText("이 빌드는 통계를 보내지 않습니다."),
      ).toBeVisible();
      await expect(
        panel.getByRole("switch", { name: "사용 통계 보내기" }),
      ).toHaveAttribute("aria-disabled", "true");
      await expect(notice).toHaveCount(0);
      expect(bodies).toHaveLength(0);
      await panel.screenshot({
        path: testInfo.outputPath("analytics-unconfigured.png"),
        fullPage: true,
      });
      return;
    }
    await expect(notice).toContainText("기본 켜짐");
    await expect(notice).toContainText("설정 → 사용");
    await expect
      .poll(() => local("unidock.analytics.v2"))
      .toEqual({ version: 2, enabled: true, notice: null });
    for (const width of [320, 420]) {
      await panel.setViewportSize({ width, height: 900 });
      expect(
        await panel.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await panel.screenshot({
        path: testInfo.outputPath(`analytics-notice-${width}.png`),
        fullPage: true,
      });
    }
    await panel.getByRole("button", { name: "확인", exact: true }).click();
    await expect(notice).toBeHidden();

    // The LMS tab must be active for queries; panel re-entries happen on return.
    await lms.bringToFront();
    await panel.getByRole("button", { name: "내 과목", exact: true }).click();
    await expect(panel.getByText("조회 완료 · 2개 과목")).toBeVisible();
    await panel
      .getByRole("button", { name: /Synthetic Operating Systems/ })
      .click();
    await expect(
      panel.getByText("Synthetic Final Project", { exact: true }),
    ).toBeVisible();
    await panel.bringToFront();
    await panel
      .getByRole("button", { name: "할 일·일정", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "할 일·일정", exact: true })
      .click();
    await panel.getByRole("button", { name: "내 과목", exact: true }).click();

    await expect
      .poll(() => bodies.length, { timeout: 150_000 })
      .toBeGreaterThan(0);
    const [first] = reports();
    expect(Object.keys(first!).sort()).toEqual(
      [
        "active_installs",
        "core_installs",
        "core_results",
        "date",
        "extension_version",
        "operations",
        "report_id",
        "schema",
        "service_entries",
        "service_installs",
      ].sort(),
    );
    const sum = (pick: (r: Report) => number) =>
      reports().reduce((total, report) => total + pick(report), 0);
    expect(sum((r) => r.active_installs)).toBe(1);
    expect(sum((r) => r.core_installs)).toBeLessThanOrEqual(1);
    expect(sum((r) => r.service_installs.courses ?? 0)).toBe(1);
    expect(sum((r) => r.service_installs.tasks ?? 0)).toBe(1);
    // Panel open (courses), tasks once (re-select ignored), back to courses.
    expect(sum((r) => r.service_entries.courses ?? 0)).toBe(2);
    expect(sum((r) => r.service_entries.tasks ?? 0)).toBe(1);
    expect(sum((r) => r.operations.course_items_load?.user?.success ?? 0)).toBe(
      1,
    );
    const encoded = bodies.join("\n");
    for (const forbidden of [
      "Synthetic",
      "mylms",
      "korea.ac.kr",
      "chrome-extension",
      "courseSelector",
      "filename",
      "client_id",
      "session",
    ])
      expect(encoded).not.toContain(forbidden);
    expect(new Set(paths)).toEqual(new Set(["/v1/reports"]));

    // A second panel follows OFF made in the first; OFF discards unsent data.
    const other = await context.newPage();
    other.on("pageerror", (error) => errors.push(error.message));
    await other.goto(`chrome-extension://${id}/sidepanel.html`);
    await other.getByRole("button", { name: "설정", exact: true }).click();
    await panel.getByRole("button", { name: "설정", exact: true }).click();
    const toggle = panel.getByRole("switch", { name: "사용 통계 보내기" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(
      other.getByRole("switch", { name: "사용 통계 보내기" }),
    ).toHaveAttribute("aria-checked", "false");
    await expect
      .poll(() => local("unidock.analytics-counters.v1"))
      .toMatchObject({ pending: [], queue: [] });
    await panel
      .getByRole("button", { name: "할 일·일정", exact: true })
      .click();
    await panel.getByRole("button", { name: "자막 추출", exact: true }).click();
    expect(await local("unidock.analytics-counters.v1")).toMatchObject({
      pending: [],
      queue: [],
    });

    // Clear-data must never turn an earlier OFF back into default ON.
    await panel.getByRole("button", { name: "설정", exact: true }).click();
    await panel
      .getByRole("button", { name: "로컬 데이터 모두 삭제", exact: true })
      .click();
    await panel.getByRole("button", { name: "삭제 확인", exact: true }).click();
    await expect(panel.getByText("로컬 데이터를 삭제했습니다.")).toBeVisible();
    expect(await local("unidock.analytics.v2")).toEqual({
      version: 2,
      enabled: false,
      notice: null,
    });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await panel.screenshot({
      path: testInfo.outputPath("analytics-off-cleared.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
