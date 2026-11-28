import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  captionPreparing,
  captionProgressItem,
  isProgressState,
  playbackProgressItem,
  progressActive,
  progressText,
  workProgressItems,
  type ProgressItem,
} from "../src/progress";
import { ProgressHub } from "../src/progress-hub";
import type { JobPhase } from "../src/captions/job-state";
import type { QueueWork, SingleWork } from "../src/captions/work-protocol";
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
    .toBe("대기열에 있어요");
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

const RUN = "00000000-0000-4000-8000-000000000001";
const BATCH = "00000000-0000-4000-8000-0000000000b1";
const single = (phase: SingleWork["phase"]): SingleWork => ({
  run: RUN,
  tabId: 3,
  documentId: null,
  phase,
  jobId: phase === "identifying" ? null : "job_1",
  key: null,
  errorCode: phase === "failed" ? "MEDIA_DENIED" : null,
  title: "3주차 강의",
  durationS: 60,
});
const queue = (running: boolean, phases: QueueWork["items"][number]["phase"][]): QueueWork => ({
  run: BATCH,
  tabId: 3,
  running,
  items: phases.map((phase, index) => ({
    handle: `00000000-0000-4000-8000-00000000000${index}`,
    title: `강의 ${index + 1}`,
    phase,
    errorCode: null,
    jobId: ["extracting", "uploading", "queued"].includes(phase) ? `job_q${index}` : null,
    key: null,
  })),
});
const preparing = (id: string, phase: JobPhase): ProgressItem => ({
  kind: "captions",
  id,
  phase,
  percent: null,
  workerOffline: false,
});

