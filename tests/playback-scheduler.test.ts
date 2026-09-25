import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAYBACK_SETTINGS,
  initialPlaybackState,
  planPlayback,
  transitionPlayback,
  type PlaybackCandidate,
  type PlaybackSettings,
} from "../src/playback/scheduler";

const at = (iso: string) => Date.parse(iso);
const now = at("2026-09-25T00:00:00Z"); // 09:00 Seoul
const settings: PlaybackSettings = {
  ...DEFAULT_PLAYBACK_SETTINGS,
  enabled: true,
  courseIds: ["course-a"],
};
const candidate = (
  id: string,
  deadline: string | null,
  overrides: Partial<PlaybackCandidate> = {},
): PlaybackCandidate => ({
  id,
  courseId: "course-a",
  deadline,
  durationMinutes: 60,
  completion: "incomplete",
  ...overrides,
});
const plan = (items: PlaybackCandidate[], clock = now, options = settings) =>
  planPlayback(items, options, clock);

describe("opt-in scheduling", () => {
  it("defaults to off, requires course opt-in, and never guesses unknown metadata or a date-only instant", () => {
    expect(DEFAULT_PLAYBACK_SETTINGS).toMatchObject({
      enabled: false,
      windowStartHour: 9,
      windowEndHour: 22,
      leadHours: 24,
      marginMinutes: 5,
    });
    const ready = candidate("ready", "2026-09-27T12:00:00+09:00");
    expect(
      plan([ready], now, DEFAULT_PLAYBACK_SETTINGS).blocked[0]?.reason,
    ).toBe("disabled");
    expect(
      plan([ready], now, { ...settings, courseIds: [] }).blocked[0]?.reason,
    ).toBe("course_not_opted_in");
    const result = plan([
      candidate("date-only", "2026-09-27"),
      candidate("no-date", null),
      candidate("invalid-date", "2026-02-30T12:00:00+09:00"),
      candidate("no-duration", ready.deadline, { durationMinutes: null }),
      candidate("no-completion", ready.deadline, { completion: "unknown" }),
      candidate("complete", ready.deadline, { completion: "complete" }),
    ]);
    expect(result.queue).toEqual([]);
    expect(
      result.blocked.map(
        ({ requiresManualConfirmation }) => requiresManualConfirmation,
      ),
    ).toEqual([true, true, true, true, true, false]);
    expect(result.blocked.map(({ id, reason }) => [id, reason])).toEqual([
      ["date-only", "date_only_deadline"],
      ["no-date", "unknown_deadline"],
      ["invalid-date", "invalid_deadline"],
      ["no-duration", "unknown_duration"],
      ["no-completion", "unknown_completion"],
      ["complete", "complete"],
    ]);
  });

  it("sorts equal deadlines stably and reserves non-overlapping duration plus five minutes", () => {
    const result = plan([
      candidate("later", "2026-09-28T20:00:00+09:00"),
      candidate("first", "2026-09-28T18:00:00+09:00"),
      candidate("second", "2026-09-28T18:00:00+09:00"),
    ]);
    expect(result.queue.map(({ id }) => id)).toEqual([
      "first",
      "second",
      "later",
    ]);
    expect(result.queue.map(({ margin }) => margin)).toEqual([
      "full",
      "reduced",
      "reduced",
    ]);
    expect(result.queue[1]!.startAt).toBeGreaterThanOrEqual(
      result.queue[0]!.finishAt + 5 * 60_000,
    );
    expect(result.queue[0]!.finishAt - result.queue[0]!.startAt).toBe(
      60 * 60_000,
    );
    expect(result.queue[0]!.startAt).toBe(at("2026-09-27T07:55:00Z")); // 16:55 Seoul, one day before deadline
  });

  it("keeps the whole playback inside 09:00-22:00 Seoul and moves to the next window", () => {
    const result = plan(
      [candidate("night", "2026-09-27T12:00:00Z", { durationMinutes: 180 })],
      at("2026-09-26T12:00:00Z"),
    );
    expect(result.queue[0]).toMatchObject({
      startAt: at("2026-09-27T00:00:00Z"),
      finishAt: at("2026-09-27T03:00:00Z"),
      margin: "reduced",
    });
    expect(result.blocked).toEqual([]);
  });

  it("distinguishes lost lead/margin from infeasible and supports configurable lead/window", () => {
    const deadline = "2026-09-26T12:00:00+09:00";
    expect(
      plan([candidate("reduced", deadline)], at("2026-09-25T02:00:00Z"))
        .queue[0]?.margin,
    ).toBe("reduced");
    const impossible = plan([
      candidate("long", deadline, { durationMinutes: 14 * 60 }),
    ]);
    expect(impossible.blocked[0]?.reason).toBe("infeasible");
    expect(
      plan([candidate("late", "2026-09-24T22:00:00+09:00")]).blocked[0]?.reason,
    ).toBe("missed_deadline");
    const custom = plan(
      [candidate("custom", "2026-09-27T19:00:00+09:00")],
      now,
      {
        ...settings,
        leadHours: 3,
        windowStartHour: 10,
        windowEndHour: 18,
      },
    );
    expect(custom.queue[0]?.startAt).toBe(at("2026-09-27T05:55:00Z")); // 14:55 Seoul
  });

  it("replans missed slots and changed deadlines against the supplied clock", () => {
    const first = candidate("a", "2026-09-27T18:00:00+09:00");
    const original = plan([first]);
    const changed = plan([candidate("a", "2026-09-28T18:00:00+09:00")]);
    expect(changed.queue[0]!.startAt - original.queue[0]!.startAt).toBe(
      24 * 60 * 60_000,
    );
    const missed = plan([first], at("2026-09-27T08:30:00Z")); // 17:30 Seoul, too little time left
    expect(missed.blocked[0]?.reason).toBe("infeasible");
    expect(missed.queue).toEqual([]);
  });
});

