// Loaded first by the site demo build (scripts/site-demo.mjs), before the real
// sidepanel/main.tsx. It replaces only the browser boundary: chrome.* (LMS tab,
// storage, downloads, caption worker port) and fetch to the caption server. The
// app code is the shipped side panel; nothing here exists in the extension.
import { CaptionJobMonitor } from "../src/captions/job-monitor";
import { safeDownloadPath } from "../src/security/download";
import {
  captionOrigin,
  captionTranscript,
  installCaptionFixture,
} from "./site-captions-fixture.mjs";
import { downloadItem, lmsReply, lmsTab } from "./site-demo-fixture.mjs";

const screens = ["tasks", "recordings", "materials", "captions"];
const screen = new globalThis.URLSearchParams(globalThis.location.search).get(
  "screen",
);
if (!screens.includes(screen)) throw new Error("Unknown site demo screen");
const root = globalThis.document.documentElement;
root.dataset.demo = "booting";
const style = globalThis.document.createElement("style");
style.textContent = `html[data-demo="booting"]{visibility:hidden}
[data-demo-locked]{cursor:not-allowed}
[data-demo-locked]:not([aria-current]){opacity:.45}
@media (pointer:coarse){html,body{overflow:hidden}}`;
globalThis.document.head.append(style);

// Answers arrive at once while the demo opens its screen, then with a short
// delay so loading states are visible after a click.
let booted = false;
const pace = () =>
  new Promise((resolve) => globalThis.setTimeout(resolve, booted ? 450 : 0));

installCaptionFixture({ persist: false });
globalThis.__siteCaptionMonitor = new CaptionJobMonitor();
const { chrome } = globalThis;
const emitter = () => {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (value) => {
      for (const listener of listeners) listener(value);
    },
  };
};
chrome.runtime.id = "unidocksitedemo";
if (screen !== "captions") {
  chrome.tabs.query = async () => [lmsTab];
  chrome.tabs.get = async () => lmsTab;
}
const downloads = [];
const onCreated = emitter();
chrome.tabs.sendMessage = async (_tabId, message) => {
  await pace();
  const reply = lmsReply(message);
  if (message.type === "DOCUMENT_DOWNLOAD_REQUEST") {
    const item = downloadItem(
      downloads.length + 1,
      message.request,
      safeDownloadPath,
      chrome.runtime.id,
    );
    downloads.push(item);
    globalThis.setTimeout(() => onCreated.emit(item), 300);
  }
  return reply;
};
// The app's own success notices stand in for new tabs and saved files.
chrome.tabs.create = async () => ({ id: 99 });
chrome.permissions.contains = async () => true;
chrome.downloads.onCreated = onCreated;
chrome.downloads.onChanged = emitter();
chrome.downloads.search = async ({ id }) =>
  downloads.filter((item) => item.id === id);
chrome.downloads.showDefaultFolder = () => {};

// Caption server: the first job (opened by the demo) is already done; a job
// the visitor starts shows one progress step first.
const realFetch = globalThis.fetch.bind(globalThis);
const polls = new Map();
let jobs = 0;
globalThis.fetch = async (input, init) => {
  const request = new globalThis.Request(input, init);
  const url = new globalThis.URL(request.url);
  if (url.protocol === "blob:" || url.origin === globalThis.location.origin)
    return realFetch(input, init);
  if (url.origin !== captionOrigin)
    throw new TypeError("The site demo makes no network requests");
  await pace();
  const job = /^\/v1\/transcription-jobs\/([\w-]+)$/.exec(url.pathname)?.[1];
  if (url.pathname === "/v1/transcription-jobs" && request.method === "POST") {
    const id = `site-demo-job-${++jobs}`;
    polls.set(id, booted ? 0 : 1);
    return globalThis.Response.json({ id, state: "queued" });
  }
  if (job && request.method === "GET" && polls.has(job)) {
    const count = polls.get(job) + 1;
    polls.set(job, count);
    return globalThis.Response.json(
      count === 1
        ? {
            id: job,
            state: "running",
            progress: { stage: "transcribing", done: 6, total: 12 },
          }
        : { id: job, state: "succeeded", transcript_id: `${job}-transcript` },
    );
  }
  if (url.pathname.startsWith("/v1/transcripts/") && request.method === "GET")
    return globalThis.Response.json(captionTranscript);
  throw new TypeError(`Unexpected demo caption request: ${url.pathname}`);
};

// Each card shows one screen. Controls on it work; the ones that leave it
// (tab bar, back links, links into another tool or settings) do nothing.
const lockedSelector =
  ".rail button, .tool-return button, .assignment-course-tabs button";
const lockedNames = new Set([
  "← 과목 선택",
  "강의 열고 자막 추출",
  "AI 자막 설정",
  "로그인하러 가기",
]);
const lockedButton = (target) => {
  const button =
    target instanceof globalThis.Element && target.closest("button");
  return button &&
    (button.matches(lockedSelector) ||
      lockedNames.has(button.textContent.trim()))
    ? button
    : null;
};
function lockNavigation() {
  // Capture on document runs before React's listener on #root.
  globalThis.document.addEventListener(
    "click",
    (event) => {
      if (!lockedButton(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  const mark = () => {
    for (const button of globalThis.document.querySelectorAll("button")) {
      if (button.dataset.demoLocked || !lockedButton(button)) continue;
      button.dataset.demoLocked = "";
      button.setAttribute("aria-disabled", "true");
      button.title = "예시 화면에서는 이 화면만 볼 수 있어요";
    }
  };
  mark();
  new globalThis.MutationObserver(mark).observe(globalThis.document.body, {
    childList: true,
    subtree: true,
  });
}

// Open this card's screen the way a user would, before showing the page.
const until = (find, what) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = find();
      if (found) resolve(found);
      else if (Date.now() - started > 15000)
        reject(new Error(`Site demo did not reach: ${what}`));
      else globalThis.setTimeout(tick, 20);
    };
    tick();
  });
const shown = (element) => !element.closest("[hidden]");
const button =
  (name, partial = false) =>
  () =>
    [...globalThis.document.querySelectorAll("button")].find((element) => {
      const label =
        element.getAttribute("aria-label") ?? element.textContent.trim();
      return (
        shown(element) && (partial ? label.includes(name) : label === name)
      );
    });
const click = async (name, partial) =>
  (await until(button(name, partial), name)).click();
const steps = {
  tasks: async () => {
    await click("일정");
    await until(button("과제 4 · 해시 테이블 구현", true), "tasks");
  },
  recordings: async () => {
    await click("내 과목");
    await click("자료구조", true);
    await click("녹화 강의");
    await until(button("7주차 1차시 · 힙과 우선순위 큐", true), "recordings");
  },
  materials: async () => {
    await click("내 과목");
    await click("자료구조", true);
    await click("강의 자료");
    await until(button("07_Heap.pdf", true), "materials");
  },
  captions: async () => {
    await click("자막 추출");
    await click("자막 감지");
    await click("AI 자막 만들기");
    await click("음성 보내기");
    await until(button("TXT 받기"), "captions");
  },
};
// Not awaited at top level: main.tsx, which renders the app, imports this file.
async function boot() {
  await steps[screen]();
  globalThis.document.activeElement?.blur();
  globalThis.scrollTo(0, 0);
  booted = true;
  lockNavigation();
  root.dataset.demo = "ready";
}
void boot();
