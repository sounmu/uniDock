import console from "node:console";
import fs from "node:fs";
import { chromium } from "@playwright/test";

// Keep the editable SVG as the single source for app and store branding.
const svg = fs.readFileSync("store/assets/logo-concepts/unidock-glass.svg", "utf8");
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`,
    );
    await page.screenshot({
      path: `public/icons/${size}.png`,
      omitBackground: true,
    });
  }
} finally {
  await browser.close();
}
console.log("Generated uniDock glass icons from the editable SVG.");