it("reports the lecture being prepared and a failed preparation, never a job the server accepted", () => {
  expect(workProgressItems({ single: null, queue: null })).toEqual([]);
  expect(workProgressItems({ single: single("identifying"), queue: null })).toEqual([
    preparing(RUN, "identifying"),
  ]);
  expect(workProgressItems({ single: single("uploading"), queue: null })).toEqual([
    preparing("job_1", "uploading"),
  ]);
  expect(workProgressItems({ single: single("failed"), queue: null })).toEqual([
    preparing("job_1", "failed"),
  ]);
  expect(workProgressItems({ single: single("queued"), queue: null })).toEqual([]);

  // A list shows one item for the lecture in hand; between lectures it is still preparing.
  expect(
    workProgressItems({ single: null, queue: queue(true, ["queued", "uploading", "waiting"]) }),
  ).toEqual([preparing("job_q1", "uploading")]);
  expect(workProgressItems({ single: null, queue: queue(true, ["queued", "opening"]) })).toEqual([
    preparing(BATCH, "identifying"),
  ]);
  expect(workProgressItems({ single: null, queue: queue(true, ["queued", "waiting"]) })).toEqual([
    preparing(BATCH, "identifying"),
  ]);
  expect(workProgressItems({ single: null, queue: queue(false, ["queued", "failed"]) })).toEqual([]);

  const items = workProgressItems({ single: single("extracting"), queue: null });
  expect(isProgressState({ version: 1, type: "PROGRESS_STATE", items })).toBe(true);
  expect(JSON.stringify(items)).not.toContain("3주차");
  expect(captionPreparing(items[0]!)).toBe(true);
  expect(captionPreparing(running)).toBe(false);
  expect(captionPreparing(playbackProgressItem(playback("playing"))!)).toBe(false);
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

const LMS = "https://mylms.korea.ac.kr/courses";
const NOTHING = { version: 1, type: "PROGRESS_STATE", items: [] };
const TOP = { frameId: 0 };
let tabs: { id: number; url: string; windowId: number }[];
let sendMessage: ReturnType<typeof vi.fn>;
let tabMessage: ReturnType<typeof vi.fn>;
let query: ReturnType<typeof vi.fn>;
let get: ReturnType<typeof vi.fn>;
beforeEach(() => {
  tabs = [{ id: 3, url: LMS, windowId: 1 }];
  sendMessage = vi.fn(async () => undefined);
  tabMessage = vi.fn(async () => undefined);
  query = vi.fn(async () => tabs);
  get = vi.fn(async (id: number) => {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) throw new Error("No tab");
    return tab;
  });
  vi.stubGlobal("chrome", {
    runtime: { sendMessage },
    tabs: { query, get, sendMessage: tabMessage },
  });
});
afterEach(() => vi.unstubAllGlobals());

/** Resolves after the hub acted on every tab lookup it has started. */
const delivered = () =>
  Promise.allSettled([...query.mock.results, ...get.mock.results].map((result) => result.value));
const twoWindows = () => {
  tabs = [
    { id: 3, url: LMS, windowId: 1 },
    { id: 4, url: LMS, windowId: 2 },
  ];
};

const snapshot = (phase: "uploading" | "queued" | "running" | "succeeded", done = 0) => ({
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

it("delivers a completed job recovered after a worker restart to existing LMS pages", async () => {
  const restarted = new ProgressHub();
  restarted.setCaptions([snapshot("succeeded")]);
  await delivered();
  expect(tabMessage.mock.calls).toEqual([[3, restarted.state(), TOP]]);
});

it("updates a newly loaded LMS page only while work is in progress", () => {
  const hub = new ProgressHub();
  hub.tabReady(5, "https://mylms.korea.ac.kr/", 1);
  expect(tabMessage).not.toHaveBeenCalled();
  hub.setCaptions([snapshot("queued")]);
  tabMessage.mockClear();
  hub.tabReady(5, "https://example.com/", 1);
  hub.tabReady(5, "https://mylms.korea.ac.kr/", 1);
  expect(tabMessage.mock.calls).toEqual([[5, hub.state(), { frameId: 0 }]]);
});

it("hides the pill only in the window whose panel is open and shows it again when that panel closes", async () => {
  twoWindows();
  const hub = new ProgressHub();
  hub.setCaptions([snapshot("running", 10)]);
  await delivered();
  expect(tabMessage.mock.calls.map(([id]) => id)).toEqual([3, 4]);

  tabMessage.mockClear();
  hub.setPanels(new Set([1]));
  await delivered();
  expect(tabMessage.mock.calls).toEqual([[3, NOTHING, TOP]]);

  tabMessage.mockClear();
  hub.setCaptions([snapshot("running", 20)]);
  await delivered();
  expect(tabMessage.mock.calls).toEqual([[4, hub.state(), TOP]]);
  expect(sendMessage).toHaveBeenLastCalledWith(hub.state());

  tabMessage.mockClear();
  hub.setPanels(new Set());
  await delivered();
  expect(tabMessage.mock.calls).toEqual([[3, hub.state(), TOP]]);
});

it("asks the LMS tabs nothing when a window's panel count changes without opening or closing it", async () => {
  twoWindows();
  const hub = new ProgressHub();
  hub.setCaptions([snapshot("running", 10)]);
  hub.setPanels(new Set([1]));
  await delivered();
  tabMessage.mockClear();
  query.mockClear();

  hub.setPanels(new Set([1]));
  expect(query).not.toHaveBeenCalled();

  hub.setPanels(new Set([1, 2]));
  await delivered();
  expect(tabMessage.mock.calls).toEqual([[4, NOTHING, TOP]]);
});

it("shows nothing after a panel closes when the work it covered already ended", async () => {
  twoWindows();
  const hub = new ProgressHub();
  hub.setCaptions([snapshot("running", 10)]);
  hub.setPanels(new Set([1]));
  hub.setCaptions([snapshot("succeeded")]);
  await delivered();
  tabMessage.mockClear();

  hub.setPanels(new Set());
  await delivered();
  expect(tabMessage).not.toHaveBeenCalled();
});

it("rebuilds from reconnecting panels after a worker restart", async () => {
  twoWindows();
  // The panel in window 1 reconnects before the restarted worker knows any work.
  const restarted = new ProgressHub();
  restarted.setPanels(new Set([1]));
  await delivered();
  expect(tabMessage.mock.calls).toEqual([[3, NOTHING, TOP]]);

  tabMessage.mockClear();
  restarted.setPlayback(playback("paused"));
  await delivered();
  expect(tabMessage.mock.calls).toEqual([[4, restarted.state(), TOP]]);

  // A panel that closed while the worker was stopped never reconnects.
  tabMessage.mockClear();
  const later = new ProgressHub();
  later.setPlayback(playback("paused"));
  await delivered();
  expect(tabMessage.mock.calls.map(([id]) => id)).toEqual([3, 4]);
});

it("ends with the pill shown when a panel opens and closes before the tabs are listed", async () => {
  const hub = new ProgressHub();
  hub.setCaptions([snapshot("running", 10)]);
  await delivered();
  tabMessage.mockClear();

  hub.setPanels(new Set([1]));
  hub.setPanels(new Set());
  await delivered();
  expect(tabMessage.mock.calls.length).toBeGreaterThan(0);
  for (const call of tabMessage.mock.calls) expect(call).toEqual([3, hub.state(), TOP]);
});

it("leaves a page loaded beside an open panel without a pill", () => {
  const hub = new ProgressHub();
  hub.setCaptions([snapshot("running", 10)]);
  hub.setPanels(new Set([1]));
  tabMessage.mockClear();
  hub.tabReady(5, LMS, 1);
  expect(tabMessage).not.toHaveBeenCalled();
  hub.tabReady(6, LMS, 2);
  expect(tabMessage.mock.calls).toEqual([[6, hub.state(), TOP]]);
});

it("moves an LMS tab's pill with the tab between windows", async () => {
  twoWindows();
  tabs.push({ id: 9, url: "https://example.com/", windowId: 1 });
  const hub = new ProgressHub();
  hub.setCaptions([snapshot("running", 10)]);
  hub.setPanels(new Set([1]));
  await delivered();
  tabMessage.mockClear();

  tabs[1]!.windowId = 1;
  hub.tabMoved(4, 1);
  await delivered();
  expect(tabMessage.mock.calls).toEqual([[4, NOTHING, TOP]]);

  tabMessage.mockClear();
  tabs[0]!.windowId = 2;
  hub.tabMoved(3, 2);
  hub.tabMoved(9, 1);
  hub.tabMoved(404, 1);
  await delivered();
  expect(tabMessage.mock.calls).toEqual([[3, hub.state(), TOP]]);
});

it("keeps the pill off a tab dragged into a panel's window after the tabs were listed", async () => {
  twoWindows();
  const hub = new ProgressHub();
  hub.setPanels(new Set([1]));
  await delivered();
  tabMessage.mockClear();
  let release!: () => void;
  query.mockImplementationOnce(() => {
    const listed = tabs.map((tab) => ({ ...tab }));
    return new Promise((resolve) => (release = () => resolve(listed)));
  });
  hub.setCaptions([snapshot("running", 10)]);

  tabs[1]!.windowId = 1;
  hub.tabMoved(4, 1);
  release();
  await delivered();
  expect(tabMessage.mock.calls).toEqual([[4, NOTHING, TOP]]);
});

it("keeps a running job listed when finished jobs and a failed preparation fill the list", () => {
  const hub = new ProgressHub();
  hub.setCaptions(
    Array.from({ length: 8 }, (_, index) => ({
      ...snapshot(index === 0 ? "running" : "succeeded", 10),
      jobId: `job_m${index}`,
    })),
  );
  hub.setWork({ single: single("failed"), queue: null });
  const items = hub.state().items;
  expect(items).toHaveLength(8);
  expect(items.filter(progressActive).map((item) => item.id)).toEqual(["job_m0"]);
  // The oldest finished job made room instead.
  expect(items.map((item) => item.id)).not.toContain("job_m1");
});

it("shows preparation on LMS pages with no panel open, because it goes on without one", async () => {
  twoWindows();
  const hub = new ProgressHub();
  hub.setWork({ single: single("uploading"), queue: null });
  hub.setWork({ single: single("uploading"), queue: null });
  await delivered();
  expect(hub.state().items).toEqual([preparing("job_1", "uploading")]);
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith(hub.state());
  expect(tabMessage.mock.calls).toEqual([
    [3, hub.state(), TOP],
    [4, hub.state(), TOP],
  ]);

  // A window's own panel shows it instead; closing that panel brings the pill back.
  tabMessage.mockClear();
  hub.setPanels(new Set([1]));
  await delivered();
  expect(tabMessage.mock.calls).toEqual([[3, NOTHING, TOP]]);
  tabMessage.mockClear();
  hub.setPanels(new Set());
  await delivered();
  expect(tabMessage.mock.calls).toEqual([[3, hub.state(), TOP]]);

  tabMessage.mockClear();
  hub.tabReady(5, LMS, 2);
  expect(tabMessage.mock.calls).toEqual([[5, hub.state(), TOP]]);

  // The run ended and was dismissed: the pages are told once, and then left alone.
  tabMessage.mockClear();
  hub.setWork({ single: null, queue: null });
  await delivered();
  expect(tabMessage.mock.calls).toEqual([
    [3, NOTHING, TOP],
    [4, NOTHING, TOP],
  ]);
});

it("lists a job once while the monitor and the preparation both still report it", () => {
  const hub = new ProgressHub();
  hub.setWork({ single: single("uploading"), queue: queue(true, ["waiting"]) });
  expect(hub.state().items).toEqual([
    preparing("job_1", "uploading"),
    preparing(BATCH, "identifying"),
  ]);
  hub.setCaptions([snapshot("queued")]);
  expect(hub.state().items).toEqual([
    { ...running, phase: "queued", percent: null },
    preparing(BATCH, "identifying"),
  ]);
  hub.setWork({ single: single("queued"), queue: null });
  expect(hub.state().items).toEqual([{ ...running, phase: "queued", percent: null }]);
});
