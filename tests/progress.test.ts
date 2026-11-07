import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  captionProgressItem,
  isProgressState,
  playbackProgressItem,
  progressActive,
  progressText,
  type ProgressItem,
} from "../src/progress";
import { ProgressHub } from "../src/progress-hub";
import type { PlaybackSnapshot } from "../src/playback/bridge";

const KEY = `unidock-${"a".repeat(40)}`;
const running: ProgressItem = {
  kind: "captions",
  id: "job_1",
  phase: "running",
  percent: 42,
  workerOffline: false,
};
const playback = (status: PlaybackSnapshot["status"]): PlaybackSnapshot => ({
  courses: [],
  labels: { r1: "3주차 강의" },
  current: { id: "r1", courseId: "c1" },
  queue: [{ id: "r2", courseId: "c1" }],
  status,
});

it("describes caption and playback work in Korean with progress only while known", () => {
  expect(progressText(running)).toEqual({
    title: "AI 자막 만드는 중",
    detail: "42% 완료",
    tone: "run",
    percent: 42,
  });
  expect(progressText({ ...running, phase: "queued", percent: null, workerOffline: true })?.detail)
    .toBe("자막 서버가 연결되면 바로 시작해요");
  expect(progressText({ ...running, phase: "cancelled" })).toBeNull();
  const item = playbackProgressItem(playback("playing"))!;
  expect(progressText(item)?.detail).toBe("3주차 강의 · 남은 영상 1개");
  expect(playbackProgressItem(playback("idle"))).toBeNull();
  expect(progressActive(item)).toBe(true);
  expect(progressActive({ ...running, phase: "succeeded" })).toBe(false);
});

it("projects a worker snapshot without its lecture key", () => {
  const item = captionProgressItem({
    jobId: "job_1",
    key: KEY,
    phase: "running",
    serverProgress: { stage: "transcribing", done: 30, total: 60 },
    workerOffline: false,
    errorCode: null,
  });
  expect(item).toEqual({ ...running, percent: 50 });
  expect(JSON.stringify(item)).not.toContain(KEY);
});

it("accepts only exact progress states", () => {
  const state = { version: 1, type: "PROGRESS_STATE", items: [running] };
  expect(isProgressState(state)).toBe(true);
  expect(isProgressState({ ...state, extra: 1 })).toBe(false);
  expect(isProgressState({ ...state, items: [{ ...running, percent: 101 }] })).toBe(false);
  expect(isProgressState({ ...state, items: [{ ...running, url: "https://x" }] })).toBe(false);
  expect(
    isProgressState({
      ...state,
      items: [{ kind: "playback", id: "playback", status: "playing", title: "x".repeat(201), remaining: 0 }],
    }),
  ).toBe(false);
});

let tabs: { id: number; url: string }[];
let sendMessage: ReturnType<typeof vi.fn>;
let tabMessage: ReturnType<typeof vi.fn>;
beforeEach(() => {
  tabs = [{ id: 3, url: "https://mylms.korea.ac.kr/courses" }];
  sendMessage = vi.fn(async () => undefined);
  tabMessage = vi.fn(async () => undefined);
  vi.stubGlobal("chrome", {
    runtime: { sendMessage },
    tabs: { query: vi.fn(async () => tabs), sendMessage: tabMessage },
  });
});
afterEach(() => vi.unstubAllGlobals());

const snapshot = (phase: "queued" | "running" | "succeeded", done = 0) => ({
  jobId: "job_1",
  key: KEY,
  phase,
  serverProgress: phase === "running" ? { stage: "transcribing" as const, done, total: 100 } : null,
  workerOffline: false,
  errorCode: null,
});

it("sends each change once and leaves LMS tabs alone when nothing was in progress", async () => {
  const hub = new ProgressHub();
  hub.setPlayback(null);
  await Promise.resolve();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(tabMessage).not.toHaveBeenCalled();
  hub.setCaptions([snapshot("running", 10)]);
  hub.setCaptions([snapshot("running", 10)]);
  await vi.waitFor(() => expect(tabMessage).toHaveBeenCalledTimes(1));
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(tabMessage).toHaveBeenCalledWith(3, hub.state(), { frameId: 0 });
  hub.setCaptions([snapshot("succeeded")]);
  await vi.waitFor(() => expect(tabMessage).toHaveBeenCalledTimes(2));
  hub.setCaptions([]);
  await Promise.resolve();
  await Promise.resolve();
  expect(tabMessage).toHaveBeenCalledTimes(2);
  expect(sendMessage).toHaveBeenCalledTimes(3);
});

it("updates a newly loaded LMS page only while work is in progress", () => {
  const hub = new ProgressHub();
  hub.tabReady(5, "https://mylms.korea.ac.kr/");
  expect(tabMessage).not.toHaveBeenCalled();
  hub.setCaptions([snapshot("queued")]);
  tabMessage.mockClear();
  hub.tabReady(5, "https://example.com/");
  hub.tabReady(5, "https://mylms.korea.ac.kr/");
  expect(tabMessage.mock.calls).toEqual([[5, hub.state(), { frameId: 0 }]]);
});
