import { describe, expect, it } from "vitest";
import {
  PlaybackRuntime,
  PlaybackRuntimeError,
  PLAYBACK_ALARM,
  PLAYBACK_WATCHDOG,
  PLAYBACK_RETENTION,
  type RuntimePorts,
  type PlayerAddress,
} from "../src/playback/runtime";
import {
  emptyPlayback,
  parseStoredPlayback,
  type StoredPlayback,
} from "../src/playback/storage";
import {
  isPlaybackCommand,
  isDiscovery,
  playerPage,
  type PlaybackDiscovery,
  type PlaybackResult,
} from "../src/playback/bridge";
import { DEFAULT_PLAYBACK_SETTINGS } from "../src/playback/scheduler";

const base = Date.parse("2026-09-25T00:00:00Z");
const accountKey = "a".repeat(64),
  origin = "https://mylms.korea.ac.kr";
const address: PlayerAddress = {
  tabId: 9,
  frameId: 2,
  documentId: "native-document",
};
const settings = {
  ...DEFAULT_PLAYBACK_SETTINGS,
  enabled: true,
  courseIds: ["101"],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function snapshot(result: PlaybackResult) {
  if (result.status !== "success") throw new Error(result.code);
  return result.snapshot;
}
function fixture(onClose?: (runtime: PlaybackRuntime, tabId: number) => void) {
  let persisted: StoredPlayback | null = null,
    now = base,
    nextUuid = 0;
  let discovery: PlaybackDiscovery = {
    accountKey,
    origin,
    courses: [{ id: "101", name: "Course" }],
    candidates: [
      {
        id: "101:501",
        courseId: "101",
        deadline: new Date(base + 3600000).toISOString(),
        durationMinutes: 10,
        completion: "incomplete",
      },
      {
        id: "101:502",
        courseId: "101",
        deadline: new Date(base + 7200000).toISOString(),
        durationMinutes: 10,
        completion: "incomplete",
      },
    ],
  };
  const opened: string[] = [],
    closed: number[] = [],
    controls: string[] = [],
    alarms = new Map<string, number>();
  let read: (() => Promise<PlaybackDiscovery>) | undefined;
  let failSave = false,
    failControl = false,
    clears = 0;
  const ports: RuntimePorts = {
    now: () => now,
    uuid: () =>
      `00000000-0000-4000-8000-${String(++nextUuid).padStart(12, "0")}`,
    store: {
      load: async () => (persisted ? structuredClone(persisted) : null),
      save: async (state) => {
        if (failSave && state.player) throw new Error("quota");
        persisted = structuredClone(state);
      },
      clear: async () => {
        persisted = null;
        clears++;
      },
      erase: async () => {
        persisted = null;
        clears++;
      },
    },
    discover: async () => (read ? read() : discovery),
    resolve: async () => ({ discovery, id: "101:501", courseId: "101" }),
    open: async (url) => {
      opened.push(url);
      return 9;
    },
    navigate: async (id, url) => {
      expect(persisted?.player?.tabId).toBe(id);
      expect(url).toBe(`${origin}/courses/101/modules/items/501`);
    },
    close: async (id) => {
      closed.push(id);
      onClose?.(runtime, id);
    },
    control: async (_address, _binding, action) => {
      if (failControl) throw new PlaybackRuntimeError("PLAYER_LOST");
      controls.push(action);
    },
    alarm: async (name, when) => {
      if (when === null) alarms.delete(name);
      else alarms.set(name, when);
    },
  };
  const runtime = new PlaybackRuntime(ports);
  return {
    runtime,
    ports,
    opened,
    closed,
    controls,
    alarms,
    get saved() {
      return persisted;
    },
    get clears() {
      return clears;
    },
    get discovery() {
      return discovery;
    },
    set discovery(value: PlaybackDiscovery) {
      discovery = value;
    },
    set now(value: number) {
      now = value;
    },
    set read(value: (() => Promise<PlaybackDiscovery>) | undefined) {
      read = value;
    },
    set failSave(value: boolean) {
      failSave = value;
    },
    set failControl(value: boolean) {
      failControl = value;
    },
  };
}
async function enabled(f: ReturnType<typeof fixture>) {
  snapshot(
    await f.runtime.command({
      version: 1,
      type: "PLAYBACK_CONFIGURE",
      settings,
    }),
  );
}
async function playing(f: ReturnType<typeof fixture>) {
  await enabled(f);
  f.now = base + 1000;
  snapshot(await f.runtime.alarm(PLAYBACK_ALARM));
  const authorization = await f.runtime.authorize(address);
  if (!authorization) throw new Error("not authorized");
  await f.runtime.signal(address, authorization.binding, "playing");
  return authorization;
}

describe("background-owned playback", () => {
  it("keeps default opt-in disabled and unknown provider metadata blocked", async () => {
    const f = fixture();
    f.discovery = {
      ...f.discovery,
      candidates: [
        {
          id: "101:501",
          courseId: "101",
          durationMinutes: null,
          completion: "unknown",
          deadline: null,
        },
      ],
    };
    expect(snapshot(await f.runtime.startup()).settings.enabled).toBe(false);
    const result = snapshot(
      await f.runtime.command({
        version: 1,
        type: "PLAYBACK_CONFIGURE",
        settings,
      }),
    );
    expect(result.status).toBe("confirmation-required");
    expect(result.queue).toEqual([]);
    expect(f.opened).toEqual([]);
  });
  it("owns one canonical tab and persists no discovery payload, handle or run authorization", async () => {
    const f = fixture();
    const authorization = await playing(f);
    expect(f.opened).toEqual([`${origin}/courses/101/modules/items/501`]);
    expect(f.saved?.player).toEqual({
      tabId: 9,
      id: "101:501",
      courseId: "101",
    });
    expect(JSON.stringify(f.saved)).not.toContain(authorization.binding.token);
    expect(JSON.stringify(f.saved)).not.toContain("Course");
    expect(parseStoredPlayback(f.saved)).toEqual(f.saved);
    expect(
      snapshot(await f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" }))
        .active?.credit,
    ).toBe("unknown");
  });
  it("rejects stale run, frame and document events without finishing an item", async () => {
    const f = fixture();
    const { binding } = await playing(f);
    expect(
      await f.runtime.signal(
        { ...address, documentId: "old" },
        binding,
        "ended",
      ),
    ).toBe(false);
    expect(
      await f.runtime.signal({ ...address, frameId: 3 }, binding, "ended"),
    ).toBe(false);
    expect(
      await f.runtime.signal(address, { ...binding, runId: "old" }, "ended"),
    ).toBe(false);
    expect(f.saved?.finishedIds).toEqual([]);
  });
  it("advances once after native end without claiming LMS credit", async () => {
    const f = fixture();
    const { binding } = await playing(f);
    expect(await f.runtime.signal(address, binding, "ended")).toBe(true);
    expect(await f.runtime.signal(address, binding, "ended")).toBe(false);
    expect(f.saved?.finishedIds).toEqual(["101:501"]);
    expect(f.closed).toEqual([9]);
    expect(
      snapshot(
        await f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" }),
      ).queue.map((item) => item.id),
    ).toEqual(["101:502"]);
  });
  it("pauses and resumes the same document instead of launching a second player", async () => {
    const f = fixture();
    await playing(f);
    expect(
      snapshot(await f.runtime.command({ version: 1, type: "PLAYBACK_PAUSE" }))
        .status,
    ).toBe("paused");
    expect(
      snapshot(await f.runtime.command({ version: 1, type: "PLAYBACK_RESUME" }))
        .status,
    ).toBe("playing");
    expect(f.controls).toEqual(["pause", "resume"]);
    expect(f.opened).toHaveLength(1);
  });
  it("rejects a delayed native-ended event after user pause", async () => {
    const f = fixture();
    const { binding } = await playing(f);
    await f.runtime.command({ version: 1, type: "PLAYBACK_PAUSE" });
    expect(await f.runtime.signal(address, binding, "ended")).toBe(false);
    expect(f.saved?.finishedIds).toEqual([]);
    expect(f.opened).toHaveLength(1);
    expect(f.alarms.has(PLAYBACK_ALARM)).toBe(false);
  });
  it("cancels a pending item without pausing the current native video", async () => {
    const f = fixture();
    await playing(f);
    await f.runtime.command({
      version: 1,
      type: "PLAYBACK_CANCEL",
      id: "101:502",
    });
    expect(f.controls).toEqual([]);
    expect(f.saved?.excludedIds).toEqual(["101:502"]);
  });
  it("invalidates a pending fresh query before all-stop can be overtaken", async () => {
    const f = fixture();
    await enabled(f);
    const entered = deferred<void>(),
      reply = deferred<PlaybackDiscovery>();
    f.read = async () => {
      entered.resolve();
      return reply.promise;
    };
    const alarm = f.runtime.alarm(PLAYBACK_ALARM);
    await entered.promise;
    const stopped = f.runtime.command({
      version: 1,
      type: "PLAYBACK_STOP_ALL",
    });
    reply.resolve(f.discovery);
    await alarm;
    expect(snapshot(await stopped).status).toBe("stopped");
    expect(f.opened).toEqual([]);
    expect(f.alarms.has(PLAYBACK_ALARM)).toBe(false);
    expect(f.alarms.has(PLAYBACK_WATCHDOG)).toBe(false);
    expect(f.saved?.excludedIds).toEqual(["101:501", "101:502"]);
  });
  it("recreates lost alarms after a worker restart from a fresh plan", async () => {
    const f = fixture();
    await enabled(f);
    f.alarms.clear();
    const restarted = new PlaybackRuntime(f.ports);
    const result = snapshot(await restarted.startup());
    expect(result.status).toBe("scheduled");
    expect(f.alarms.has(PLAYBACK_ALARM)).toBe(true);
    expect(f.opened).toEqual([]);
  });
  it("closes an interrupted worker-owned player and requires explicit resume", async () => {
    const f = fixture();
    await playing(f);
    const result = snapshot(await new PlaybackRuntime(f.ports).startup());
    expect(result.status).toBe("paused");
    expect(f.closed).toEqual([9]);
    expect(f.alarms.size).toBe(0);
    expect(f.opened).toHaveLength(1);
  });
  it("rejects missed deadlines using fresh scheduling rather than an old alarm payload", async () => {
    const f = fixture();
    await enabled(f);
    f.now = base + 3 * 3600000;
    const result = snapshot(await f.runtime.alarm(PLAYBACK_ALARM));
    expect(result.queue).toEqual([]);
    expect(
      result.blocked.every((item) => item.reason === "missed_deadline"),
    ).toBe(true);
    expect(f.opened).toEqual([]);
  });
  it("stops on account change and clears previous account reservations", async () => {
    const f = fixture();
    await playing(f);
    f.discovery = { ...f.discovery, accountKey: "b".repeat(64) };
    expect(
      await f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" }),
    ).toEqual({ status: "error", code: "ACCOUNT_CHANGED" });
    expect(f.saved).toBeNull();
    expect(f.closed).toEqual([9]);
    expect(f.clears).toBe(1);
  });
  it("stops on missed player leases and tab loss", async () => {
    const f = fixture();
    await playing(f);
    expect(await f.runtime.alarm(PLAYBACK_WATCHDOG)).toEqual({
      status: "error",
      code: "PLAYER_LOST",
    });
    expect(f.closed).toEqual([9]);
    expect(f.alarms.size).toBe(0);
  });
  it("treats an externally closed player tab as terminal without restarting it", async () => {
    const f = fixture();
    await playing(f);
    expect(f.opened).toHaveLength(1);
    await f.runtime.lost(9);
    expect(f.saved?.stopped).toBe(true);
    expect(f.saved?.player).toBeNull();
    await f.runtime.alarm(PLAYBACK_ALARM);
    expect(f.opened).toHaveLength(1);
    expect(f.alarms.size).toBe(0);
  });
  it("all-stop closes the owned tab without relying on a dead document acknowledgment", async () => {
    const f = fixture();
    await playing(f);
    f.failControl = true;
    const result = snapshot(
      await f.runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" }),
    );
    expect(result.status).toBe("stopped");
    expect(f.closed).toEqual([9]);
    expect(f.saved?.settings.enabled).toBe(false);
  });
  it("does not convert a deliberately closed player tab into a failure", async () => {
    let notified: Promise<void> | undefined;
    const f = fixture((runtime, tabId) => {
      notified = runtime.lost(tabId);
    });
    await playing(f);
    const stopped = snapshot(
      await f.runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" }),
    );
    await notified;
    expect(stopped.status).toBe("stopped");
    expect(
      snapshot(await f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" }))
        .status,
    ).toBe("stopped");
  });
  it("bounds native authorization by the allowed Seoul viewing window", async () => {
    const f = fixture();
    f.discovery = {
      ...f.discovery,
      candidates: [
        {
          id: "101:501",
          courseId: "101",
          deadline: new Date(base + 24 * 3600000).toISOString(),
          durationMinutes: 10,
          completion: "incomplete",
        },
      ],
    };
    snapshot(
      await f.runtime.command({
        version: 1,
        type: "PLAYBACK_CONFIGURE",
        settings: { ...settings, windowEndHour: 10 },
      }),
    );
    f.now = base + 1000;
    await f.runtime.alarm(PLAYBACK_ALARM);
    const authorization = await f.runtime.authorize(address);
    expect(authorization?.binding.deadline).toBe(base + 3600000);
  });
  it("never authorizes playback after storage rejects recovery state", async () => {
    const f = fixture();
    await enabled(f);
    f.failSave = true;
    f.now = base + 1000;
    expect(await f.runtime.alarm(PLAYBACK_ALARM)).toEqual({
      status: "error",
      code: "STORAGE",
    });
    expect(await f.runtime.authorize(address)).toBeNull();
    expect(f.closed).toEqual([9]);
  });
  it("consumes an ephemeral selection into minimal manual confirmation and invalidates source changes", async () => {
    const f = fixture();
    f.discovery = {
      ...f.discovery,
      candidates: [
        {
          id: "101:501",
          courseId: "101",
          durationMinutes: null,
          completion: "unknown",
          deadline: null,
        },
      ],
    };
    await enabled(f);
    const result = snapshot(
      await f.runtime.command({
        version: 1,
        type: "PLAYBACK_CONFIRM",
        handle: "00000000-0000-4000-8000-000000000001",
        deadline: new Date(base + 3600000).toISOString(),
        durationMinutes: 10,
        completion: "incomplete",
      }),
    );
    expect(result.queue.map((item) => item.id)).toEqual(["101:501"]);
    expect(JSON.stringify(f.saved)).not.toContain("handle");
    f.discovery = {
      ...f.discovery,
      candidates: [
        {
          id: "101:501",
          courseId: "101",
          durationMinutes: null,
          completion: "unknown",
          deadline: new Date(base + 7200000).toISOString(),
        },
      ],
    };
    expect(
      snapshot(
        await f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" }),
      ).confirmationRequired,
    ).toBe(true);
  });
  it("blocks resume if account verification fails", async () => {
    const f = fixture();
    await playing(f);
    await f.runtime.command({ version: 1, type: "PLAYBACK_PAUSE" });
    f.read = async () => {
      throw new PlaybackRuntimeError("LOGIN_REQUIRED");
    };
    expect(
      await f.runtime.command({ version: 1, type: "PLAYBACK_RESUME" }),
    ).toEqual({ status: "error", code: "LOGIN_REQUIRED" });
    expect(f.controls).toEqual(["pause"]);
    expect(f.closed).toEqual([9]);
  });
});

describe("minimal account-scoped corrections", () => {
  it("does not persist account identity, settings or salt before opt-in", async () => {
    const f = fixture();
    await f.runtime.startup();
    await f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" });
    await f.runtime.command({
      version: 1,
      type: "CALENDAR_OVERRIDES_GET",
      sources: [],
    });
    expect(f.saved).toBeNull();
  });
  it("expires terminal records after thirty days using a durable cleanup alarm", async () => {
    const f = fixture();
    const { binding } = await playing(f);
    await f.runtime.signal(address, binding, "ended");
    expect(f.alarms.get(PLAYBACK_RETENTION)).toBe(
      base + 1000 + 30 * 24 * 3600000,
    );
    f.now = base + 1000 + 30 * 24 * 3600000;
    await f.runtime.alarm(PLAYBACK_RETENTION);
    expect(f.saved?.finishedIds).toEqual([]);
    expect(f.saved?.terminalAt).toEqual({});
    expect(f.alarms.has(PLAYBACK_RETENTION)).toBe(false);
  });
  it("requires confirmation when the calendar source revision changes", async () => {
    const f = fixture();
    const override = {
      id: "announcement:1234abcd",
      sourceRevision: "2026-09-24T00:00:00Z",
      excluded: false,
      date: "2026-09-26",
      time: "14:00",
    } as const;
    snapshot(
      await f.runtime.command({
        version: 1,
        type: "CALENDAR_OVERRIDE_SET",
        override,
      }),
    );
    const result = snapshot(
      await f.runtime.command({
        version: 1,
        type: "CALENDAR_OVERRIDES_GET",
        sources: [{ id: override.id, sourceRevision: "2026-09-25T00:00:00Z" }],
      }),
    );
    expect(result.calendarOverrides).toEqual([
      { ...override, confirmationRequired: true },
    ]);
    expect(f.saved?.calendarOverrides).toEqual([override]);
  });
  it("delete-all removes corrections, schedules and player recovery data", async () => {
    const f = fixture();
    await playing(f);
    await f.runtime.command({
      version: 1,
      type: "CALENDAR_OVERRIDE_SET",
      override: {
        id: "planner:1234abcd",
        sourceRevision: "2026-09-24",
        excluded: true,
      },
    });
    const result = snapshot(
      await f.runtime.command({ version: 1, type: "LOCAL_DATA_DELETE_ALL" }),
    );
    expect(f.saved).toBeNull();
    expect(result.calendarOverrides).toEqual([]);
    expect(result.settings.enabled).toBe(false);
    expect(f.alarms.size).toBe(0);
  });
  it("rejects extra raw fields at command and storage boundaries", () => {
    expect(
      isPlaybackCommand({
        version: 1,
        type: "PLAYBACK_CONFIGURE",
        settings,
        url: "https://evil.invalid",
      }),
    ).toBe(false);
    expect(
      isPlaybackCommand({
        version: 1,
        type: "CALENDAR_OVERRIDE_SET",
        override: {
          id: "planner:1234abcd",
          sourceRevision: "2026-09-24",
          excluded: true,
          html: "<b>raw</b>",
        },
      }),
    ).toBe(false);
    expect(
      parseStoredPlayback({
        ...emptyPlayback(accountKey, origin),
        handle: "secret",
      }),
    ).toBeNull();
    expect(
      isDiscovery({
        accountKey,
        origin,
        courses: [],
        candidates: [
          {
            id: "101:501",
            courseId: "102",
            deadline: null,
            durationMinutes: null,
            completion: "unknown",
          },
        ],
      }),
    ).toBe(false);
    expect(playerPage("https://kucom.korea.ac.kr/em/native")).toBe(true);
    expect(playerPage("https://kucom.korea.ac.kr/sso/login")).toBe(false);
    expect(
      playerPage(
        `${origin}/courses/101/modules/items/501?redirect=https://evil.invalid`,
      ),
    ).toBe(false);
  });
});
