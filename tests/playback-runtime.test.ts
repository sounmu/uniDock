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
  const controlAuthorizations: Array<{
    binding: { runId: string; token: string; deadline: number };
    leaseUntil: number;
  }> = [];
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
    bind: async (onSelected) => {
      onSelected(7);
      return {
        discovery,
        source: {
          sourceTabId: 7,
          documentToken: "00000000-0000-4000-8000-000000000099",
        },
      };
    },
    resolveBatch: async (requested) => {
      if (failSecondResolve && requested.length > 1)
        throw new PlaybackRuntimeError("STALE_SELECTION");
      const items = requested.map(() => ({
        id: resolveCount++ === 0 ? "101:501" : "101:502",
        courseId: "101",
      }));
      return { discovery, items };
    },
    open: async (url) => {
      opened.push(url);
      return 9;
    },
    navigate: async () => {},
    close: async (tabId) => {
      closed.push(tabId);
    },
    control: async (_address, authorization, action) => {
      controls.push(action);
      controlAuthorizations.push(authorization);
    },
    alarm: async (name, when) => {
      if (when === null) alarms.delete(name);
      else alarms.set(name, when);
    },
    clearAlarmPrefix: async (prefix) => {
      for (const name of alarms.keys())
        if (name === prefix || name.startsWith(`${prefix}:`))
          alarms.delete(name);
    },
  };
  const runtime = new PlaybackRuntime(ports);
  return {
    runtime,
    ports,
    opened,
    closed,
    controls,
    controlAuthorizations,
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
    await f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles,
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
    }),
  );
}
async function playing(f: ReturnType<typeof fixture>) {
  await start(f);
  const authorization = await f.runtime.authorize(address);
  if (!authorization) throw new Error("not authorized");
  await f.runtime.signal(address, authorization.binding, "playing");
  return authorization.binding;
}

it("keeps active-run discovery pinned to the listing source", async () => {
  const f = fixture();
  await start(f);
  const discover = vi.spyOn(f.ports, "discover");
  await f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" });
  expect(discover).toHaveBeenCalledExactlyOnceWith({
    sourceTabId: 7,
    documentToken: "00000000-0000-4000-8000-000000000099",
  });
});

it("invalidates a pending start when its source document is replaced", async () => {
  const f = fixture();
  const resolving = deferred<void>();
  const resolution = deferred<{
    discovery: PlaybackDiscovery;
    items: { id: string; courseId: string }[];
  }>();
  vi.spyOn(f.ports, "resolveBatch").mockImplementationOnce(async () => {
    resolving.resolve();
    return resolution.promise;
  });
  const start = f.runtime.command({
    version: 1,
    type: "PLAYBACK_START",
    handles: [handles[0]],
    sourceTabId: 7,
    documentToken: "00000000-0000-4000-8000-000000000099",
  });
  await resolving.promise;
  await f.runtime.sourceLost(7);
  resolution.resolve({
    discovery,
    items: [{ id: "101:501", courseId: "101" }],
  });
  expect(await start).toEqual({ status: "error", code: "BUSY" });
  expect(f.opened).toEqual([]);
});

it("invalidates an explicit resume when its selected source reloads before binding", async () => {
  const f = fixture();
  f.saved = {
    ...emptyPlayback(accountKey, origin),
    playlist: [{ id: "101:501", courseId: "101" }],
    stopped: true,
  };
  const selected = deferred<void>();
  const rebound = deferred<{
    discovery: PlaybackDiscovery;
    source: {
      sourceTabId: number;
      documentToken: string;
    };
  }>();
  vi.spyOn(f.ports, "bind").mockImplementationOnce(async (onSelected) => {
    onSelected(8);
    selected.resolve();
    return rebound.promise;
  });
  const resume = f.runtime.command({ version: 1, type: "PLAYBACK_RESUME" });
  await selected.promise;
  await f.runtime.sourceLost(8);
  rebound.resolve({
    discovery,
    source: {
      sourceTabId: 8,
      documentToken: "00000000-0000-4000-8000-000000000098",
    },
  });
  expect(await resume).toEqual({ status: "error", code: "BUSY" });
  expect(f.opened).toEqual([]);
});

