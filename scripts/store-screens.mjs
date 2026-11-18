/* global document -- page.evaluate() runs in the browser */
import { build } from "vite";
import { chromium } from "@playwright/test";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { captureSiteCaptions } from "./site-captions.mjs";
import { capturePlayback } from "./store-playback-capture.mjs";

// Usage: node scripts/store-screens.mjs <output-dir>
// 1280x800 Chrome Web Store screenshots built from the real side-panel UI.
const [target, ...rest] = process.argv.slice(2);
if (!target || rest.length) {
  console.error("Usage: node scripts/store-screens.mjs <output-dir>");
  process.exit(1);
}
const out = path.resolve(target);
const buildDir = ".store-screens-build";
await build({
  configFile: false,
  logLevel: "error",
  // Release builds ship playback and AI captions, so Home lists both tools.
  define: { __UNIDOCK_PLAYBACK__: "true", __UNIDOCK_AI_CAPTIONS__: "true" },
  build: {
    ssr: "scripts/store-screens-render.tsx",
    outDir: buildDir,
    rollupOptions: { output: { entryFileNames: "render.mjs" } },
  },
});
process.env.STORE_SCREENS_OUT = out;
try {
  await import(path.resolve(buildDir, "render.mjs"));
} finally {
  await rm(buildDir, { recursive: true, force: true });
}
await capturePlayback(out);
await captureSiteCaptions(out);
await rename(path.join(out, "captions.html"), path.join(out, "captions-panel.html"));

const scenes = [
  ["01-home", "home", "마감 임박 과제를<br>열자마자 확인", "모든 과목의 마감을 가까운 순으로"],
  ["02-playback", "playback", "녹화 강의를<br>순서대로 자동 재생", "고른 영상을 이어서 재생합니다"],
  ["03-recordings", "recordings", "녹화 강의를<br>과목별로 모아서", "주차학습과 게시판 영상까지"],
  ["04-materials", "materials", "강의 자료를<br>한 번에 저장", "과목 이름 폴더로 정리됩니다"],
  ["05-captions", "captions", "자막 없는 강의도<br>AI 자막으로", "TXT·JSON으로 내려받기"],
];
const icon = path.resolve("public/icons/128.png");
const frame = (panel, title, sub) => `<!doctype html><html lang="ko"><meta charset="utf-8"><style>
*{box-sizing:border-box}
body{margin:0;width:1280px;height:800px;overflow:hidden;background:#faf8f6;color:#241b21;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif}
.brand{position:absolute;left:80px;top:60px;display:flex;align-items:center;gap:14px;font-weight:700;font-size:32px;letter-spacing:-1px}
.brand img{width:48px;height:48px}
.copy{position:absolute;left:80px;top:0;bottom:0;width:540px;display:flex;flex-direction:column;justify-content:center}
h1{margin:0 0 28px;font-size:68px;line-height:1.2;letter-spacing:-3px;font-weight:800}
p{margin:0;font-size:28px;line-height:1.4;letter-spacing:-.5px;color:#6f5f69;font-weight:500}
.stage{position:absolute;left:650px;top:24px;width:590px;height:752px;border-radius:36px;background:radial-gradient(ellipse at 8% 92%,#f6c9a8,transparent 65%),radial-gradient(ellipse at 95% 6%,#ba6f90,transparent 65%),linear-gradient(145deg,#ecd3d6,#872038)}
.window{position:absolute;left:68px;top:28px;width:454px;height:696px;border-radius:22px;overflow:hidden;background:#f1f1f3;box-shadow:0 28px 50px #42132345}
iframe{display:block;width:420px;height:${Math.ceil(696 / (454 / 420))}px;border:0;transform:scale(${454 / 420});transform-origin:top left}
</style><div class="brand"><img src="file://${icon}">uniDock</div><section class="copy"><h1>${title}</h1><p>${sub}</p></section><div class="stage"><div class="window"><iframe src="${panel}-panel.html"></iframe></div></div></html>
`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  for (const [name, panel, title, sub] of scenes) {
    const html = path.join(out, `${name}.html`);
    await writeFile(html, frame(panel, title, sub));
    await page.goto(`file://${html}`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
  }
} finally {
  await browser.close();
}
console.log(`Updated ${out}`);
