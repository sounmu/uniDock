import { spawnSync } from "node:child_process";
import process from "node:process";

// The fake public token must never remain in the normal build output after this check.
const env = {
  ...process.env,
  VITE_POSTHOG_KEY: "phc_unidock_synthetic_test",
  UNIDOCK_ANALYTICS_E2E: "1",
};
let status = 1;
try {
  const build = spawnSync("npm", ["run", "build"], { env, stdio: "inherit" });
  if (build.status === 0) {
    status =
      spawnSync(
        "npx",
        ["playwright", "test", "tests/e2e/analytics-consent.spec.ts"],
        { env, stdio: "inherit" },
      ).status ?? 1;
  }
} finally {
  const restore = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
  if (restore.status !== 0) status = 1;
}
process.exitCode = status;
