import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CaptionWorkError,
  acceptReply,
  captionWorkReply,
  errorCode,
  isCaptionRuleId,
  isCaptionWorkCommand,
  isCaptionWorkState,
  isOffscreenRequest,
  mediaReply,
  offscreenSender,
  openReply,
  preparingPhase,
  tokenReply,
  workBusy,
  workPortCommand,
  workPortMessage,
  type QueueWork,
  type SingleWork,
} from "../src/captions/work-protocol";

const run = "00000000-0000-4000-8000-000000000001";
const handle = "00000000-0000-4000-8000-0000000000a1";
const key = `unidock-${"a".repeat(40)}`;
const mediaUrl =
  "https://korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/0123456789abc/contents/media_files/screen.mp4";
const single: SingleWork = {
  run,
  tabId: 3,
  documentId: "DOC1",
  phase: "uploading",
  jobId: "job_1",
  key,
  errorCode: null,
  title: "3주차 강의",
  durationS: 60,
};
const queue: QueueWork = {
  run,
  tabId: 3,
  running: true,
  items: [{ handle, title: "강의", phase: "waiting", errorCode: null, jobId: null, key: null }],
};
const state = {
  version: 1,
  type: "CAPTION_WORK_STATE",
  instance: run,
  revision: 2,
  single,
  queue,
};
const grant = { id: "s".repeat(16), loginId: "l".repeat(16), accessToken: "t".repeat(32) };

