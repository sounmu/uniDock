import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: ".wxt/e2e/test-results",
  preserveOutput: "always",
  reporter: [
    ["line"],
    ["html", { open: "never", outputFolder: ".wxt/e2e/playwright-report" }],
  ],
});
