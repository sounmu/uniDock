import console from "node:console";
import fs from "node:fs";
import { chromium } from "@playwright/test";

// Keep the editable SVG as the single source for app and store branding.
const svg = fs.readFileSync("store/assets/logo-concepts/unidock-glass.svg", "utf8");
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  for (const size of [16, 32, 48, 128]) {
    // A fresh page avoids stale compositor tiles when changing icon sizes.
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.locator("svg").screenshot({
      path: `public/icons/${size}.png`,
      omitBackground: true,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log("Generated uniDock glass icons from the editable SVG.");
