/** Opt-in HTTP smoke test against KU's publicly accessible LMS training video.
 * Models the default single-story config from its public content XML. This is
 * not a logged-in browser / extension-permission / CORS integration test.
 */
import fs from "node:fs/promises";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import assert from "node:assert/strict";
import ts from "typescript";
import { JSDOM } from "jsdom";
const moduleUrl = async (path, replacements = []) => {
  let source = ts.transpileModule(await fs.readFile(path, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText;
  for (const [from, to] of replacements) source = source.replaceAll(from, to);
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
};
const transcriptModule = await moduleUrl("src/captions/transcript.ts");
const { parseVtt } = await import(transcriptModule);
const { exportTranscript } = await import(
  await moduleUrl("src/captions/download.ts", [
    ["'./transcript'", JSON.stringify(transcriptModule)],
  ])
);
const { collectCaptionSources } = await import(
  await moduleUrl("src/captions/extract.ts")
);
const sourceUrl = "https://kucom.korea.ac.kr/em/6746b8bd7574a";
const dom = new JSDOM("", { url: sourceUrl });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = new URL(sourceUrl);
globalThis.DOMParser = dom.window.DOMParser;
const response = await globalThis.fetch(
  "https://kucom.korea.ac.kr/viewer/ssplayer/uniplayer_support/content.php?content_id=6746b8bd7574a",
  { signal: globalThis.AbortSignal.timeout(15000) },
);
assert.equal(response.ok, true);
const content = new dom.window.DOMParser().parseFromString(
  await response.text(),
  "application/xml",
);
assert.equal(content.querySelector("parsererror"), null);
const contentUri = content.querySelector("content_uri")?.textContent;
assert.ok(contentUri);
dom.window.uniPlayerConfig = {
  _contentPlayingInfoData: {
    contentUri,
    contentType: "video1",
    storyList: [
      { isIntro: false, storyFileNameList: { caption: "caption_list.xml" } },
    ],
  },
};
const result = await collectCaptionSources("player");
assert.equal(result.blocked, false);
assert.ok(result.vtt);
const items = parseVtt(result.vtt);
assert.ok(items.length > 0);
const transcript = {
  sourceUrl,
  pageTitle:
    content.querySelector("content_metadata title")?.textContent ||
    "KU 공개 교육 영상",
  extractedAt: new Date().toISOString(),
  itemCount: items.length,
  items,
};
const files = exportTranscript(transcript);
assert.deepEqual(JSON.parse(files.json), transcript);
assert.equal(files.text.trimEnd().split("\n").length, items.length);
await fs.mkdir("output", { recursive: true });
await fs.writeFile("output/ku-public-caption-test.txt", files.text);
await fs.writeFile("output/ku-public-caption-test.json", files.json);
globalThis.console.log(
  `Public KU XML → VTT → TXT/JSON: ${items.length} cues; output/ku-public-caption-test.{txt,json}`,
);
dom.window.close();
