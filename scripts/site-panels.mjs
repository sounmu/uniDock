import { build } from "vite";
import console from "node:console";
import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { captureSiteCaptions } from "./site-captions.mjs";

// Usage: npm run site:panels -- ../unidock.co.kr/public/panels
// Other panels use the core build; captions drives the real AI-enabled app.
const [target, ...rest] = process.argv.slice(2);
if (!target || rest.length) {
  console.error("Usage: node scripts/site-panels.mjs <output-dir>");
  process.exit(1);
}
const outDir = ".site-panels-build";
await build({
  configFile: false,
  logLevel: "error",
  define: { __UNIDOCK_PLAYBACK__: "false", __UNIDOCK_AI_CAPTIONS__: "false" },
  build: {
    ssr: "scripts/site-panels-render.tsx",
    outDir,
    rollupOptions: { output: { entryFileNames: "render.mjs" } },
  },
});
process.env.SITE_PANELS_OUT = path.resolve(target);
try {
  await import(path.resolve(outDir, "render.mjs"));
  await captureSiteCaptions(process.env.SITE_PANELS_OUT);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
console.log(`Updated ${process.env.SITE_PANELS_OUT}`);
