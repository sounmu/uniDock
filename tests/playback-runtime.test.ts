import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlaybackRuntime,
  PlaybackRuntimeError,
  PLAYBACK_WATCHDOG,
  type PlayerAddress,
  type RuntimePorts,
} from "../src/playback/runtime";
import {
  emptyPlayback,
  ChromePlaybackStore,
  parseStoredPlayback,
  type StoredPlayback,
} from "../src/playback/storage";
import type { PlaybackDiscovery, PlaybackResult } from "../src/playback/bridge";

const accountKey = "a".repeat(64);
const origin = "https://mylms.korea.ac.kr";
const handles = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
] as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
const address: PlayerAddress = { tabId: 9, frameId: 2, documentId: "doc" };
const discovery: PlaybackDiscovery = {
  accountKey,
  origin,
  courses: [{ id: "101", name: "Course" }],
  candidates: [
    { id: "101:501", courseId: "101", title: "First" },
    { id: "101:502", courseId: "101", title: "Second" },
  ],
};
afterEach(() => vi.unstubAllGlobals());
function snapshot(result: PlaybackResult) {
  if (result.status !== "success") throw new Error(result.code);
  return result.snapshot;
}
function fixture() {
  let saved: StoredPlayback | null = null;
  let now = 1000;
  let uuid = 0;
  let failLogin = false;
  let failSecondResolve = false;
  let resolveCount = 0;
  const opened: string[] = [];
  const closed: number[] = [];
  const controls: string[] = [];
  const alarms = new Map<string, number>();
  const ports: RuntimePorts = {
    store: {
      load: async () => (saved ? structuredClone(saved) : null),
      save: async (value) => {
        saved = structuredClone(value);
      },
      clear: async () => {
        saved = null;
      },
      erase: async () => {
        saved = null;
      },
    },
    now: () => now,
    uuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    discover: async () => {
      if (failLogin) throw new PlaybackRuntimeError("LOGIN_REQUIRED");
      return discovery;
    },
    resolve: async () => {
      if (failSecondResolve && resolveCount === 1)
        throw new PlaybackRuntimeError("STALE_SELECTION");
      const id = resolveCount++ === 0 ? "101:501" : "101:502";
      return { discovery, id, courseId: "101" };
    },
    open: async (url) => {
      opened.push(url);
      return 9;
    },
    navigate: async () => {},
    close: async (tabId) => {
      closed.push(tabId);
    },
    control: async (_address, _binding, action) => {
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
      return saved;
    },
    set saved(value: StoredPlayback | null) {
      saved = value;
    },
    set failLogin(value: boolean) {
      failLogin = value;
    },
    set failSecondResolve(value: boolean) {
      failSecondResolve = value;
    },
    set now(value: number) {
      now = value;
    },
  };
}
async function start(f: ReturnType<typeof fixture>) {
  return snapshot(
    await f.runtime.command({ version: 1, type: "PLAYBACK_START", handles }),
  );
}
async function playing(f: ReturnType<typeof fixture>) {
  await start(f);
  const authorization = await f.runtime.authorize(address);
  if (!authorization) throw new Error("not authorized");
  await f.runtime.signal(address, authorization.binding, "playing");
  return authorization.binding;
}

