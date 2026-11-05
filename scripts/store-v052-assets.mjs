/* global document -- page.evaluate() 안에서 실행되는 브라우저 컨텍스트 */
import { build } from "vite";
import { chromium } from "@playwright/test";
import path from "node:path";
await build({
  configFile: false,
  logLevel: "error",
  define: { __UNIDOCK_PLAYBACK__: "false", __UNIDOCK_AI_CAPTIONS__: "false" },
  build: {
    ssr: "scripts/store-v052-render.tsx",
    outDir: ".store-v052-build",
    rollupOptions: { output: { entryFileNames: "render.mjs" } },
  },
});
await import(path.resolve(".store-v052-build/render.mjs"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: "light",
});
for (const name of [
  "01-assignments",
  "02-recordings",
  "03-schedule",
  "04-materials",
]) {
  await page.goto("file://" + path.resolve(`store/assets/v0.5.2/${name}.html`));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `store/assets/v0.5.2/${name}.png` });
}
await browser.close();