beforeEach(() => {
  vi.stubGlobal("chrome", {
    runtime: { id: "ext", getURL: (path: string) => `chrome-extension://ext/${path}` },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("accepts only the extension's own offscreen document as that sender", () => {
  const url = "chrome-extension://ext/offscreen.html";
  expect(offscreenSender({ id: "ext", url })).toBe(true);
  expect(offscreenSender({ id: "other", url })).toBe(false);
  expect(offscreenSender({ id: "ext", url: "chrome-extension://ext/sidepanel.html" })).toBe(false);
  expect(offscreenSender({ id: "ext", url, tab: { id: 1 } as chrome.tabs.Tab })).toBe(false);
  expect(offscreenSender({ id: "ext" })).toBe(false);
});

it("reads the closed code of a typed error and nothing else", () => {
  expect(errorCode(new CaptionWorkError("UNSUPPORTED_MEDIA"))).toBe("UNSUPPORTED_MEDIA");
  expect(errorCode({ code: "https://example.com/secret" })).toBe("UNKNOWN");
  expect(errorCode({ code: 7 })).toBe("UNKNOWN");
  expect(errorCode(new Error("boom"))).toBe("UNKNOWN");
  expect(errorCode(null)).toBe("UNKNOWN");
});

it("calls work busy only while audio is being read or uploaded", () => {
  expect(preparingPhase("extracting")).toBe(true);
  expect(preparingPhase("queued")).toBe(false);
  expect(workBusy({ single, queue: null })).toBe(true);
  expect(workBusy({ single: { ...single, phase: "queued" }, queue: null })).toBe(false);
  expect(workBusy({ single: { ...single, phase: "failed" }, queue: null })).toBe(false);
  expect(workBusy({ single: null, queue })).toBe(true);
  expect(workBusy({ single: null, queue: { ...queue, running: false } })).toBe(false);
  expect(workBusy({ single: null, queue: null })).toBe(false);
});

it("accepts a well-formed state and rejects one with any field off", () => {
  expect(isCaptionWorkState(state)).toBe(true);
  expect(isCaptionWorkState({ ...state, single: null, queue: null })).toBe(true);
  for (const broken of [
    { ...state, extra: 1 },
    { ...state, version: 2 },
    { ...state, instance: "worker" },
    { ...state, revision: -1 },
    { ...state, revision: 1.5 },
    { ...state, single: { ...single, run: "x" } },
    { ...state, single: { ...single, tabId: -1 } },
    { ...state, single: { ...single, phase: "running" } },
    { ...state, single: { ...single, key: "unidock-short" } },
    { ...state, single: { ...single, errorCode: "https://example.com" } },
    { ...state, single: { ...single, title: "가".repeat(301) } },
    { ...state, single: { ...single, durationS: Number.NaN } },
    { ...state, single: { ...single, url: "https://example.com" } },
    { ...state, queue: { ...queue, items: [] } },
    { ...state, queue: { ...queue, running: "yes" } },
    { ...state, queue: { ...queue, items: [{ ...queue.items[0], phase: "running" }] } },
    { ...state, queue: { ...queue, items: [{ ...queue.items[0], handle: "x" }] } },
    null,
    "state",
    [],
  ])
    expect(isCaptionWorkState(broken), JSON.stringify(broken)).toBe(false);
});

it("accepts only the closed panel commands", () => {
  const start = { version: 1, type: "CAPTION_WORK_START", run, tabId: 3 };
  const items = [{ handle, title: "강의" }];
  for (const command of [
    { version: 1, type: "CAPTION_WORK_GET" },
    { ...start, kind: "single" },
    { ...start, kind: "queue", items },
    { version: 1, type: "CAPTION_WORK_CANCEL", kind: "single", run },
    { version: 1, type: "CAPTION_WORK_CANCEL", kind: "queue", run },
    { version: 1, type: "CAPTION_WORK_DISMISS", run },
  ])
    expect(isCaptionWorkCommand(command), JSON.stringify(command)).toBe(true);
  for (const command of [
    { version: 1, type: "CAPTION_WORK_GET", run },
    { version: 2, type: "CAPTION_WORK_GET" },
    { ...start, kind: "single", url: "https://example.com" },
    { ...start, kind: "single", run: "x" },
    { ...start, kind: "single", tabId: 1.5 },
    { ...start, kind: "queue" },
    { ...start, kind: "queue", items: [] },
    { ...start, kind: "queue", items: [...items, ...items] },
    { ...start, kind: "queue", items: [{ handle, title: "강의", url: "https://example.com" }] },
    { ...start, kind: "queue", items: [{ handle, title: "가".repeat(301) }] },
    { ...start, kind: "other" },
    { version: 1, type: "CAPTION_WORK_CANCEL", kind: "all", run },
    { version: 1, type: "CAPTION_WORK_DISMISS", run, kind: "queue" },
    { version: 1, type: "FETCH", run },
    null,
  ])
    expect(isCaptionWorkCommand(command), JSON.stringify(command)).toBe(false);
});

it("parses the worker's answer to a panel command", () => {
  expect(captionWorkReply({ status: "success", state, accepted: null })).toEqual({
    status: "success",
    state,
    accepted: null,
  });
  expect(captionWorkReply({ status: "success", state, accepted: "job_1" })?.status).toBe("success");
  expect(captionWorkReply({ status: "error", code: "UNAVAILABLE" })).toEqual({
    status: "error",
    code: "UNAVAILABLE",
  });
  expect(captionWorkReply({ status: "success", state, accepted: "a b" })).toBeNull();
  expect(captionWorkReply({ status: "success", state: { ...state, revision: -1 }, accepted: null })).toBeNull();
  expect(captionWorkReply({ status: "error", code: "not a code" })).toBeNull();
  expect(captionWorkReply(undefined)).toBeNull();
});

it("accepts only the closed requests of the offscreen document", () => {
  const token = { version: 1, type: "CAPTION_OFFSCREEN_TOKEN" };
  for (const request of [
    { version: 1, type: "CAPTION_OFFSCREEN_MEDIA", tabId: 3 },
    { version: 1, type: "CAPTION_OFFSCREEN_MEDIA", lectureOf: 3, after: null },
    { version: 1, type: "CAPTION_OFFSCREEN_MEDIA", lectureOf: 3, after: "DOC1" },
    { version: 1, type: "CAPTION_OFFSCREEN_OPEN", tabId: 3, batch: run, index: 0 },
    { version: 1, type: "CAPTION_OFFSCREEN_ACCEPT", jobId: "job_1", key },
    { ...token, action: "current" },
    { ...token, action: "refresh", session: grant.id, loginId: grant.loginId },
    { ...token, action: "reject", session: grant.id, loginId: grant.loginId },
  ])
    expect(isOffscreenRequest(request), JSON.stringify(request)).toBe(true);
  for (const request of [
    { version: 1, type: "CAPTION_OFFSCREEN_MEDIA", tabId: 3, url: mediaUrl },
    { version: 1, type: "CAPTION_OFFSCREEN_MEDIA", lectureOf: 3 },
    { version: 1, type: "CAPTION_OFFSCREEN_MEDIA", lectureOf: 3, after: "a b" },
    { version: 1, type: "CAPTION_OFFSCREEN_OPEN", tabId: 3, batch: run, index: 100 },
    { version: 1, type: "CAPTION_OFFSCREEN_OPEN", tabId: 3, batch: "x", index: 0 },
    { version: 1, type: "CAPTION_OFFSCREEN_ACCEPT", jobId: "job 1", key },
    { version: 1, type: "CAPTION_OFFSCREEN_ACCEPT", jobId: "job_1", key: "k" },
    { ...token, action: "current", loginId: grant.loginId },
    { ...token, action: "refresh", session: "short", loginId: grant.loginId },
    { ...token, action: "steal", session: grant.id, loginId: grant.loginId },
    { version: 1, type: "CAPTION_OFFSCREEN_FETCH", url: mediaUrl },
    { version: 2, type: "CAPTION_OFFSCREEN_MEDIA", tabId: 3 },
    undefined,
  ])
    expect(isOffscreenRequest(request), JSON.stringify(request)).toBe(false);
});

it("parses the worker's answers to the document, and only media on the lecture CDN", () => {
  const media = { mediaUrl, durationS: 60, key, title: "강의", tabId: 9, documentId: "DOC1" };
  expect(mediaReply({ status: "success", media })).toEqual({ status: "success", media });
  expect(mediaReply({ status: "pending" })).toEqual({ status: "pending" });
  expect(mediaReply({ status: "error", code: "ACTIVATE_TAB" })).toEqual({
    status: "error",
    code: "ACTIVATE_TAB",
  });
  expect(
    mediaReply({ status: "success", media: { ...media, mediaUrl: "https://evil.example.com/a.mp4" } }),
  ).toBeNull();
  expect(mediaReply({ status: "success", media: { ...media, contentId: "0123456789abc" } })).toBeNull();
  expect(mediaReply(null)).toBeNull();

  expect(openReply({ status: "success", previous: null })).toEqual({ status: "success", previous: null });
  expect(openReply({ status: "success", previous: "DOC1" })).toEqual({
    status: "success",
    previous: "DOC1",
  });
  expect(openReply({ status: "error", code: "RATE_LIMITED" })).toEqual({
    status: "error",
    code: "RATE_LIMITED",
  });
  expect(openReply({ status: "error", code: "SOMETHING_ELSE" })).toBeNull();
  expect(openReply({ status: "success", opened: true })).toBeNull();
  expect(openReply("opened")).toBeNull();

  expect(acceptReply({ status: "success" })).toEqual({ status: "success" });
  expect(acceptReply({ status: "error", code: "STORAGE" })).toEqual({ status: "error", code: "STORAGE" });
  expect(acceptReply({ status: "success", jobId: "job_1" })).toBeNull();
  expect(acceptReply(7)).toBeNull();
});

it("lets an access token through but never a whole session", () => {
  expect(tokenReply({ status: "success", grant })).toEqual({ status: "success", grant });
  expect(tokenReply({ status: "success", grant: null })).toEqual({ status: "success", grant: null });
  expect(tokenReply({ status: "error", code: "LOGIN_REQUIRED" })).toEqual({
    status: "error",
    code: "LOGIN_REQUIRED",
  });
  expect(
    tokenReply({ status: "success", grant: { ...grant, refreshToken: "r".repeat(32) } }),
  ).toBeNull();
  expect(tokenReply({ status: "success", grant: { ...grant, accessToken: "short" } })).toBeNull();
  expect(tokenReply([])).toBeNull();
});

it("parses what the document posts on its port", () => {
  expect(workPortMessage({ type: "alive" })).toEqual({ type: "alive" });
  expect(workPortMessage({ type: "work", single, queue, unfinished: ["job_1"] })).toEqual({
    type: "work",
    single,
    queue,
    unfinished: ["job_1"],
  });
  expect(workPortMessage({ type: "rule", id: 1947001, mediaUrl })).toEqual({
    type: "rule",
    id: 1947001,
    mediaUrl,
  });
  expect(workPortMessage({ type: "unrule", id: 1947001 })).toEqual({ type: "unrule", id: 1947001 });
  expect(workPortMessage({ type: "reply", id: 1, status: "success", accepted: null })).toEqual({
    type: "reply",
    id: 1,
    status: "success",
    accepted: null,
  });
  expect(workPortMessage({ type: "reply", id: 1, status: "error", code: "ACTIVE_JOB_EXISTS" })).toEqual({
    type: "reply",
    id: 1,
    status: "error",
    code: "ACTIVE_JOB_EXISTS",
  });
  for (const broken of [
    { type: "alive", extra: 1 },
    { type: "work", single, queue, unfinished: ["job 1"] },
    { type: "work", single: { ...single, phase: "done" }, queue, unfinished: [] },
    { type: "work", single, queue },
    { type: "rule", id: 7, mediaUrl },
    { type: "rule", id: 1947001, mediaUrl: "https://evil.example.com/a.mp4" },
    { type: "unrule", id: 1947001, mediaUrl },
    { type: "reply", id: -1, status: "success", accepted: null },
    { type: "reply", id: 1, status: "success" },
    { type: "reply", id: 1, status: "error", code: "bad code" },
    { type: "fetch", id: 1947001 },
    null,
  ])
    expect(workPortMessage(broken), JSON.stringify(broken)).toBeNull();
});

it("parses what the worker posts on the document's port", () => {
  const command = { version: 1, type: "CAPTION_WORK_CANCEL", kind: "single", run };
  expect(workPortCommand({ type: "ready" })).toEqual({ type: "ready" });
  expect(workPortCommand({ type: "session-ended" })).toEqual({ type: "session-ended" });
  expect(workPortCommand({ type: "rule", id: 1947001, ok: true })).toEqual({
    type: "rule",
    id: 1947001,
    ok: true,
  });
  expect(workPortCommand({ type: "unrule", id: 1947001 })).toEqual({ type: "unrule", id: 1947001 });
  expect(workPortCommand({ type: "command", id: 4, command })).toEqual({
    type: "command",
    id: 4,
    command,
  });
  for (const broken of [
    { type: "ready", extra: 1 },
    { type: "rule", id: 1947001, ok: "yes" },
    { type: "rule", id: 5, ok: true },
    // Reading the state is the worker's own business, never the document's.
    { type: "command", id: 4, command: { version: 1, type: "CAPTION_WORK_GET" } },
    { type: "command", id: 4 },
    { type: "command", id: "4", command },
    undefined,
  ])
    expect(workPortCommand(broken), JSON.stringify(broken)).toBeNull();
});

it("keeps caption rule ids in their own range", () => {
  expect(isCaptionRuleId(1_947_000)).toBe(true);
  expect(isCaptionRuleId(1_947_999)).toBe(true);
  expect(isCaptionRuleId(1_948_000)).toBe(false);
  expect(isCaptionRuleId(1_946_999)).toBe(false);
  expect(isCaptionRuleId(1_947_000.5)).toBe(false);
  expect(isCaptionRuleId("1947000")).toBe(false);
});
