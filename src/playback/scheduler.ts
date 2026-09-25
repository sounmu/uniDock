import { isoTime } from "../domain-items";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SEOUL_OFFSET = 9 * HOUR;

export interface PlaybackSettings {
  enabled: boolean;
  courseIds: readonly string[];
  windowStartHour: number;
  windowEndHour: number;
  leadHours: number;
  marginMinutes: number;
}

export const DEFAULT_PLAYBACK_SETTINGS: PlaybackSettings = {
  enabled: false,
  courseIds: [],
  windowStartHour: 9,
  windowEndHour: 22,
  leadHours: 24,
  marginMinutes: 5,
};

export interface PlaybackCandidate {
  id: string;
  courseId: string;
  title?: string;
  deadline: string | null;
  durationMinutes: number | null;
  completion: "incomplete" | "complete" | "unknown";
}

export interface ScheduledPlayback {
  id: string;
  courseId: string;
  deadline: number;
  startAt: number;
  finishAt: number;
  margin: "full" | "reduced";
}

export type BlockReason =
  | "disabled"
  | "course_not_opted_in"
  | "unknown_deadline"
  | "date_only_deadline"
  | "invalid_deadline"
  | "unknown_duration"
  | "unknown_completion"
  | "complete"
  | "missed_deadline"
  | "infeasible";

export interface BlockedPlayback {
  id: string;
  courseId: string;
  reason: BlockReason;
  requiresManualConfirmation: boolean;
}

export interface PlaybackPlan {
  queue: ScheduledPlayback[];
  blocked: BlockedPlayback[];
}

// Only an explicitly zoned instant is schedulable; a calendar day is not midnight.
const zonedDateTime =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

function nextWindowStart(
  earliest: number,
  duration: number,
  settings: PlaybackSettings,
): number | null {
  const span = (settings.windowEndHour - settings.windowStartHour) * HOUR;
  if (duration > span) return null;
  const day = Math.floor((earliest + SEOUL_OFFSET) / DAY);
  const opening = day * DAY - SEOUL_OFFSET + settings.windowStartHour * HOUR;
  const closing = day * DAY - SEOUL_OFFSET + settings.windowEndHour * HOUR;
  const start = Math.max(earliest, opening);
  return start + duration <= closing ? start : opening + DAY;
}

export function planPlayback(
  candidates: readonly PlaybackCandidate[],
  settings: PlaybackSettings,
  now: number,
): PlaybackPlan {
  const queue: ScheduledPlayback[] = [];
  const blocked: BlockedPlayback[] = [];
  const eligible: {
    candidate: PlaybackCandidate;
    deadline: number;
    duration: number;
    index: number;
  }[] = [];
  candidates.forEach((candidate, index) => {
    let reason: BlockReason | undefined;
    let deadline = NaN;
    if (!settings.enabled) reason = "disabled";
    else if (!settings.courseIds.includes(candidate.courseId))
      reason = "course_not_opted_in";
    else if (candidate.completion === "unknown") reason = "unknown_completion";
    else if (candidate.completion === "complete") reason = "complete";
    else if (!candidate.deadline) reason = "unknown_deadline";
    else if (dateOnly.test(candidate.deadline)) reason = "date_only_deadline";
    else if (
      !zonedDateTime.test(candidate.deadline) ||
      !Number.isFinite((deadline = isoTime(candidate.deadline)))
    )
      reason = "invalid_deadline";
    else if (
      candidate.durationMinutes === null ||
      !Number.isFinite(candidate.durationMinutes) ||
      candidate.durationMinutes <= 0
    )
      reason = "unknown_duration";
    else if (deadline <= now) reason = "missed_deadline";
    if (reason)
      blocked.push({
        id: candidate.id,
        courseId: candidate.courseId,
        reason,
        requiresManualConfirmation: [
          "unknown_deadline",
          "date_only_deadline",
          "invalid_deadline",
          "unknown_duration",
          "unknown_completion",
        ].includes(reason),
      });
    else
      eligible.push({
        candidate,
        deadline,
        duration: candidate.durationMinutes! * MINUTE,
        index,
      });
  });
  eligible.sort((a, b) => a.deadline - b.deadline || a.index - b.index);
  let cursor = now;
  for (const { candidate, deadline, duration } of eligible) {
    const target = deadline - settings.leadHours * HOUR;
    const margin = settings.marginMinutes * MINUTE;
    const preferred = target - duration - margin;
    const fullStart = nextWindowStart(
      Math.max(cursor, preferred),
      duration + margin,
      settings,
    );
    const full = fullStart !== null && fullStart + duration + margin <= target;
    const startAt = full
      ? fullStart
      : nextWindowStart(Math.max(cursor, preferred), duration, settings);
    if (startAt === null || startAt + duration > deadline) {
      blocked.push({
        id: candidate.id,
        courseId: candidate.courseId,
        reason: "infeasible",
        requiresManualConfirmation: false,
      });
      continue;
    }
    const finishAt = startAt + duration;
    queue.push({
      id: candidate.id,
      courseId: candidate.courseId,
      deadline,
      startAt,
      finishAt,
      margin: full ? "full" : "reduced",
    });
    cursor = finishAt + (full ? margin : 0);
  }
  return { queue, blocked };
}

