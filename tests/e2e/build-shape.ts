import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * True only when `.output/chrome-mv3` was built with `UNIDOCK_PLAYBACK=1`.
 * Release builds omit the player content script, so playback specs skip there.
 */
export function playbackBuild(
  extensionPath = path.resolve(".output/chrome-mv3"),
): boolean {
  let manifest: { content_scripts?: { js?: string[] }[] };
  try {
    manifest = JSON.parse(
      readFileSync(path.join(extensionPath, "manifest.json"), "utf8"),
    );
  } catch {
    return false;
  }
  return (manifest.content_scripts ?? []).some((script) =>
    script.js?.includes("content-scripts/player.js"),
  );
}

export const PLAYBACK_SKIP_REASON =
  "requires a playback build (npm run test:e2e:playback)";
