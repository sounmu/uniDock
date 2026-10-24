import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * True only when `.output/chrome-mv3` was built with `UNIDOCK_PLAYBACK=1`.
 * Release builds omit the player content script, so playback specs skip there.
 * Both builds declare lms.js; lms-popup.js is registered at runtime.
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

/** True only when the extension was built with `UNIDOCK_AI_CAPTIONS=1`. */
export function aiCaptionsBuild(
  extensionPath = path.resolve(".output/chrome-mv3"),
): boolean {
  let manifest: { permissions?: string[] };
  try {
    manifest = JSON.parse(
      readFileSync(path.join(extensionPath, "manifest.json"), "utf8"),
    );
  } catch {
    return false;
  }
  return (manifest.permissions ?? []).includes(
    "declarativeNetRequestWithHostAccess",
  );
}

export const AI_CAPTIONS_SKIP_REASON =
  "requires an AI caption build (npm run test:e2e:ai-captions)";
