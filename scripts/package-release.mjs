import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";
const root = path.resolve(".output/chrome-mv3");
// Sequential playback is under review and must never ship in a release ZIP.
assert.notEqual(
  process.env.UNIDOCK_PLAYBACK,
  "1",
  "Release packaging requires a build without UNIDOCK_PLAYBACK=1",
);
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
  ["activeTab", "downloads", "scripting", "sidePanel"].sort(),
);
assert.deepEqual(
  [...manifest.host_permissions].sort(),
  [...lmsHosts, "https://kucom.korea.ac.kr/*"].sort(),
);
for (const key of [
  "externally_connectable",
  "web_accessible_resources",
  "update_url",
  "key",
  "oauth2",
  "optional_host_permissions",
])
  assert.equal(manifest[key], undefined);
assert.equal(manifest.side_panel.default_path, "sidepanel.html");
assert.equal(manifest.background.service_worker, "background.js");
assert.equal(manifest.content_scripts.length, 1);
const lmsContent = manifest.content_scripts.find((script) =>
  script.js.includes("content-scripts/lms.js"),
);
assert(lmsContent);
assert.equal(lmsContent.all_frames, false);
assert.deepEqual([...lmsContent.matches].sort(), lmsHosts);
assert(
  !manifest.description.includes("자동 재생"),
  "Release description must not advertise playback",
);
assert.equal(
  manifest.content_security_policy.extension_pages,
  "script-src 'self'; object-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'",
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
for (const file of files) {
  assert(
    /^(?:manifest\.json|sidepanel\.html|privacy\.html|THIRD_PARTY_NOTICES\.txt|background\.js|icons\/(?:16|32|48|128)\.png|chunks\/[\w-]+\.js|content-scripts\/lms\.js|assets\/[\w-]+\.css)$/.test(
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
    // Markers unique to the playback runtime, player bridge, and panel. If one
    // appears, the build flag failed to tree-shake the review-pending feature.
    for (const marker of [
      "unidock.playback.owned-tab",
      "PLAYBACK_PLAYER_HELLO",
      "PLAYBACK_DISCOVER",
      "PLAYBACK_REFRESH",
      "unidock-playback-v1",
    ])
      assert(!code.includes(marker), `Playback code leaked into ${file}`);
  }
}
for (const file of ["privacy.html", "THIRD_PARTY_NOTICES.txt", "icons/128.png"])
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