describe("account-scoped playback state", () => {
  const queue = plan([
    candidate("a", "2026-09-27T18:00:00+09:00"),
    candidate("b", "2026-09-28T18:00:00+09:00"),
  ]);
  const event = <T extends Parameters<typeof transitionPlayback>[1]>(
    state: ReturnType<typeof initialPlaybackState>,
    action: T,
  ) => transitionPlayback(state, action);

  it("has one active entry; only a matching native ended event advances, not failures, pause, or credit", () => {
    let state = event(initialPlaybackState("account-1"), {
      accountKey: "account-1",
      type: "replan",
      plan: queue,
    });
    expect([
      state.active?.id,
      state.pending.map((item) => item.id),
      state.status,
    ]).toEqual(["a", ["b"], "scheduled"]);
    expect(
      event(state, { accountKey: "account-2", type: "start", id: "a" }),
    ).toBe(state);
    state = event(state, { accountKey: "account-1", type: "start", id: "a" });
    expect(
      event(state, { accountKey: "account-1", type: "nativeEnded", id: "b" }),
    ).toBe(state);
    expect(
      event(state, { accountKey: "account-1", type: "nativeEnded", id: "a" }),
    ).toBe(state);
    state = event(state, { accountKey: "account-1", type: "playing", id: "a" });
    state = event(state, {
      accountKey: "account-1",
      type: "credit",
      id: "a",
      value: "credited",
    });
    expect(state.active?.id).toBe("a");
    state = event(state, { accountKey: "account-1", type: "pause", id: "a" });
    expect(state.status).toBe("paused");
    expect(
      event(state, { accountKey: "account-1", type: "nativeEnded", id: "a" }),
    ).toBe(state);
    state = event(state, { accountKey: "account-1", type: "resume", id: "a" });
    state = event(state, {
      accountKey: "account-1",
      type: "nativeEnded",
      id: "a",
    });
    expect([state.active?.id, state.status, state.credit.a]).toEqual([
      "b",
      "scheduled",
      "credited",
    ]);
    state = event(state, { accountKey: "account-1", type: "start", id: "b" });
    state = event(state, { accountKey: "account-1", type: "fail", id: "b" });
    expect(state.active?.id).toBe("b");
    expect(state.status).toBe("failed");
  });

  it.each(["stop", "cancel"] as const)(
    "%s clears the queue and cannot replay through replan or stale ended",
    (type) => {
      let state = event(initialPlaybackState("account-1"), {
        accountKey: "account-1",
        type: "replan",
        plan: queue,
      });
      state = event(state, { accountKey: "account-1", type, id: "a" });
      expect(state.excludedIds).toEqual(["a", "b"]);
      expect(state.active).toBeNull();
      expect(state.pending).toEqual([]);
      expect(
        event(state, { accountKey: "account-1", type: "replan", plan: queue }),
      ).toBe(state);
      expect(
        event(state, { accountKey: "account-1", type: "nativeEnded", id: "a" }),
      ).toBe(state);
    },
  );

  it("replans queued slots, retains playing media, and never replays completed media", () => {
    let state = event(initialPlaybackState("account-1"), {
      accountKey: "account-1",
      type: "replan",
      plan: queue,
    });
    const moved = plan([
      candidate("a", "2026-09-29T18:00:00+09:00"),
      candidate("b", "2026-09-27T18:00:00+09:00"),
    ]);
    state = event(state, {
      accountKey: "account-1",
      type: "replan",
      plan: moved,
    });
    expect(state.active?.id).toBe("b");
    state = event(state, { accountKey: "account-1", type: "start", id: "b" });
    state = event(state, { accountKey: "account-1", type: "playing", id: "b" });
    state = event(state, {
      accountKey: "account-1",
      type: "replan",
      plan: queue,
    });
    expect(state.active?.id).toBe("b");
    expect(state.pending.map((item) => item.id)).toEqual(["a"]);
    state = event(state, {
      accountKey: "account-1",
      type: "nativeEnded",
      id: "b",
    });
    state = event(state, {
      accountKey: "account-1",
      type: "replan",
      plan: moved,
    });
    expect(state.active?.id).toBe("a");
    expect(state.pending).toEqual([]);
  });
});
