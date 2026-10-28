import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { URL } from "node:url";
const root = path.resolve(".output/chrome-mv3");
// Read the same env files WXT loads for a production chrome build. Shell
// variables win, and loadEnvFile never overrides a variable that is already
// set, so files are loaded from the highest precedence down.
for (const file of [
  ".env.production.chrome.local",
  ".env.production.chrome",
  ".env.chrome.local",
  ".env.chrome",
  ".env.production.local",
  ".env.production",
  ".env.local",
  ".env",
])
  if (fs.existsSync(file)) process.loadEnvFile(file);
// Since 0.4.0 the release ships sequential playback and AI captions.
assert.equal(
  process.env.UNIDOCK_PLAYBACK,
  "1",
  "Release packaging requires UNIDOCK_PLAYBACK=1 (set it in .env.local)",
);
assert.equal(
  process.env.UNIDOCK_AI_CAPTIONS,
  "1",
  "Release packaging requires UNIDOCK_AI_CAPTIONS=1 (set it in .env.local)",
);
const captionServer = new URL(process.env.UNIDOCK_CAPTION_SERVER ?? "").origin;
assert.notEqual(
  captionServer,
  "https://captions.test",
  "Release packaging requires the real caption server, not the E2E origin",
);
const CAPTION_CDN = "https://korea-cms-object.cdn.gov-ntruss.com";
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
);
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.minimum_chrome_version, "114");
const lmsHosts = [
  "https://canvas.korea.ac.kr/*",
  "https://mylms.korea.ac.kr/*",
];
assert.deepEqual(
  [...manifest.permissions].sort(),
  [
    "activeTab",
    "alarms",
    "declarativeNetRequestWithHostAccess",
    "downloads",
    "identity",
    "scripting",
    "sidePanel",
    "storage",
  ].sort(),
);
assert.deepEqual(
  [...manifest.host_permissions].sort(),
  [...lmsHosts, "https://kucom.korea.ac.kr/*"].sort(),
);
// The popup portal and caption CDN are opt-in grants, never install-time
// permissions.
assert.deepEqual(manifest.optional_host_permissions, [
  "https://lms.korea.ac.kr/*",
  `${CAPTION_CDN}/*`,
]);
for (const key of [
  "externally_connectable",
  "web_accessible_resources",
  "update_url",
  "key",
  "oauth2",
  "optional_permissions",
])
  assert.equal(manifest[key], undefined);
assert.equal(manifest.side_panel.default_path, "sidepanel.html");
assert.equal(manifest.background.service_worker, "background.js");
// lms-popup.js is registered at runtime after the opt-in, so only lms.js and
// the playback player script are declared here.
assert.equal(manifest.content_scripts.length, 2);
const [lmsContent, playerContent] = manifest.content_scripts;
assert.deepEqual(lmsContent.js, ["content-scripts/lms.js"]);
assert.equal(lmsContent.all_frames, false);
assert.equal(lmsContent.run_at, "document_idle");
assert.deepEqual([...lmsContent.matches].sort(), lmsHosts);
assert.deepEqual(playerContent.js, ["content-scripts/player.js"]);
assert.equal(playerContent.all_frames, true);
assert.equal(playerContent.run_at, "document_idle");
assert.deepEqual(
  [...playerContent.matches].sort(),
  [...lmsHosts, "https://kucom.korea.ac.kr/em/*"].sort(),
);
assert.equal(
  manifest.content_security_policy.extension_pages,
  `script-src 'self'; object-src 'none'; connect-src https://eu.i.posthog.com ${CAPTION_CDN} ${captionServer}; base-uri 'none'; form-action 'none'`,
);
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink());
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(path.relative(root, full));
  }
}
walk(root);
files.sort();
let bundle = "";
for (const file of files) {
  assert(
    /^(?:manifest\.json|sidepanel\.html|updates\.html|privacy\.html|THIRD_PARTY_NOTICES\.txt|background\.js|icons\/(?:16|32|48|128)\.png|chunks\/[\w-]+\.js|content-scripts\/(?:lms|lms-popup|player)\.js|assets\/[\w-]+\.css)$/.test(
      file,
    ),
    `Unexpected package path: ${file}`,
  );
  if (file.endsWith(".js")) {
    const code = fs.readFileSync(path.join(root, file), "utf8");
    assert(
      !/\beval\s*\(|new\s+Function\s*\(|sourceMappingURL=|localhost:\d|127\.0\.0\.1:\d/.test(
        code,
      ),
      `Forbidden runtime pattern in ${file}`,
    );
    // The E2E caption server must never be baked into a release bundle.
    assert(!code.includes("captions.test"), `Test origin leaked into ${file}`);
    bundle += code;
  }
}
// Both features must actually be compiled in, not just declared.
for (const marker of [
  "PLAYBACK_PLAYER_HELLO",
  "PLAYBACK_DISCOVER",
  "transcription-jobs",
  "launchWebAuthFlow",
  captionServer,
])
  assert(bundle.includes(marker), `Release bundle is missing ${marker}`);
for (const file of [
  "updates.html",
  "privacy.html",
  "THIRD_PARTY_NOTICES.txt",
  "icons/128.png",
  "content-scripts/lms.js",
  "content-scripts/lms-popup.js",
  "content-scripts/player.js",
])
  assert(files.includes(file));
import { dependencyNoticesText } from "./dependency-notices.mjs";
// Re-run build if installed dependency notices differ from bundled notices.
assert.equal(
  fs.readFileSync(path.join(root, "THIRD_PARTY_NOTICES.txt"), "utf8"),
  dependencyNoticesText(),
);
fs.mkdirSync("release", { recursive: true });
const zip = path.resolve(`release/uniDock-${manifest.version}-chrome-mv3.zip`);
fs.rmSync(zip, { force: true });
const packed = spawnSync("zip", ["-X", "-q", zip, ...files], {
  cwd: root,
  stdio: "inherit",
});
assert.equal(packed.status, 0);
const entries = spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" });
assert.equal(entries.status, 0);
assert.deepEqual(entries.stdout.trim().split("\n").sort(), files);
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");
const report = {
  status: "candidate-not-submitted",
  version: manifest.version,
  zip: path.basename(zip),
  sha256: hash(fs.readFileSync(zip)),
  files: files.map((file) => ({
    file,
    sha256: hash(fs.readFileSync(path.join(root, file))),
  })),
};
fs.writeFileSync(
  "release/inventory.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `Candidate ZIP and SHA-256 inventory ready: ${path.basename(zip)} (${files.length} files)`,
);
