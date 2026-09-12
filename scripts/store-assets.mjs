import { build } from "vite";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import console from "node:console";
await build({
  configFile: false,
  logLevel: "error",
  build: {
    ssr: "scripts/store-render.tsx",
    outDir: ".store-build",
    rollupOptions: { output: { entryFileNames: "render.mjs" } },
  },
});
await import(path.resolve(".store-build/render.mjs"));
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!fs.existsSync(chrome))
  throw new Error(
    "Set a local Chrome executable in this developer-only script.",
  );
for (const kind of ["assignments", "recordings", "promo"]) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "unidock-store-"));
  try {
    const run = spawnSync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--disable-background-networking",
        `--user-data-dir=${profile}`,
        kind === "promo" ? "--window-size=880,560" : "--window-size=1280,800",
        "--hide-scrollbars",
        `--screenshot=${path.resolve(`store/assets/${kind}.png`)}`,
        `file://${path.resolve(`store/assets/${kind}.html`)}`,
      ],
      { stdio: "ignore", timeout: 30000 },
    );
    if (run.status !== 0) throw new Error("Local screenshot failed");
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
const resize = spawnSync(
  "sips",
  [
    "--resampleHeightWidth",
    "280",
    "440",
    path.resolve("store/assets/promo.png"),
  ],
  { stdio: "ignore" },
);
if (resize.status !== 0) throw new Error("Promo resize failed");
console.log(
  "Created 1280×800 fixture-based store screenshots, not live LMS captures.",
);
