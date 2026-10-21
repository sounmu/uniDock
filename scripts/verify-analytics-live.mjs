// Explicit operator check: sends consenting synthetic panel events to the
// configured production PostHog project. Not part of automated CI checks.
import { chromium } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";

const profile = await mkdtemp(path.join(tmpdir(), "unidock-live-analytics-"));
const extension = path.resolve(".output/chrome-mv3");
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const panel = await context.newPage();
  await panel.goto(
    `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
  );
  await panel.getByRole("button", { name: "정보", exact: true }).click();
  const consent = panel.getByRole("button", {
    name: "동의하고 통계 공유",
    exact: true,
  });
  if (!(await consent.isEnabled())) throw new Error("ANALYTICS_UNCONFIGURED");
  const response = context.waitForEvent("response", {
    predicate: (response) =>
      response.url() === "https://eu.i.posthog.com/batch/" &&
      response.request().method() === "POST",
    timeout: 15000,
  });
  await consent.click();
  const accepted = await response;
  if (!accepted.ok()) throw new Error("ANALYTICS_HTTP_FAILURE");
  await panel.evaluate(() =>
    // eslint-disable-next-line no-undef -- executes inside the extension page
    chrome.runtime.sendMessage({ version: 1, type: "LOCAL_DATA_DELETE_ALL" }),
  );
  console.log(
    `PostHog EU accepted an opt-in synthetic SDK batch (HTTP ${accepted.status()}).`,
  );
  console.log(
    "Remote event retention/deletion and dashboard appearance require separate project verification.",
  );
} catch {
  console.error(
    "Live analytics check failed; inspect consent, production key, region and network access.",
  );
  process.exitCode = 1;
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