export type LmsCredit = "unknown" | "credited" | "not_credited";
export type PlaybackStatus =
  | "idle"
  | "scheduled"
  | "starting"
  | "playing"
  | "paused"
  | "failed"
  | "stopped"
  | "cancelled";

export interface PlaybackState {
  accountKey: string;
  status: PlaybackStatus;
  active: ScheduledPlayback | null;
  pending: ScheduledPlayback[];
  finishedIds: string[];
  excludedIds: string[];
  credit: Record<string, LmsCredit>;
}

export type PlaybackEvent = { accountKey: string } & (
  | { type: "replan"; plan: PlaybackPlan }
  | {
      type:
        | "start"
        | "playing"
        | "pause"
        | "resume"
        | "nativeEnded"
        | "fail"
        | "stop"
        | "cancel";
      id: string;
    }
  | { type: "credit"; id: string; value: LmsCredit }
);

export function initialPlaybackState(accountKey: string): PlaybackState {
  return {
    accountKey,
    status: "idle",
    active: null,
    pending: [],
    finishedIds: [],
    excludedIds: [],
    credit: {},
  };
}

export function transitionPlayback(
  state: PlaybackState,
  event: PlaybackEvent,
): PlaybackState {
  if (event.accountKey !== state.accountKey) return state;
  if (event.type === "credit")
    return { ...state, credit: { ...state.credit, [event.id]: event.value } };
  if (event.type === "replan") {
    if (state.status === "stopped" || state.status === "cancelled")
      return state;
    const eligible = event.plan.queue.filter(
      (item) =>
        !state.finishedIds.includes(item.id) &&
        !state.excludedIds.includes(item.id),
    );
    const inProgress = ["starting", "playing", "paused", "failed"].includes(
      state.status,
    );
    const active = inProgress ? state.active : (eligible[0] ?? null);
    const pending = eligible.filter((item) => item.id !== active?.id);
    return {
      ...state,
      active,
      pending,
      status: inProgress ? state.status : active ? "scheduled" : "idle",
    };
  }
  if (!state.active || event.id !== state.active.id) return state;
  switch (event.type) {
    case "start":
      return state.status === "scheduled"
        ? { ...state, status: "starting" }
        : state;
    case "playing":
      return state.status === "starting"
        ? { ...state, status: "playing" }
        : state;
    case "pause":
      return state.status === "playing"
        ? { ...state, status: "paused" }
        : state;
    case "resume":
      return state.status === "paused"
        ? { ...state, status: "playing" }
        : state;
    case "fail":
      return ["starting", "playing", "paused"].includes(state.status)
        ? { ...state, status: "failed" }
        : state;
    case "nativeEnded": {
      if (state.status !== "playing") return state;
      const [next, ...pending] = state.pending;
      return {
        ...state,
        finishedIds: [...state.finishedIds, event.id],
        active: next ?? null,
        pending,
        status: next ? "scheduled" : "idle",
      };
    }
    case "stop":
    case "cancel":
      return {
        ...state,
        excludedIds: [
          ...state.excludedIds,
          event.id,
          ...state.pending.map((item) => item.id),
        ],
        active: null,
        pending: [],
        status: event.type === "stop" ? "stopped" : "cancelled",
      };
  }
}
