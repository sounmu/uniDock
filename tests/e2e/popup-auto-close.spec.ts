import { test, expect, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syntheticServer } from "./synthetic-server";

test("popup opt-in needs the optional portal grant, closes only notices, and resets on delete", async ({
  playwright,
}, testInfo) => {
  const profile = await mkdtemp(path.join(tmpdir(), "unidock-popup-"));
  const server = await syntheticServer(profile);
  let context: BrowserContext | undefined;
  const errors: string[] = [];
  try {
    const extension = path.resolve(".output/chrome-mv3");
    context = await playwright.chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 420, height: 900 },
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        `--host-resolver-rules=MAP lms.korea.ac.kr 127.0.0.1:${server.port}, MAP * ~NOTFOUND`,
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
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    worker.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await context.route("https://lms.korea.ac.kr/popup-fixture", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body>
          <div id="xn-popup-wrapper"></div>
          <div id="xn-lms-term-survey-list">
            <div class="xnlts-button-container">
              <div class="xnlts-button" id="survey-logout">로그아웃</div>
              <div class="xnlts-button blue" id="survey-exit">설문 나가기</div>
            </div>
          </div>
          <div role="dialog"><button id="unrelated">Submit</button></div>
          <script>
            const wrapper = document.getElementById('xn-popup-wrapper');
            window.addNotice = () => {
              const item = document.createElement('div');
              item.className = 'xnp-item-wrapper';
              item.dataset.popupId = 'fixture';
              item.innerHTML = '<div class="xnp-item-content"></div><div class="xnp-item-close"><input type="checkbox" class="xnp-item-close-checkbox"><button type="button" class="xnp-item-close-button">Close</button></div>';
              item.querySelector('.xnp-item-content').attachShadow({mode:'open'}).textContent = 'Synthetic notice';
              item.querySelector('button').addEventListener('click', () => {
                if (item.querySelector('input').checked) document.body.dataset.checkboxTouched = 'true';
                item.remove();
                console.log('NOTICE_CLOSED');
              });
              wrapper.append(item);
            };
            document.getElementById('survey-logout').addEventListener('click', () => {
              document.body.dataset.logoutClicked = 'true';
            });
            document.getElementById('survey-exit').addEventListener('click', () => {
              document.getElementById('xn-lms-term-survey-list').remove();
              console.log('SURVEY_EXITED');
            });
            document.getElementById('unrelated').addEventListener('click', () => {
              document.body.dataset.unrelatedClicked = 'true';
            });
            window.addEventListener('fixture-add', window.addNotice);
            window.addNotice();
          </script></body></html>`,
      }),
    );
    const extensionId = new URL(worker.url()).host;
    const portal = { origins: ["https://lms.korea.ac.kr/*"] };
    const state = () =>
      worker.evaluate(
        async (origins) => ({
          granted: await chrome.permissions.contains(origins),
          registered: (await chrome.scripting.getRegisteredContentScripts())
            .map(({ id }) => id)
            .sort(),
        }),
        portal,
      );
    // The portal is an optional grant; headless Chrome cannot answer the
    // prompt, so the test grants it the way chrome://extensions does. The
    // panel's request then resolves without a prompt.
    const grantPortal = async () => {
      const settings = await context!.newPage();
      await settings.goto(`chrome://extensions/?id=${extensionId}`);
      await settings.evaluate(
        (id) =>
          (
            chrome as unknown as {
              developerPrivate: {
                addHostPermission(id: string, host: string): Promise<void>;
              };
            }
          ).developerPrivate.addHostPermission(id, "https://lms.korea.ac.kr/*"),
        extensionId,
      );
      await settings.close();
    };
    expect(await state()).toEqual({ granted: false, registered: [] });
    // Opened before the opt-in: nothing runs here until the grant.
    const lms = await context.newPage();
    await lms.goto("https://lms.korea.ac.kr/popup-fixture");
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.getByRole("button", { name: "설정", exact: true }).click();
    const select = panel.getByRole("switch", {
      name: "팝업 자동 닫기",
      exact: true,
    });
    await expect(select).toHaveAttribute("aria-disabled", "false");
    await expect(select).toHaveAttribute("aria-checked", "false");
    await expect(lms.locator(".xnp-item-wrapper")).toHaveCount(1);
    await expect(lms.locator("#xn-lms-term-survey-list")).toHaveCount(1);
    const firstClosed = lms.waitForEvent("console", {
      predicate: (message) => message.text() === "NOTICE_CLOSED",
    });
    const surveyExited = lms.waitForEvent("console", {
      predicate: (message) => message.text() === "SURVEY_EXITED",
    });
    await grantPortal();
    await select.click();
    await expect(select).toHaveAttribute("aria-checked", "true");
    // The already-open portal tab gets the script without a reload.
    await firstClosed;
    await surveyExited;
    await expect(lms.locator("#xn-lms-term-survey-list")).toHaveCount(0);
    await expect(lms.locator("#xn-popup-wrapper")).toHaveCount(1);
    await expect(lms.locator(".xnp-item-wrapper")).toHaveCount(0);

    const laterClosed = lms.waitForEvent("console", {
      predicate: (message) => message.text() === "NOTICE_CLOSED",
    });
    await lms.evaluate(() => window.dispatchEvent(new Event("fixture-add")));
    await laterClosed;
    expect(
      await lms.locator("body").getAttribute("data-checkbox-touched"),
    ).toBeNull();
    expect(
      await lms.locator("body").getAttribute("data-unrelated-clicked"),
    ).toBeNull();
    expect(
      await lms.locator("body").getAttribute("data-logout-clicked"),
    ).toBeNull();

    for (const colorScheme of ["light", "dark"] as const) {
      await panel.emulateMedia({ colorScheme });
      for (const width of [320, 420, 1440]) {
        await panel.setViewportSize({ width, height: 900 });
        await select.scrollIntoViewIfNeeded();
        expect(
          await panel.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await panel.screenshot({
          path: testInfo.outputPath(
            `popup-settings-${colorScheme}-${width}.png`,
          ),
          fullPage: true,
        });
      }
    }
    expect(await state()).toEqual({
      granted: true,
      registered: ["unidock-lms-popup"],
    });
    await select.click();
    await expect(select).toHaveAttribute("aria-checked", "false");
    // Turning off unregisters the script and returns the optional grant.
    await expect.poll(state).toEqual({ granted: false, registered: [] });
    await lms.reload();
    await expect(lms.locator(".xnp-item-wrapper")).toHaveCount(1);
    await expect(lms.locator("#xn-lms-term-survey-list")).toHaveCount(1);
    const resumed = lms.waitForEvent("console", {
      predicate: (message) => message.text() === "NOTICE_CLOSED",
    });
    await grantPortal();
    await select.click();
    await expect(select).toHaveAttribute("aria-checked", "true");
    await resumed;
    // A fresh document gets the registered script on its own.
    const reloaded = lms.waitForEvent("console", {
      predicate: (message) => message.text() === "NOTICE_CLOSED",
    });
    await lms.reload();
    await reloaded;
    await panel
      .getByRole("button", { name: "로컬 데이터 모두 삭제", exact: true })
      .click();
    await panel.getByRole("button", { name: "삭제 확인", exact: true }).click();
    await expect(select).toHaveAttribute("aria-checked", "false");
    expect(
      await worker.evaluate(() =>
        chrome.storage.local.get("unidock.popup-auto-close.v1"),
      ),
    ).toEqual({});
    await expect.poll(state).toEqual({ granted: false, registered: [] });
    await lms.reload();
    await expect(lms.locator(".xnp-item-wrapper")).toHaveCount(1);
    await expect(lms.locator("#xn-lms-term-survey-list")).toHaveCount(1);
    expect(
      await lms.locator("body").getAttribute("data-logout-clicked"),
    ).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
});
