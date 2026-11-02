import { spawnSync } from "node:child_process";
import process from "node:process";

// Builds against the routed synthetic collector, then restores the normal build
// so the test origin never stays in .output/.
const env = {
  ...process.env,
  UNIDOCK_STATS_SERVER: "https://stats.test",
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
