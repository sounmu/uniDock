import { spawnSync } from "node:child_process";
import process from "node:process";

// Use the core build so local .env feature flags cannot hide a dependency on
// optional permissions. Restore the normal build so stats.test never stays.
const env = {
  ...process.env,
  UNIDOCK_STATS_SERVER: "https://stats.test",
  UNIDOCK_PLAYBACK: "0",
  UNIDOCK_AI_CAPTIONS: "0",
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