it("replaces superseded start ownership with the explicit resume source", async () => {
  const f = fixture();
  f.saved = {
    ...emptyPlayback(accountKey, origin),
    playlist: [{ id: "101:501", courseId: "101" }],
    stopped: true,
  };
  const resolving = deferred<void>();
  const oldResolution = deferred<{
    discovery: PlaybackDiscovery;
    items: { id: string; courseId: string }[];
  }>();
  vi.spyOn(f.ports, "resolveBatch").mockImplementationOnce(async () => {
    resolving.resolve();
    return oldResolution.promise;
  });
  vi.spyOn(f.ports, "bind").mockImplementationOnce(async (onSelected) => {
    onSelected(8);
    return {
      discovery,
      source: {
        sourceTabId: 8,
        documentToken: "00000000-0000-4000-8000-000000000098",
      },
    };
  });
  const oldStart = f.runtime.command({
    version: 1,
    type: "PLAYBACK_START",
    handles: [handles[1]],
    sourceTabId: 7,
    documentToken: "00000000-0000-4000-8000-000000000097",
  });
  await resolving.promise;
  expect(
    snapshot(await f.runtime.command({ version: 1, type: "PLAYBACK_RESUME" }))
      .status,
  ).toBe("starting");
  expect(f.runtime.sourceTabId).toBe(8);
  await f.runtime.sourceLost(7);
  expect(f.runtime.sourceTabId).toBe(8);
  oldResolution.resolve({
    discovery,
    items: [{ id: "101:502", courseId: "101" }],
  });
  expect(await oldStart).toEqual({ status: "error", code: "BUSY" });
  await f.runtime.sourceLost(8);
  expect(f.runtime.sourceTabId).toBeNull();
  expect(f.runtime.dedicatedTabId).toBeNull();
});

it("invalidates the active source while a replacement start owns another pending source", async () => {
  const f = fixture();
  const binding = await playing(f);
  const replacementResolution = deferred<{
    discovery: PlaybackDiscovery;
    items: { id: string; courseId: string }[];
  }>();
  const replacementResolving = deferred<void>();
  vi.spyOn(f.ports, "resolveBatch").mockImplementationOnce(async () => {
    replacementResolving.resolve();
    return replacementResolution.promise;
  });
  const replacement = f.runtime.command({
    version: 1,
    type: "PLAYBACK_START",
    handles: [handles[1]],
    sourceTabId: 8,
    documentToken: "00000000-0000-4000-8000-000000000098",
  });
  await replacementResolving.promise;

  const renewal = deferred<PlaybackDiscovery>();
  const renewing = deferred<void>();
  vi.spyOn(f.ports, "discover").mockImplementationOnce(async () => {
    renewing.resolve();
    return renewal.promise;
  });
  const lease = f.runtime.lease(address, binding);
  await renewing.promise;

  const lost = f.runtime.sourceLost(7);
  renewal.resolve(discovery);
  replacementResolution.resolve({
    discovery,
    items: [{ id: "101:502", courseId: "101" }],
  });
  await lost;
  expect(await lease).toBeNull();
  expect(await replacement).toEqual({ status: "error", code: "BUSY" });
  expect(f.runtime.sourceTabId).toBeNull();
  expect(f.runtime.dedicatedTabId).toBeNull();
  expect(f.closed).toEqual([9]);
  expect(f.alarms.size).toBe(0);
});
function watchdogName(f: ReturnType<typeof fixture>): string {
  const names = [...f.alarms.keys()].filter((name) =>
    name.startsWith(`${PLAYBACK_WATCHDOG}:`),
  );
  if (names.length !== 1) throw new Error("missing unique watchdog alarm");
  return names[0]!;
}

