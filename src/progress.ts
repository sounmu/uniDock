import type { JobProgress } from "./captions/job-client";
import type { CaptionJobSnapshot } from "./captions/job-monitor";
import type { JobPhase } from "./captions/job-state";
import type { PlaybackSnapshot, RuntimeStatus } from "./playback/bridge";

/**
 * Long-running work shown outside its own panel screen: on LMS pages as a
 * toast and in the panel rail. Items carry no URL, LMS id or account data;
 * a playback title is the LMS's own label, shown back on the LMS.
 */
export type ProgressItem =
  | {
      readonly kind: "captions";
      readonly id: string;
      readonly phase: JobPhase;
      readonly percent: number | null;
      readonly workerOffline: boolean;
    }
  | {
      readonly kind: "playback";
      readonly id: "playback";
      readonly status: RuntimeStatus;
      readonly title: string;
      readonly remaining: number;
    };

export interface ProgressState {
  readonly version: 1;
  readonly type: "PROGRESS_STATE";
  readonly items: readonly ProgressItem[];
}

export const PROGRESS_GET = { version: 1, type: "PROGRESS_GET" } as const;
const MAX_ITEMS = 9;
const MAX_TITLE = 200;

export function captionPercent(progress: JobProgress | null | undefined): number | null {
  if (!progress?.total || progress.done === undefined) return null;
  return Math.min(99, Math.floor((progress.done / progress.total) * 100));
}

export function captionProgressItem(snapshot: CaptionJobSnapshot): ProgressItem {
  return {
    kind: "captions",
    id: snapshot.jobId,
    phase: snapshot.phase,
    percent: snapshot.phase === "running" ? captionPercent(snapshot.serverProgress) : null,
    workerOffline: snapshot.workerOffline,
  };
}

export function playbackProgressItem(snapshot: PlaybackSnapshot): ProgressItem | null {
  if (snapshot.status === "idle" || snapshot.status === "stopped") return null;
  const current = snapshot.current;
  return {
    kind: "playback",
    id: "playback",
    status: snapshot.status,
    title: (current ? snapshot.labels[current.id] ?? "" : "").slice(0, MAX_TITLE),
    remaining: snapshot.queue.length,
  };
}

/** Still in progress, or waiting on the user; finished and failed items are not. */
export function progressActive(item: ProgressItem): boolean {
  if (item.kind === "captions")
    return !["idle", "succeeded", "failed", "cancelled"].includes(item.phase);
  return item.status !== "failed";
}

export type ProgressTone = "run" | "wait" | "done" | "error";

export interface ProgressText {
  readonly title: string;
  readonly detail: string;
  readonly tone: ProgressTone;
  readonly percent: number | null;
}

const captionText: Partial<Record<JobPhase, readonly [string, string, ProgressTone]>> = {
  identifying: ["AI 자막 준비 중", "강의 영상을 확인하고 있어요", "run"],
  extracting: ["AI 자막 준비 중", "강의 음성을 분리하고 있어요", "run"],
  uploading: ["AI 자막 준비 중", "음성을 보내고 있어요", "run"],
  queued: ["AI 자막 대기 중", "처리 순서를 기다리고 있어요", "wait"],
  running: ["AI 자막 만드는 중", "자막을 만들고 있어요", "run"],
  succeeded: ["AI 자막이 준비됐어요", "패널의 자막 추출에서 볼 수 있어요", "done"],
  failed: ["AI 자막을 만들지 못했어요", "패널의 자막 추출에서 다시 시도하세요", "error"],
};

const playbackText: Partial<Record<RuntimeStatus, readonly [string, string | null, ProgressTone]>> = {
  starting: ["자동 재생 준비 중", null, "run"],
  playing: ["자동 재생 중", null, "run"],
  paused: ["자동 재생 일시정지", null, "wait"],
  "blocked-login": ["자동 재생 멈춤", "LMS에 다시 로그인하세요", "error"],
  "blocked-autoplay": ["자동 재생 멈춤", "플레이어 탭에서 재생 버튼을 눌러 주세요", "error"],
  failed: ["자동 재생 멈춤", "패널의 자동 재생에서 다시 시작하세요", "error"],
};

export function progressText(item: ProgressItem): ProgressText | null {
  if (item.kind === "captions") {
    const text = captionText[item.phase];
    if (!text) return null;
    const [title, detail, tone] = text;
    if (item.phase === "queued" && item.workerOffline)
      return { title, detail: "자막 서버가 연결되면 바로 시작해요", tone, percent: null };
    if (item.phase === "running" && item.percent !== null)
      return { title, detail: `${item.percent}% 완료`, tone, percent: item.percent };
    return { title, detail, tone, percent: null };
  }
  const text = playbackText[item.status];
  if (!text) return null;
  const [title, detail, tone] = text;
  const remaining = item.remaining > 0 ? `남은 영상 ${item.remaining}개` : "";
  return {
    title,
    detail: detail ?? [item.title, remaining].filter(Boolean).join(" · "),
    tone,
    percent: null,
  };
}

const JOB_PHASES: readonly JobPhase[] = [
  "idle",
  "identifying",
  "extracting",
  "uploading",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];
const RUNTIME_STATUSES: readonly RuntimeStatus[] = [
  "idle",
  "starting",
  "playing",
  "paused",
  "stopped",
  "blocked-login",
  "blocked-autoplay",
  "failed",
];

function progressItem(value: unknown): value is ProgressItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "captions")
    return (
      Object.keys(v).length === 5 &&
      typeof v.id === "string" &&
      /^[\w-]{1,128}$/.test(v.id) &&
      JOB_PHASES.includes(v.phase as JobPhase) &&
      (v.percent === null ||
        (Number.isInteger(v.percent) && (v.percent as number) >= 0 && (v.percent as number) <= 100)) &&
      typeof v.workerOffline === "boolean"
    );
  return (
    v.kind === "playback" &&
    Object.keys(v).length === 5 &&
    v.id === "playback" &&
    RUNTIME_STATUSES.includes(v.status as RuntimeStatus) &&
    typeof v.title === "string" &&
    v.title.length <= MAX_TITLE &&
    Number.isSafeInteger(v.remaining) &&
    (v.remaining as number) >= 0
  );
}

export function isProgressState(value: unknown): value is ProgressState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 3 &&
    v.version === 1 &&
    v.type === "PROGRESS_STATE" &&
    Array.isArray(v.items) &&
    v.items.length <= MAX_ITEMS &&
    v.items.every(progressItem)
  );
}