describe("immediate ordered playlist runtime", () => {
  it("atomically resolves click order, persists only minimal IDs, and starts first immediately", async () => {
    const f = fixture();
    const result = await start(f);
    expect(result.current?.id).toBe("101:501");
    expect(result.queue.map((item) => item.id)).toEqual(["101:502"]);
    expect(f.opened).toEqual([`${origin}/courses/101/modules/items/501`]);
    expect(f.saved?.playlist).toEqual([
      { id: "101:501", courseId: "101" },
      { id: "101:502", courseId: "101" },
    ]);
    expect(JSON.stringify(f.saved)).not.toContain(handles[0]);
    expect(JSON.stringify(f.saved)).not.toContain("First");
  });

  it("does not persist or launch a partial playlist when a later handle is stale", async () => {
    const f = fixture();
    f.failSecondResolve = true;
    expect(
      await f.runtime.command({
        version: 1,
        type: "PLAYBACK_START",
        handles,
      }),
    ).toEqual({ status: "error", code: "STALE_SELECTION" });
    expect(f.saved).toBeNull();
    expect(f.opened).toEqual([]);
  });

  it("does not let a late start failure invalidate a newer stop and start", async () => {
    const f = fixture();
    const pending = deferred<never>();
    const resolving = deferred<void>();
    vi.spyOn(f.ports, "resolve").mockImplementation(async (handle) => {
      if (handle === handles[0]) {
        resolving.resolve();
        return pending.promise;
      }
      return { discovery, id: "101:502", courseId: "101" };
    });

    const oldStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles: [handles[0]],
    });
    await resolving.promise;
    const stop = f.runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" });
    const newStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles: [handles[1]],
    });
    pending.reject(new PlaybackRuntimeError("TIMEOUT"));

    expect(await oldStart).toEqual({ status: "error", code: "BUSY" });
    expect(await stop).toMatchObject({ status: "success" });
    expect(snapshot(await newStart)).toMatchObject({
      status: "starting",
      current: { id: "101:502" },
    });
    expect(f.saved?.stopped).toBe(false);
    expect(f.opened).toEqual([`${origin}/courses/101/modules/items/502`]);
  });

  it("does not consume remaining old handles after a duplicate start supersedes it", async () => {
    const f = fixture();
    const firstResolution = deferred<{
      discovery: PlaybackDiscovery;
      id: string;
      courseId: string;
    }>();
    const resolving = deferred<void>();
    const resolve = vi
      .spyOn(f.ports, "resolve")
      .mockImplementation(async (handle) => {
        if (handle === handles[0]) {
          resolving.resolve();
          return firstResolution.promise;
        }
        return { discovery, id: "101:502", courseId: "101" };
      });
    const oldStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles,
    });
    await resolving.promise;
    const newStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles: [handles[1]],
    });
    firstResolution.resolve({ discovery, id: "101:501", courseId: "101" });

    expect(await oldStart).toEqual({ status: "error", code: "BUSY" });
    expect(snapshot(await newStart).current?.id).toBe("101:502");
    expect(resolve.mock.calls.map(([handle]) => handle)).toEqual([
      handles[0],
      handles[1],
    ]);
  });

  it("does not consume handles for a start superseded before lane entry", async () => {
    const f = fixture();
    const oldDiscovery = deferred<PlaybackDiscovery>();
    const discovering = deferred<void>();
    vi.spyOn(f.ports, "discover")
      .mockImplementationOnce(async () => {
        discovering.resolve();
        return oldDiscovery.promise;
      })
      .mockResolvedValue(discovery);
    const resolve = vi.spyOn(f.ports, "resolve").mockResolvedValue({
      discovery,
      id: "101:502",
      courseId: "101",
    });
    const status = f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" });
    await discovering.promise;
    const oldStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles: [handles[0]],
    });
    const newStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles: [handles[1]],
    });
    oldDiscovery.resolve(discovery);

    expect(await status).toEqual({ status: "error", code: "BUSY" });
    expect(await oldStart).toEqual({ status: "error", code: "BUSY" });
    expect(snapshot(await newStart).current?.id).toBe("101:502");
    expect(resolve).toHaveBeenCalledExactlyOnceWith(handles[1]);
  });

  it("does not let an old discovery error kill a newer stop and start intent", async () => {
    const f = fixture();
    await start(f);
    const oldDiscovery = deferred<never>();
    const discovering = deferred<void>();
    vi.spyOn(f.ports, "discover")
      .mockImplementationOnce(async () => {
        discovering.resolve();
        return oldDiscovery.promise;
      })
      .mockResolvedValue(discovery);
    vi.spyOn(f.ports, "resolve").mockResolvedValue({
      discovery,
      id: "101:502",
      courseId: "101",
    });
    const oldStatus = f.runtime.command({
      version: 1,
      type: "PLAYBACK_STATUS",
    });
    await discovering.promise;
    const stop = f.runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" });
    const newStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles: [handles[1]],
    });
    oldDiscovery.reject(new PlaybackRuntimeError("LOGIN_REQUIRED"));

    expect(await oldStatus).toEqual({ status: "error", code: "BUSY" });
    await stop;
    expect(snapshot(await newStart)).toMatchObject({
      status: "starting",
      current: { id: "101:502" },
    });
    expect(f.saved?.stopped).toBe(false);
  });

  it("closes only the old tab when an open completes after a newer stop and start", async () => {
    const f = fixture();
    const oldOpen = deferred<number>();
    const opening = deferred<void>();
    vi.spyOn(f.ports, "resolve").mockImplementation(async (handle) => ({
      discovery,
      id: handle === handles[0] ? "101:501" : "101:502",
      courseId: "101",
    }));
    vi.spyOn(f.ports, "open")
      .mockImplementationOnce(async () => {
        opening.resolve();
        return oldOpen.promise;
      })
      .mockResolvedValueOnce(10);
    const oldStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles: [handles[0]],
    });
    await opening.promise;
    const stop = f.runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" });
    const newStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles: [handles[1]],
    });
    oldOpen.resolve(9);

    expect(await oldStart).toEqual({ status: "error", code: "BUSY" });
    await stop;
    expect(snapshot(await newStart).current?.id).toBe("101:502");
    expect(f.closed).toEqual([9]);
    expect(f.runtime.dedicatedTabId).toBe(10);
  });

  it("still closes a superseded tab when watchdog cleanup fails", async () => {
    const f = fixture();
    const oldOpen = deferred<number>();
    const opening = deferred<void>();
    vi.spyOn(f.ports, "resolve").mockImplementation(async (handle) => ({
      discovery,
      id: handle === handles[0] ? "101:501" : "101:502",
      courseId: "101",
    }));
    vi.spyOn(f.ports, "open")
      .mockImplementationOnce(async () => {
        opening.resolve();
        return oldOpen.promise;
      })
      .mockResolvedValueOnce(10);
    const oldStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles: [handles[0]],
    });
    await opening.promise;
    vi.spyOn(f.ports, "alarm").mockRejectedValueOnce(new Error("alarm"));
    const stop = f.runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" });
    const newStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles: [handles[1]],
    });
    oldOpen.resolve(9);

    expect(await oldStart).toEqual({ status: "error", code: "BUSY" });
    expect(f.closed).toContain(9);
    await stop;
    expect(snapshot(await newStart).current?.id).toBe("101:502");
    expect(f.runtime.dedicatedTabId).toBe(10);
  });

  it("recovers through pause and resume when a superseded open rejects", async () => {
    const f = fixture();
    const oldOpen = deferred<never>();
    const opening = deferred<void>();
    vi.spyOn(f.ports, "open")
      .mockImplementationOnce(async () => {
        opening.resolve();
        return oldOpen.promise;
      })
      .mockResolvedValueOnce(10);
    const oldStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles,
    });
    await opening.promise;
    const pause = f.runtime.command({ version: 1, type: "PLAYBACK_PAUSE" });
    const resume = f.runtime.command({ version: 1, type: "PLAYBACK_RESUME" });
    oldOpen.reject(new PlaybackRuntimeError("TIMEOUT"));

    expect(await oldStart).toEqual({ status: "error", code: "BUSY" });
    expect(snapshot(await pause).status).toBe("paused");
    expect(snapshot(await resume)).toMatchObject({
      status: "starting",
      current: { id: "101:501" },
    });
    expect(f.runtime.dedicatedTabId).toBe(10);
  });

  it("recovers through pause and resume when superseded player persistence rejects", async () => {
    const f = fixture();
    const oldPersist = deferred<never>();
    const persisting = deferred<void>();
    const save = f.ports.store.save.bind(f.ports.store);
    let saves = 0;
    vi.spyOn(f.ports.store, "save").mockImplementation(async (value) => {
      saves++;
      if (saves === 2) {
        persisting.resolve();
        return oldPersist.promise;
      }
      return save(value);
    });
    vi.spyOn(f.ports, "open")
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(10);
    const oldStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles,
    });
    await persisting.promise;
    const pause = f.runtime.command({ version: 1, type: "PLAYBACK_PAUSE" });
    const resume = f.runtime.command({ version: 1, type: "PLAYBACK_RESUME" });
    oldPersist.reject(new PlaybackRuntimeError("STORAGE"));

    expect(await oldStart).toEqual({ status: "error", code: "BUSY" });
    expect(snapshot(await pause).status).toBe("paused");
    expect(snapshot(await resume)).toMatchObject({
      status: "starting",
      current: { id: "101:501" },
    });
    expect(f.closed).toContain(9);
    expect(f.runtime.dedicatedTabId).toBe(10);
  });

  it("advances immediately and only after matching native ended", async () => {
    const f = fixture();
    const binding = await playing(f);
    expect(
      await f.runtime.signal(
        { ...address, documentId: "old" },
        binding,
        "ended",
      ),
    ).toBe(false);
    expect(await f.runtime.signal(address, binding, "ended")).toBe(true);
    expect(f.opened).toEqual([
      `${origin}/courses/101/modules/items/501`,
      `${origin}/courses/101/modules/items/502`,
    ]);
    expect(f.saved?.playlist).toEqual([{ id: "101:502", courseId: "101" }]);
    expect(JSON.stringify(f.saved)).not.toContain("finishedIds");
    expect(JSON.stringify(f.saved)).not.toContain("terminalAt");
  });

  it("preserves the next item on login failure and requires explicit resume", async () => {
    const f = fixture();
    const binding = await playing(f);
    f.failLogin = true;
    await f.runtime.signal(address, binding, "ended");
    expect(f.saved?.playlist.map((item) => item.id)).toEqual(["101:502"]);
    expect(f.saved?.stopped).toBe(true);
    expect(f.opened).toHaveLength(1);
    expect(
      snapshot(await f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" }))
        .status,
    ).toBe("blocked-login");
    f.failLogin = false;
    const resumed = snapshot(
      await f.runtime.command({ version: 1, type: "PLAYBACK_RESUME" }),
    );
    expect(resumed.status).toBe("starting");
    expect(f.opened.at(-1)).toBe(`${origin}/courses/101/modules/items/502`);
  });

  it("stops the active player but preserves its playlist when refresh detects login expiry", async () => {
    const f = fixture();
    await playing(f);
    f.failLogin = true;
    const blocked = snapshot(
      await f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" }),
    );
    expect(blocked.status).toBe("blocked-login");
    expect(f.closed).toEqual([9]);
    expect(f.saved?.playlist.map((item) => item.id)).toEqual([
      "101:501",
      "101:502",
    ]);
    expect(f.saved?.stopped).toBe(true);
    expect(f.alarms.size).toBe(0);
  });

  it("pauses and resumes the same visible player without replacing the playlist", async () => {
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

  it("retains a playlist across restart but never auto-runs it", async () => {
    const f = fixture();
    await playing(f);
    const restarted = new PlaybackRuntime(f.ports);
    const result = snapshot(await restarted.startup());
    expect(result.status).toBe("paused");
    expect(result.current?.id).toBe("101:501");
    expect(f.opened).toHaveLength(1);
    expect(f.closed).toEqual([9]);
    expect(
      snapshot(await restarted.command({ version: 1, type: "PLAYBACK_STATUS" }))
        .status,
    ).toBe("paused");
    expect(
      snapshot(
        await restarted.command({ version: 1, type: "PLAYBACK_REFRESH" }),
      ).status,
    ).toBe("paused");
    expect(f.opened).toHaveLength(1);
  });

  it("stops after a missed lease without dropping the playlist", async () => {
    const f = fixture();
    await playing(f);
    expect(await f.runtime.alarm(PLAYBACK_WATCHDOG)).toEqual({
      status: "error",
      code: "PLAYER_LOST",
    });
    expect(f.saved?.playlist).toHaveLength(2);
    expect(f.saved?.stopped).toBe(true);
  });
});

describe("playlist storage", () => {
  it("accepts v2 and rejects old scheduled v1 state", () => {
    const value = emptyPlayback(accountKey, origin);
    value.playlist = [{ id: "101:501", courseId: "101" }];
    expect(parseStoredPlayback(value)).toEqual(value);
    expect(parseStoredPlayback({ ...value, version: 1 })).toBeNull();
    expect(parseStoredPlayback({ ...value, settings: {} })).toBeNull();
  });

  it("deletes legacy v1 schedules instead of migrating them", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          setAccessLevel: vi.fn().mockResolvedValue(undefined),
          get: vi.fn().mockResolvedValue({
            "unidock.playback.v1": {
              version: 1,
              settings: { enabled: true },
            },
          }),
          remove,
        },
        session: { remove: vi.fn() },
      },
    });
    expect(await new ChromePlaybackStore().load()).toBeNull();
    expect(remove).toHaveBeenCalledExactlyOnceWith("unidock.playback.v1");
  });
});
