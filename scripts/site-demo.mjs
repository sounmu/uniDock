import { build, preview } from "vite";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import console from "node:console";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { captionOrigin } from "./site-captions-fixture.mjs";
import { publishDemoOutput, readDemoOutput } from "./site-demo-output.mjs";

// Usage: npm run site:demo -- ../website/public/demo
// Builds the real side panel as a static page for unidock.co.kr with every
// browser and server boundary faked in-page (scripts/site-demo-runtime.mjs).
// One page serves all cards: index.html?screen=tasks|recordings|materials|captions.
const [target, ...rest] = process.argv.slice(2);
if (!target || rest.length) {
  console.error("Usage: node scripts/site-demo.mjs <output-dir>");
  process.exit(1);
}
const outDir = path.resolve(target);
let previous;
try {
  previous = await readDemoOutput(outDir);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const buildDir = await mkdtemp(path.join(os.tmpdir(), "unidock-site-demo-"));
const sidepanel = path.resolve("entrypoints/sidepanel");
const runtime = path.resolve("scripts/site-demo-runtime.mjs");
try {
  await build({
    configFile: false,
    logLevel: "error",
    root: sidepanel,
    base: "./",
    plugins: [
      {
        name: "site-demo-runtime",
        transform(code, id) {
          if (id !== path.join(sidepanel, "main.tsx")) return;
          return {
            code: `import ${JSON.stringify(runtime)};\n${code}`,
            map: null,
          };
        },
      },
    ],
    define: {
      __UNIDOCK_PLAYBACK__: "false",
      __UNIDOCK_AI_CAPTIONS__: "true",
      __UNIDOCK_CAPTION_SERVER__: JSON.stringify(captionOrigin),
      __UNIDOCK_STATS_SERVER__: '""',
    },
    build: { outDir: buildDir, emptyOutDir: true },
  });
  await publishDemoOutput(buildDir, outDir, previous);
} finally {
  await rm(buildDir, { recursive: true, force: true });
}

// Smoke check: every screen opens, with no page errors and no request that
// leaves the static assets.
const evidenceDir = path.resolve("output/site-demo");
await mkdir(evidenceDir, { recursive: true });
const server = await preview({
  configFile: false,
  logLevel: "error",
  root: sidepanel,
  build: { outDir },
  preview: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 440, height: 600 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  const external = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === origin)
      return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  for (const screen of ["tasks", "recordings", "materials", "captions"]) {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`${origin}/index.html?screen=${screen}`);
    await page.locator('html[data-demo="ready"]').waitFor();
    await page.screenshot({ path: path.join(evidenceDir, `${screen}.png`) });
    assert.deepEqual(errors, [], `${screen}: page errors`);
    await page.close();
  }
  assert.deepEqual(external, [], "The demo must not leave its own origin");
} finally {
  if (browser) await browser.close();
  await new Promise((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  );
}
console.log(`Updated ${outDir}`);