describe("immediate ordered playlist runtime", () => {
  it("atomically resolves click order, persists only minimal IDs, and starts first immediately", async () => {
    const f = fixture();
    const resolve = vi.spyOn(f.ports, "resolveBatch");
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
    expect(resolve).toHaveBeenCalledExactlyOnceWith(handles, {
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
    });
  });

  it("rejects duplicate resolved item IDs without launching a partial playlist", async () => {
    const f = fixture();
    vi.spyOn(f.ports, "resolveBatch").mockResolvedValue({
      discovery,
      items: [
        { id: "101:501", courseId: "101" },
        { id: "101:501", courseId: "101" },
      ],
    });
    expect(
      await f.runtime.command({
        version: 1,
        type: "PLAYBACK_START",
        handles,
        sourceTabId: 7,
        documentToken: "00000000-0000-4000-8000-000000000099",
      }),
    ).toEqual({ status: "error", code: "STALE_SELECTION" });
    expect(f.saved).toBeNull();
    expect(f.opened).toEqual([]);
  });

  it("coalesces an identical concurrent start while only the latest intent commits", async () => {
    const f = fixture();
    const pending = deferred<{
      discovery: PlaybackDiscovery;
      items: { id: string; courseId: string }[];
    }>();
    const resolving = deferred<void>();
    const resolve = vi
      .spyOn(f.ports, "resolveBatch")
      .mockImplementation(async () => {
        resolving.resolve();
        return pending.promise;
      });
    const command = {
      version: 1,
      type: "PLAYBACK_START",
      handles: [handles[0]],
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
    } as const;
    const old = f.runtime.command(command);
    await resolving.promise;
    const latest = f.runtime.command(command);
    pending.resolve({
      discovery,
      items: [{ id: "101:501", courseId: "101" }],
    });
    expect(await old).toEqual({ status: "error", code: "BUSY" });
    expect(snapshot(await latest).current?.id).toBe("101:501");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("does not hand a pre-cancel batch resolution to a later start", async () => {
    const f = fixture();
    const oldResolution = deferred<{
      discovery: PlaybackDiscovery;
      items: { id: string; courseId: string }[];
    }>();
    const resolving = deferred<void>();
    const resolve = vi
      .spyOn(f.ports, "resolveBatch")
      .mockImplementationOnce(async () => {
        resolving.resolve();
        return oldResolution.promise;
      })
      .mockResolvedValueOnce({
        discovery,
        items: [{ id: "101:501", courseId: "101" }],
      });
    const command = {
      version: 1,
      type: "PLAYBACK_START",
      handles: [handles[0]],
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
    } as const;
    const old = f.runtime.command(command);
    await resolving.promise;
    await f.runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" });
    const latest = f.runtime.command(command);
    oldResolution.resolve({
      discovery,
      items: [{ id: "101:501", courseId: "101" }],
    });
    expect(await old).toEqual({ status: "error", code: "BUSY" });
    expect(snapshot(await latest).current?.id).toBe("101:501");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("keeps status in memory and coalesces only concurrent discovery reads", async () => {
    const f = fixture();
    await f.runtime.startup();
    const discover = deferred<PlaybackDiscovery>();
    const called = deferred<void>();
    const request = vi
      .spyOn(f.ports, "discover")
      .mockImplementation(async () => {
        called.resolve();
        return discover.promise;
      });

    const first = f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" });
    await called.promise;
    const second = f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" });
    const statuses = await Promise.all([
      f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" }),
      f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" }),
    ]);

    expect(statuses.every((result) => result.status === "success")).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    discover.resolve(discovery);
    expect((await first).status).toBe("success");
    expect((await second).status).toBe("success");
  });

  it("shares initialization without exposing early state or starting discovery", async () => {
    const f = fixture();
    const load = deferred<StoredPlayback | null>();
    const loaded = deferred<void>();
    const discover = vi.spyOn(f.ports, "discover");
    vi.spyOn(f.ports.store, "load").mockImplementation(async () => {
      loaded.resolve();
      return load.promise;
    });

    const status = f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" });
    const refresh = f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" });
    await loaded.promise;
    expect(f.ports.store.load).toHaveBeenCalledTimes(1);
    expect(discover).not.toHaveBeenCalled();

    load.resolve(null);
    expect((await status).status).toBe("success");
    expect((await refresh).status).toBe("success");
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("physically stops before a held refresh is released", async () => {
    const f = fixture();
    await playing(f);
    const discover = deferred<PlaybackDiscovery>();
    const called = deferred<void>();
    vi.spyOn(f.ports, "discover").mockImplementationOnce(async () => {
      called.resolve();
      return discover.promise;
    });
    const refresh = f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" });
    await called.promise;

    const stopped = await f.runtime.command({
      version: 1,
      type: "PLAYBACK_STOP_ALL",
    });
    expect(stopped).toMatchObject({
      status: "success",
      snapshot: { status: "stopped" },
    });
    expect(f.closed).toEqual([9]);

    discover.resolve(discovery);
    expect(await refresh).toEqual({ status: "error", code: "BUSY" });
    expect(f.runtime.dedicatedTabId).toBeNull();
  });

  it("closes promptly and orders erase after an already-started immutable save", async () => {
    const f = fixture();
    const saveGate = deferred<void>();
    const saving = deferred<void>();
    const originalSave = f.ports.store.save.bind(f.ports.store);
    let saves = 0;
    vi.spyOn(f.ports.store, "save").mockImplementation(async (value) => {
      saves++;
      if (saves === 2) {
        saving.resolve();
        await saveGate.promise;
      }
      await originalSave(value);
    });
    const erase = vi.spyOn(f.ports.store, "erase");

    const pendingStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
      handles: [handles[0]],
    });
    await saving.promise;
    const deleting = f.runtime.command({
      version: 1,
      type: "LOCAL_DATA_DELETE_ALL",
    });
    await vi.waitFor(() => expect(f.closed).toEqual([9]));
    expect(erase).not.toHaveBeenCalled();

    saveGate.resolve();
    expect(await pendingStart).toEqual({ status: "error", code: "BUSY" });
    expect(await deleting).toMatchObject({
      status: "success",
      snapshot: { status: "idle" },
    });
    expect(f.saved).toBeNull();
    expect(erase).toHaveBeenCalledOnce();
  });

  it("does not queue a lease behind a held refresh or resurrect after stop", async () => {
    const f = fixture();
    const binding = await playing(f);
    const discover = deferred<PlaybackDiscovery>();
    const called = deferred<void>();
    const request = vi
      .spyOn(f.ports, "discover")
      .mockImplementation(async () => {
        called.resolve();
        return discover.promise;
      });
    const refresh = f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" });
    await called.promise;
    const lease = f.runtime.lease(address, binding);
    expect(request).toHaveBeenCalledTimes(1);

    await f.runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" });
    expect(f.closed).toEqual([9]);
    discover.resolve(discovery);
    expect(await lease).toBeNull();
    expect(await refresh).toEqual({ status: "error", code: "BUSY" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps a replacement authorization independent of an obsolete failed refresh", async () => {
    const f = fixture();
    await start(f);
    const oldDiscovery = deferred<PlaybackDiscovery>();
    const oldStarted = deferred<void>();
    const discover = vi
      .spyOn(f.ports, "discover")
      .mockImplementationOnce(async () => {
        oldStarted.resolve();
        return oldDiscovery.promise;
      })
      .mockResolvedValue(discovery);
    vi.spyOn(f.ports, "resolveBatch").mockResolvedValue({
      discovery,
      items: [{ id: "101:502", courseId: "101" }],
    });

    const oldRefresh = f.runtime.command({
      version: 1,
      type: "PLAYBACK_REFRESH",
    });
    await oldStarted.promise;
    await f.runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" });
    await f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
      handles: [handles[1]],
    });
    const authorization = await f.runtime.authorize(address);
    expect(authorization).not.toBeNull();
    expect(discover).toHaveBeenCalledTimes(2);

    oldDiscovery.reject(new PlaybackRuntimeError("LOGIN_REQUIRED"));
    expect(await oldRefresh).toEqual({ status: "error", code: "BUSY" });
    expect(f.runtime.dedicatedItem).toEqual({
      id: "101:502",
      courseId: "101",
    });
    expect(f.closed).toEqual([9]);
  });

  it("does not persist or launch a partial playlist when a later handle is stale", async () => {
    const f = fixture();
    f.failSecondResolve = true;
    expect(
      await f.runtime.command({
        version: 1,
        type: "PLAYBACK_START",
        sourceTabId: 7,
        documentToken: "00000000-0000-4000-8000-000000000099",
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
    vi.spyOn(f.ports, "resolveBatch").mockImplementation(async (requested) => {
      if (requested[0] === handles[0]) {
        resolving.resolve();
        return pending.promise;
      }
      return {
        discovery,
        items: [{ id: "101:502", courseId: "101" }],
      };
    });

    const oldStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
      handles: [handles[0]],
    });
    await resolving.promise;
    const stop = f.runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" });
    const newStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
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
      items: { id: string; courseId: string }[];
    }>();
    const resolving = deferred<void>();
    const resolve = vi
      .spyOn(f.ports, "resolveBatch")
      .mockImplementation(async (requested) => {
        if (requested.length === 2) {
          resolving.resolve();
          return firstResolution.promise;
        }
        return {
          discovery,
          items: [{ id: "101:502", courseId: "101" }],
        };
      });
    const oldStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
      handles,
    });
    await resolving.promise;
    const newStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
      handles: [handles[1]],
    });
    firstResolution.resolve({
      discovery,
      items: [
        { id: "101:501", courseId: "101" },
        { id: "101:502", courseId: "101" },
      ],
    });

    expect(await oldStart).toEqual({ status: "error", code: "BUSY" });
    expect(snapshot(await newStart).current?.id).toBe("101:502");
    expect(resolve.mock.calls.map(([requested]) => requested)).toEqual([
      handles,
      [handles[1]],
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
    const resolve = vi.spyOn(f.ports, "resolveBatch").mockResolvedValue({
      discovery,
      items: [{ id: "101:502", courseId: "101" }],
    });
    const status = f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" });
    await discovering.promise;
    const oldStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
      handles: [handles[0]],
    });
    const newStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
      handles: [handles[1]],
    });
    oldDiscovery.resolve(discovery);

    expect(await status).toEqual({ status: "error", code: "BUSY" });
    expect(await oldStart).toEqual({ status: "error", code: "BUSY" });
    expect(snapshot(await newStart).current?.id).toBe("101:502");
    expect(resolve).toHaveBeenCalledExactlyOnceWith([handles[1]], {
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
    });
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
    vi.spyOn(f.ports, "resolveBatch").mockResolvedValue({
      discovery,
      items: [{ id: "101:502", courseId: "101" }],
    });
    const oldStatus = f.runtime.command({
      version: 1,
      type: "PLAYBACK_REFRESH",
    });
    await discovering.promise;
    const stop = f.runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" });
    const newStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
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
    vi.spyOn(f.ports, "resolveBatch").mockImplementation(async (requested) => ({
      discovery,
      items: requested.map((handle) => ({
        id: handle === handles[0] ? "101:501" : "101:502",
        courseId: "101",
      })),
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
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
      handles: [handles[0]],
    });
    await opening.promise;
    const stop = f.runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" });
    const newStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
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
    vi.spyOn(f.ports, "resolveBatch").mockImplementation(async (requested) => ({
      discovery,
      items: requested.map((handle) => ({
        id: handle === handles[0] ? "101:501" : "101:502",
        courseId: "101",
      })),
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
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
      handles: [handles[0]],
    });
    await opening.promise;
    vi.spyOn(f.ports, "alarm").mockRejectedValueOnce(new Error("alarm"));
    const stop = f.runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" });
    const newStart = f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
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
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
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
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
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

  it("does not launch a cancelled native-advance head after held discovery", async () => {
    const f = fixture();
    const binding = await playing(f);
    const nextDiscovery = deferred<PlaybackDiscovery>();
    const discovering = deferred<void>();
    vi.spyOn(f.ports, "discover").mockImplementationOnce(async () => {
      discovering.resolve();
      return nextDiscovery.promise;
    });

    const ended = f.runtime.signal(address, binding, "ended");
    await discovering.promise;
    await f.runtime.command({
      version: 1,
      type: "PLAYBACK_CANCEL",
      id: "101:502",
    });
    nextDiscovery.resolve(discovery);

    expect(await ended).toBe(true);
    expect(f.opened).toEqual([`${origin}/courses/101/modules/items/501`]);
    expect(f.saved?.playlist).toEqual([]);
    expect(
      snapshot(
        await f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" }),
      ),
    ).toMatchObject({ status: "idle", current: null, queue: [] });
  });

  it("does not let obsolete-head discovery reject the replacement queue", async () => {
    const f = fixture();
    const thirdHandle = "00000000-0000-4000-8000-000000000003";
    const initial: PlaybackDiscovery = {
      ...discovery,
      candidates: [
        ...discovery.candidates,
        { id: "101:503", courseId: "101", title: "Third" },
      ],
    };
    const ids = new Map([
      [handles[0], "101:501"],
      [handles[1], "101:502"],
      [thirdHandle, "101:503"],
    ]);
    vi.spyOn(f.ports, "resolveBatch").mockImplementation(async (requested) => ({
      discovery: initial,
      items: requested.map((handle) => ({
        id: ids.get(handle)!,
        courseId: "101",
      })),
    }));
    await f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
      handles: [handles[0], handles[1], thirdHandle],
    });
    const authorization = await f.runtime.authorize(address);
    if (!authorization) throw new Error("not authorized");
    await f.runtime.signal(address, authorization.binding, "playing");

    const nextDiscovery = deferred<PlaybackDiscovery>();
    const discovering = deferred<void>();
    vi.spyOn(f.ports, "discover").mockImplementation(async () => {
      discovering.resolve();
      return nextDiscovery.promise;
    });
    const ended = f.runtime.signal(address, authorization.binding, "ended");
    await discovering.promise;
    const cancelled = f.runtime.command({
      version: 1,
      type: "PLAYBACK_CANCEL",
      id: "101:502",
    });
    nextDiscovery.resolve({
      ...initial,
      candidates: initial.candidates.filter(({ id }) => id !== "101:502"),
    });

    expect(await ended).toBe(true);
    expect(await cancelled).toMatchObject({ status: "success" });
    expect(f.opened).toEqual([
      `${origin}/courses/101/modules/items/501`,
      `${origin}/courses/101/modules/items/503`,
    ]);
    expect(
      snapshot(
        await f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" }),
      ),
    ).toMatchObject({
      status: "starting",
      current: { id: "101:503", courseId: "101" },
    });
  });

  it("does not launch a cancelled retained-resume head after held discovery", async () => {
    const f = fixture();
    f.saved = {
      ...emptyPlayback(accountKey, origin),
      playlist: [{ id: "101:502", courseId: "101" }],
      stopped: true,
    };
    const nextDiscovery = deferred<PlaybackDiscovery>();
    const discovering = deferred<void>();
    vi.spyOn(f.ports, "bind").mockImplementationOnce(async (onSelected) => {
      onSelected(7);
      discovering.resolve();
      return {
        discovery: await nextDiscovery.promise,
        source: {
          sourceTabId: 7,
          documentToken: "00000000-0000-4000-8000-000000000099",
        },
      };
    });

    const resume = f.runtime.command({ version: 1, type: "PLAYBACK_RESUME" });
    await discovering.promise;
    await f.runtime.command({
      version: 1,
      type: "PLAYBACK_CANCEL",
      id: "101:502",
    });
    nextDiscovery.resolve(discovery);

    expect(await resume).toMatchObject({ status: "success" });
    expect(f.opened).toEqual([]);
    expect(f.saved?.playlist).toEqual([]);
    expect(
      snapshot(
        await f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" }),
      ),
    ).toMatchObject({ status: "idle", current: null, queue: [] });
  });

  it("settles an ended final item to an idle persisted state", async () => {
    const f = fixture();
    const started = snapshot(
      await f.runtime.command({
        version: 1,
        type: "PLAYBACK_START",
        sourceTabId: 7,
        documentToken: "00000000-0000-4000-8000-000000000099",
        handles: [handles[0]],
      }),
    );
    expect(started.current?.id).toBe("101:501");
    const authorization = await f.runtime.authorize(address);
    if (!authorization) throw new Error("not authorized");
    await f.runtime.signal(address, authorization.binding, "playing");
    expect(
      await f.runtime.signal(address, authorization.binding, "ended"),
    ).toBe(true);

    expect(f.saved).toMatchObject({
      playlist: [],
      stopped: true,
      player: null,
    });
    expect(f.runtime.sourceTabId).toBeNull();
    expect(
      snapshot(
        await f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" }),
      ),
    ).toMatchObject({ status: "idle", current: null, queue: [] });
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

  it("keeps an already-paused owned adapter across repeated inactive-tab pauses", async () => {
    const f = fixture();
    await playing(f);
    await f.runtime.command({ version: 1, type: "PLAYBACK_PAUSE" });
    expect(
      snapshot(await f.runtime.command({ version: 1, type: "PLAYBACK_PAUSE" }))
        .status,
    ).toBe("paused");
    expect(f.controls).toEqual(["pause"]);
    expect(f.runtime.dedicatedTabId).toBe(9);
    expect(f.closed).toEqual([]);
  });

  it("issues a fresh bounded authorization when resuming a long-dormant owned adapter", async () => {
    const f = fixture();
    const original = await playing(f);
    await f.runtime.command({ version: 1, type: "PLAYBACK_PAUSE" });
    const dormantNow = original.deadline + 60000;
    f.now = dormantNow;

    expect(
      snapshot(await f.runtime.command({ version: 1, type: "PLAYBACK_RESUME" }))
        .status,
    ).toBe("playing");
    const resumed = f.controlAuthorizations.at(-1)!;
    expect(resumed.binding).toMatchObject({
      runId: original.runId,
      token: original.token,
    });
    expect(resumed.binding.deadline).toBe(dormantNow + 70000);
    expect(resumed.leaseUntil).toBe(dormantNow + 60000);
    expect(f.opened).toHaveLength(1);
    expect(f.closed).toEqual([]);
  });

  it("does not let a lease pending at pause re-arm or close the dormant run", async () => {
    const f = fixture();
    const binding = await playing(f);
    const renewal = deferred<PlaybackDiscovery>();
    const renewing = deferred<void>();
    vi.spyOn(f.ports, "discover").mockImplementationOnce(async () => {
      renewing.resolve();
      return renewal.promise;
    });
    const lease = f.runtime.lease(address, binding);
    await renewing.promise;

    expect(
      snapshot(await f.runtime.command({ version: 1, type: "PLAYBACK_PAUSE" }))
        .status,
    ).toBe("paused");
    renewal.resolve(discovery);
    expect(await lease).toBeNull();
    expect(f.runtime.dedicatedTabId).toBe(9);
    expect(f.closed).toEqual([]);
    expect(f.alarms.size).toBe(0);
  });

  it("acknowledges a superseded native pause for the retained run without reviving its lease", async () => {
    const f = fixture();
    const binding = await playing(f);
    const alarmEntered = deferred<void>();
    const releaseAlarm = deferred<void>();
    const alarm = f.ports.alarm;
    vi.spyOn(f.ports, "alarm").mockImplementation(async (name, when) => {
      if (when !== null) {
        alarmEntered.resolve();
        await releaseAlarm.promise;
      }
      await alarm(name, when);
    });

    const lease = f.runtime.lease(address, binding);
    await alarmEntered.promise;
    const nativePause = f.runtime.signal(address, binding, "paused");
    const pause = f.runtime.command({ version: 1, type: "PLAYBACK_PAUSE" });
    releaseAlarm.resolve();

    expect(await lease).toBeNull();
    expect(await nativePause).toBe(true);
    expect(snapshot(await pause).status).toBe("paused");
    expect(f.runtime.dedicatedTabId).toBe(9);
    expect(f.closed).toEqual([]);
    expect(f.alarms.size).toBe(0);

    expect(
      snapshot(await f.runtime.command({ version: 1, type: "PLAYBACK_RESUME" }))
        .status,
    ).toBe("playing");
    expect(f.runtime.dedicatedTabId).toBe(9);
    expect(f.controls).toEqual(["pause", "resume"]);
    expect(f.closed).toEqual([]);
  });

  it("does not grant a pending lease after the source document is replaced", async () => {
    const f = fixture();
    const binding = await playing(f);
    const renewal = deferred<PlaybackDiscovery>();
    const renewing = deferred<void>();
    vi.spyOn(f.ports, "discover").mockImplementationOnce(async () => {
      renewing.resolve();
      return renewal.promise;
    });
    const lease = f.runtime.lease(address, binding);
    await renewing.promise;
    const lost = f.runtime.sourceLost(7);
    renewal.resolve(discovery);
    await lost;
    expect(await lease).toBeNull();
    expect(f.runtime.dedicatedTabId).toBeNull();
    expect(f.alarms.size).toBe(0);
  });

  it.each(["resolve", "reject"] as const)(
    "invalidates a pending lease when a bound native pause arrives, then ignores its late %s",
    async (settlement) => {
      const f = fixture();
      const binding = await playing(f);
      const renewal = deferred<PlaybackDiscovery>();
      const renewing = deferred<void>();
      vi.spyOn(f.ports, "discover").mockImplementationOnce(async () => {
        renewing.resolve();
        return renewal.promise;
      });
      const lease = f.runtime.lease(address, binding);
      await renewing.promise;

      expect(await f.runtime.signal(address, binding, "paused")).toBe(true);
      expect(f.saved).toMatchObject({ stopped: true });
      expect(f.runtime.dedicatedTabId).toBe(9);
      expect(f.alarms.size).toBe(0);
      if (settlement === "resolve") renewal.resolve(discovery);
      else renewal.reject(new PlaybackRuntimeError("LOGIN_REQUIRED"));

      expect(await lease).toBeNull();
      expect(f.runtime.dedicatedTabId).toBe(9);
      expect(f.closed).toEqual([]);
      expect(f.alarms.size).toBe(0);
      expect(
        snapshot(
          await f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" }),
        ).status,
      ).toBe("paused");
    },
  );

  it("does not let a queued paused signal from an old binding cancel a replacement run", async () => {
    const f = fixture();
    const oldBinding = await playing(f);
    await f.runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" });
    vi.spyOn(f.ports, "resolveBatch").mockResolvedValue({
      discovery,
      items: [{ id: "101:502", courseId: "101" }],
    });
    await f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
      handles: [handles[1]],
    });
    const replacement = await f.runtime.authorize(address);
    if (!replacement) throw new Error("replacement not authorized");

    expect(await f.runtime.signal(address, oldBinding, "paused")).toBe(false);
    expect(
      await f.runtime.signal(address, replacement.binding, "playing"),
    ).toBe(true);
    expect(
      snapshot(
        await f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" }),
      ),
    ).toMatchObject({ status: "playing", current: { id: "101:502" } });
    expect(f.runtime.dedicatedTabId).toBe(9);
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
    const bind = vi.spyOn(f.ports, "bind");
    expect(
      snapshot(await restarted.command({ version: 1, type: "PLAYBACK_RESUME" }))
        .status,
    ).toBe("starting");
    expect(bind).toHaveBeenCalledOnce();
    expect(f.opened).toHaveLength(2);
    expect(restarted.sourceTabId).toBe(7);
    const discover = vi.spyOn(f.ports, "discover");
    expect(await restarted.authorize(address)).not.toBeNull();
    expect(discover).toHaveBeenCalledExactlyOnceWith({
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
    });
  });

  it("rejects a restarted playlist rebound to another account without launching", async () => {
    const f = fixture();
    f.saved = {
      ...emptyPlayback(accountKey, origin),
      playlist: [{ id: "101:501", courseId: "101" }],
      stopped: true,
    };
    vi.spyOn(f.ports, "bind").mockImplementation(async (onSelected) => {
      onSelected(8);
      return {
        discovery: { ...discovery, accountKey: "b".repeat(64) },
        source: {
          sourceTabId: 8,
          documentToken: "00000000-0000-4000-8000-000000000098",
        },
      };
    });
    const restarted = new PlaybackRuntime(f.ports);
    await restarted.startup();
    expect(
      await restarted.command({ version: 1, type: "PLAYBACK_RESUME" }),
    ).toEqual({ status: "error", code: "ACCOUNT_CHANGED" });
    expect(f.opened).toEqual([]);
    expect(f.saved).toBeNull();
  });

  it("ignores an old run's alarm after a replacement starts", async () => {
    const f = fixture();
    await playing(f);
    const oldAlarm = watchdogName(f);

    const replacement = snapshot(
      await f.runtime.command({
        version: 1,
        type: "PLAYBACK_START",
        sourceTabId: 7,
        documentToken: "00000000-0000-4000-8000-000000000099",
        handles: [handles[1]],
      }),
    );
    const newAlarm = watchdogName(f);
    expect(newAlarm).not.toBe(oldAlarm);
    expect(replacement).toMatchObject({
      status: "starting",
      current: { id: "101:502" },
    });

    expect(await f.runtime.alarm(oldAlarm)).toMatchObject({
      status: "success",
      snapshot: { status: "starting", current: { id: "101:502" } },
    });
    expect(f.runtime.dedicatedTabId).toBe(9);
    expect(f.saved?.stopped).toBe(false);
  });

  it("ignores an old renewal alarm for the same run", async () => {
    const f = fixture();
    const binding = await playing(f);
    const oldAlarm = watchdogName(f);
    expect(await f.runtime.lease(address, binding)).not.toBeNull();
    expect(watchdogName(f)).not.toBe(oldAlarm);

    expect(await f.runtime.alarm(oldAlarm)).toMatchObject({
      status: "success",
      snapshot: { status: "playing" },
    });
    expect(f.saved?.stopped).toBe(false);
    expect(f.closed).toEqual([]);
  });

  it("stops after the current watchdog expires without dropping the playlist", async () => {
    const f = fixture();
    await playing(f);
    expect(await f.runtime.alarm(watchdogName(f))).toEqual({
      status: "error",
      code: "PLAYER_LOST",
    });
    expect(f.saved?.playlist).toHaveLength(2);
    expect(f.saved?.stopped).toBe(true);
  });

  it.each([
    ["pause", { version: 1, type: "PLAYBACK_PAUSE" } as const, "paused"],
    ["stop", { version: 1, type: "PLAYBACK_STOP_ALL" } as const, "stopped"],
    ["delete", { version: 1, type: "LOCAL_DATA_DELETE_ALL" } as const, "idle"],
  ])("ignores a stale watchdog after %s", async (_name, command, status) => {
    const f = fixture();
    await playing(f);
    const staleAlarm = watchdogName(f);
    await f.runtime.command(command);

    expect(await f.runtime.alarm(staleAlarm)).toMatchObject({
      status: "success",
      snapshot: { status },
    });
  });

  it("clears legacy and abandoned watchdog names during startup", async () => {
    const f = fixture();
    f.alarms.set(PLAYBACK_WATCHDOG, 1);
    f.alarms.set(`${PLAYBACK_WATCHDOG}:abandoned`, 2);
    f.alarms.set("unrelated", 3);

    expect(await f.runtime.startup()).toMatchObject({ status: "success" });
    expect([...f.alarms]).toEqual([["unrelated", 3]]);
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
