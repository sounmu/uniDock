import { afterEach, expect, it, vi } from "vitest";

vi.mock("wxt/utils/define-background", () => ({
  defineBackground: (main: () => void) => ({ main }),
}));

import background, {
  createChromePlaybackRuntime,
} from "../entrypoints/background";
import { CaptionJobMonitor } from "../src/captions/job-monitor";
import { CaptionMediaRules } from "../src/captions/referer-rule";
import { CAPTION_TRANSCRIPT_CACHE_KEY } from "../src/captions/transcript-cache";
import { CaptionWorkHost } from "../src/captions/work-host";
import { CAPTION_WORK_PORT } from "../src/captions/work-protocol";
import { CAPTION_SESSION_EPOCH_KEY } from "../src/caption-server-settings";
import { PlaybackRuntime } from "../src/playback/runtime";
import { emptyPlayback, PLAYBACK_STORAGE_KEY } from "../src/playback/storage";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("rejects analytics messages from content scripts and accepts only the exact extension panel", async () => {
  const addListener = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener },
    },
    action: actionMocks(),
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
  background.main();
  const listener = addListener.mock.calls[0]![0];
  const respond = vi.fn();
  for (const url of [
    "https://mylms.korea.ac.kr/",
    "https://kucom.korea.ac.kr/em/test",
    "chrome-extension://other/sidepanel.html",
    "chrome-extension://test/privacy.html",
  ]) {
    expect(
      listener(
        { version: 1, type: "ANALYTICS_SET", enabled: false },
        { id: "test", url },
        respond,
      ),
    ).toBe(false);
    expect(respond).toHaveBeenLastCalledWith({ ok: false });
  }
  expect(chrome.storage.local.set).not.toHaveBeenCalled();
  const result = await new Promise((resolve) => {
    expect(
      listener(
        { version: 1, type: "ANALYTICS_STATUS" },
        { id: "test", url: "chrome-extension://test/sidepanel.html" },
        resolve,
      ),
    ).toBe(true);
  });
  // Development builds never report; the setting itself still materializes.
  expect(result).toEqual({
    available: false,
    enabled: true,
    notice: "changed",
  });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

it("registers Chrome install events to badge upgrades and reconnect open LMS tabs", async () => {
  const installed = vi.fn();
  const create = vi.fn();
  const executeScript = vi.fn().mockResolvedValue([]);
  const action = {
    ...actionMocks(),
    getBadgeText: vi.fn().mockResolvedValue(""),
  };
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: () => ({ version: "0.1.2" }),
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onInstalled: { addListener: installed },
      onMessage: { addListener: vi.fn() },
    },
    tabs: {
      create,
      query: vi
        .fn()
        .mockResolvedValue([
          { id: 7, status: "complete", url: "https://mylms.korea.ac.kr/" },
        ]),
      sendMessage: vi.fn().mockRejectedValue(new Error("no receiver")),
    },
    scripting: { executeScript },
    action,
  });
  background.main();
  // The update badge/reinjection listener, then the statistics migration.
  expect(installed).toHaveBeenCalledTimes(2);
  const listener = installed.mock.calls[0]![0];
  listener({ reason: "update", previousVersion: "0.1.1" });
  await vi.waitFor(() =>
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: "NEW" }),
  );
  await vi.waitFor(() =>
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["content-scripts/lms.js"],
    }),
  );
  expect(create).not.toHaveBeenCalled();
});

it("spends the update badge only for the extension panel", async () => {
  const addListener = vi.fn();
  const action = {
    ...actionMocks(),
    getBadgeText: vi.fn().mockResolvedValue("NEW"),
  };
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener },
    },
    action,
  });
  background.main();
  const listener = addListener.mock.calls[0]![0];
  const message = { version: 1, type: "UPDATE_NOTICE_TAKE" };
  const respond = vi.fn();
  expect(
    listener(
      message,
      { id: "test", url: "https://mylms.korea.ac.kr/" },
      respond,
    ),
  ).toBe(false);
  expect(respond).toHaveBeenLastCalledWith({ updated: false });
  expect(
    listener(
      message,
      { id: "test", url: "chrome-extension://test/sidepanel.html" },
      respond,
    ),
  ).toBe(true);
  await vi.waitFor(() =>
    expect(respond).toHaveBeenLastCalledWith({ updated: true }),
  );
  expect(action.setBadgeText).toHaveBeenCalledWith({ text: "" });
});

function actionMocks() {
  const setPopup = vi.fn().mockResolvedValue(undefined);
  const setBadgeText = vi.fn().mockResolvedValue(undefined);
  const getBadgeText = vi.fn().mockResolvedValue("!");
  const setBadgeBackgroundColor = vi.fn().mockResolvedValue(undefined);
  let configured!: () => void;
  const done = new Promise<void>((resolve) => {
    configured = resolve;
  });
  const setTitle = vi.fn(async () => {
    configured();
  });
  return {
    setPopup,
    setBadgeText,
    getBadgeText,
    setBadgeBackgroundColor,
    setTitle,
    done,
  };
}

it("opens the sidepanel page as a popup when the side panel API is unavailable", async () => {
  const action = actionMocks();
  vi.stubGlobal("chrome", {
    runtime: { onMessage: { addListener: vi.fn() } },
    action,
  });

  expect(() => background.main()).not.toThrow();
  await action.done;
  expect(action.setPopup).toHaveBeenCalledWith({ popup: "sidepanel.html" });
  expect(action.setBadgeText).toHaveBeenCalledWith({ text: "!" });
  expect(action.setTitle).toHaveBeenCalledWith({
    title: "uniDock — 사이드 패널 대신 팝업으로 엽니다",
  });
});

it("falls back to the popup when side panel setup is rejected", async () => {
  const action = actionMocks();
  vi.stubGlobal("chrome", {
    runtime: { onMessage: { addListener: vi.fn() } },
    sidePanel: {
      setPanelBehavior: vi.fn().mockRejectedValue(new Error("disabled")),
    },
    action,
  });

  background.main();

  await action.done;
  expect(action.setPopup).toHaveBeenCalledWith({ popup: "sidepanel.html" });
  expect(action.setBadgeText).toHaveBeenCalledWith({ text: "!" });
});

it("restores direct side panel opening after support becomes available", async () => {
  const action = actionMocks();
  const setPanelBehavior = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("chrome", {
    runtime: { onMessage: { addListener: vi.fn() } },
    sidePanel: { setPanelBehavior },
    action,
  });

  background.main();

  await action.done;
  expect(action.setPopup).toHaveBeenCalledWith({ popup: "" });
  expect(setPanelBehavior).toHaveBeenCalledWith({
    openPanelOnActionClick: true,
  });
  await vi.waitFor(() =>
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: "" }),
  );
  expect(action.setTitle).toHaveBeenCalledWith({ title: "uniDock 열기" });
});

it("keeps an unseen update badge when side panel setup runs on worker boot", async () => {
  const action = actionMocks();
  action.getBadgeText.mockResolvedValue("NEW");
  vi.stubGlobal("chrome", {
    runtime: { onMessage: { addListener: vi.fn() } },
    sidePanel: { setPanelBehavior: vi.fn().mockResolvedValue(undefined) },
    action,
  });
  background.main();
  await action.done;
  await vi.waitFor(() => expect(action.getBadgeText).toHaveBeenCalled());
  await Promise.resolve();
  expect(action.setBadgeText).not.toHaveBeenCalled();
});

it.each([
  {
    label: "unowned LMS tab",
    owned: false,
    target: "canonical",
    revoked: false,
  },
  { label: "owned LMS item", owned: true, target: "canonical", revoked: true },
  {
    label: "changed item route",
    owned: true,
    target: "wrong-item",
    revoked: false,
  },
  { label: "foreign origin", owned: true, target: "foreign", revoked: false },
  { label: "tab without a URL", owned: true, target: "no-url", revoked: false },
  { label: "verified KU player", owned: true, target: "player", revoked: true },
  { label: "staged blank tab", owned: true, target: "blank", revoked: true },
  {
    label: "already removed tab",
    owned: true,
    target: "missing",
    revoked: false,
  },
])(
  "requires verified session ownership and document for $label",
  async ({ owned, target, revoked }) => {
    const accountKey = "a".repeat(64),
      origin = "https://mylms.korea.ac.kr";
    const saved = emptyPlayback(accountKey, origin);
    saved.playlist = [{ id: "101:501", courseId: "101" }];
    saved.player = { tabId: 9, courseId: "101", id: "101:501" };
    const remove = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const local: Record<string, unknown> = { [PLAYBACK_STORAGE_KEY]: saved };
    const session = owned
      ? {
          "unidock.playback.owned-tab": {
            tabId: 9,
            courseId: "101",
            itemId: "501",
          },
        }
      : {};
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async () => local,
          set: async (values: Record<string, unknown>) =>
            Object.assign(local, values),
          remove: vi.fn(),
          setAccessLevel: vi.fn(),
        },
        session: { get: async () => session, remove: vi.fn() },
      },
      tabs: {
        query: async () => [{ id: 1, active: true, url: `${origin}/` }],
        get: async (id: number) => {
          if (target === "missing" && id === 9) throw new Error("removed");
          const url =
            id !== 9
              ? `${origin}/`
              : target === "no-url"
                ? undefined
                : target === "wrong-item"
                  ? `${origin}/courses/101/modules/items/502`
                  : target === "foreign"
                    ? "https://evil.example/em/native"
                    : target === "player"
                      ? "https://kucom.korea.ac.kr/em/native"
                      : target === "blank"
                        ? "about:blank"
                        : `${origin}/courses/101/modules/items/501`;
          return { id, url };
        },
        remove,
        sendMessage,
      },
      alarms: { clear: vi.fn(), create: vi.fn() },
    });
    const result = await createChromePlaybackRuntime().startup();
    expect(result.status).toBe("success");
    expect(remove).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(revoked ? 1 : 0);
    if (revoked)
      expect(sendMessage).toHaveBeenCalledWith(
        9,
        { version: 1, type: "PLAYBACK_PLAYER_REVOKE" },
        {},
      );
    if (result.status === "success")
      expect(result.snapshot.status).toBe("paused");
  },
);

it("rejects LMS-tab playback commands even when they copy the extension id", async () => {
  const action = actionMocks(),
    addListener = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener },
    },
    action,
  });
  background.main();
  const respond = vi.fn(),
    listener = addListener.mock.calls[0]?.[0];
  listener(
    { version: 1, type: "PLAYBACK_STOP_ALL" },
    { id: "test", url: "https://mylms.korea.ac.kr/", tab: { id: 1 } },
    respond,
  );
  expect(respond).toHaveBeenCalledWith({ status: "error", code: "POLICY" });
  respond.mockClear();
  listener(
    { version: 1, type: "PLAYBACK_STATUS" },
    {
      id: "test",
      url: "chrome-extension://test/sidepanel.html",
      tab: { id: 2, url: "chrome-extension://test/sidepanel.html" },
    },
    respond,
  );
  expect(respond).toHaveBeenCalledWith({
    status: "error",
    code: "UNAVAILABLE",
  });
});

it("accepts playback commands only from the panel and refuses forged player documents", async () => {
  const action = actionMocks();
  let receive!: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (value: unknown) => void,
  ) => boolean;
  const local = new Map<string, unknown>();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test-extension",
      getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: {
        addListener: (listener: typeof receive) => {
          receive = listener;
        },
      },
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
    },
    action,
    sidePanel: {
      setPanelBehavior: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      local: {
        get: async () => Object.fromEntries(local),
        set: async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values))
            local.set(key, value);
        },
        remove: async (key: string) => {
          local.delete(key);
        },
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      session: {
        get: async () => ({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      onRemoved: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    alarms: {
      clear: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue(undefined),
      onAlarm: { addListener: vi.fn() },
    },
  });
  background.main();
  const deliver = (message: unknown, sender: chrome.runtime.MessageSender) =>
    new Promise<unknown>((resolve) => {
      expect(receive(message, sender, resolve)).toBe(true);
    });
  const panel = {
    id: "test-extension",
    url: "chrome-extension://test-extension/sidepanel.html",
  };
  const noLms = await deliver({ version: 1, type: "PLAYBACK_REFRESH" }, panel);
  expect(noLms).toEqual({ status: "error", code: "OPEN_LMS" });
  const forged = await deliver(
    { version: 1, type: "PLAYBACK_PLAYER_HELLO" },
    {
      id: "test-extension",
      url: "https://kucom.korea.ac.kr/em/fake",
      frameId: 1,
      documentId: "forged-document",
      tab: { id: 17 } as chrome.tabs.Tab,
    },
  );
  expect(forged).toEqual({ ok: false });
  expect(chrome.tabs.get).not.toHaveBeenCalled();
});

function commandBroadcastFixture() {
  let receive!: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (value: unknown) => void,
  ) => boolean;
  vi.spyOn(PlaybackRuntime.prototype, "startup").mockReturnValue(
    new Promise(() => {}),
  );
  const command = vi.spyOn(PlaybackRuntime.prototype, "command");
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const onStartup = vi.fn<(listener: () => void) => void>();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test-extension",
      getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      sendMessage,
      onMessage: {
        addListener: (listener: typeof receive) => {
          receive = listener;
        },
      },
      onConnect: { addListener: vi.fn() },
      onStartup: { addListener: onStartup },
      onInstalled: { addListener: vi.fn() },
    },
    action: actionMocks(),
    sidePanel: { setPanelBehavior: vi.fn().mockResolvedValue(undefined) },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      onRemoved: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    alarms: {
      clear: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue(undefined),
      onAlarm: { addListener: vi.fn() },
    },
  });
  background.main();
  return {
    command,
    sendMessage,
    onStartup,
    receive,
    panel: {
      id: "test-extension",
      url: "chrome-extension://test-extension/sidepanel.html",
    } as chrome.runtime.MessageSender,
  };
}

it("broadcasts settled mutating commands without delaying their reply and never broadcasts STATUS", async () => {
  const f = commandBroadcastFixture();
  const result = { status: "error", code: "STORAGE" } as const;
  f.command.mockResolvedValue(result);
  const order: string[] = [];
  f.sendMessage.mockImplementation(() => {
    order.push("notify");
    throw new Error("no receiving panel");
  });
  const deliver = (type: "PLAYBACK_STATUS" | "PLAYBACK_REFRESH") =>
    new Promise<unknown>((resolve) => {
      expect(
        f.receive({ version: 1, type }, f.panel, (value) => {
          order.push("reply");
          resolve(value);
        }),
      ).toBe(true);
    });

  expect(await deliver("PLAYBACK_STATUS")).toEqual(result);
  expect(f.sendMessage).not.toHaveBeenCalled();
  expect(await deliver("PLAYBACK_REFRESH")).toEqual(result);
  expect(order).toEqual(["reply", "reply", "notify"]);
  expect(f.sendMessage).toHaveBeenCalledWith({
    version: 1,
    type: "PLAYBACK_UPDATED",
  });
});

it("shows the state a failed playback command left behind in progress", async () => {
  const f = commandBroadcastFixture();
  const blocked = { courses: [], labels: {}, queue: [], status: "blocked-login", current: null };
  f.command.mockImplementation(async (message) =>
    (message.type === "PLAYBACK_STATUS"
      ? { status: "success", snapshot: blocked }
      : { status: "error", code: "LOGIN_REQUIRED" }) as never,
  );
  const deliver = (type: string) =>
    new Promise<unknown>((resolve) => f.receive({ version: 1, type }, f.panel, resolve));
  await deliver("PLAYBACK_REFRESH");
  await f.command.mock.results.at(-1)?.value;
  await Promise.resolve();
  expect(await deliver("PROGRESS_GET")).toMatchObject({
    items: [{ kind: "playback", status: "blocked-login" }],
  });
});

it("resumes saved caption jobs on browser startup even without their alarm", () => {
  const resume = vi.spyOn(CaptionJobMonitor.prototype, "resume").mockResolvedValue();
  const f = commandBroadcastFixture();
  expect(resume).not.toHaveBeenCalled();
  for (const [listener] of f.onStartup.mock.calls) listener();
  expect(resume).toHaveBeenCalledOnce();
});

function panelPortFixture() {
  const connect = vi.fn<(listener: (port: chrome.runtime.Port) => void) => void>();
  const attached =
    vi.fn<(listener: (tabId: number, info: { newWindowId: number }) => void) => void>();
  const tabMessage = vi.fn().mockResolvedValue(undefined);
  const lms = { id: 3, url: "https://mylms.korea.ac.kr/", windowId: 7 };
  const query = vi.fn().mockResolvedValue([lms]);
  const get = vi.fn().mockResolvedValue(lms);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener: vi.fn() },
      onConnect: { addListener: connect },
    },
    action: actionMocks(),
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      query,
      get,
      sendMessage: tabMessage,
      onUpdated: { addListener: vi.fn() },
      onAttached: { addListener: attached },
    },
  });
  background.main();
  return {
    tabMessage,
    attached,
    /** Resolves after the worker acted on every tab lookup it has started. */
    looked: () =>
      Promise.all([...query.mock.results, ...get.mock.results].map((result) => result.value)),
    open(name: string, url: string) {
      const port = {
        name,
        sender: { id: "test", url },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
      };
      for (const [listener] of connect.mock.calls)
        listener(port as unknown as chrome.runtime.Port);
      return port;
    },
  };
}

it("hides the LMS pill in the window of a connected panel page and refuses the port to other pages", async () => {
  const f = panelPortFixture();
  const nothing = { version: 1, type: "PROGRESS_STATE", items: [] };

  const forged = f.open("unidock-panel:7", "https://mylms.korea.ac.kr/");
  expect(forged.disconnect).toHaveBeenCalledOnce();
  expect(forged.postMessage).not.toHaveBeenCalled();
  const unrelated = f.open("unidock-other", "chrome-extension://test/sidepanel.html");
  expect(unrelated.disconnect).not.toHaveBeenCalled();
  await f.looked();
  expect(f.tabMessage).not.toHaveBeenCalled();

  const panel = f.open("unidock-panel:7", "chrome-extension://test/sidepanel.html");
  expect(panel.disconnect).not.toHaveBeenCalled();
  expect(panel.postMessage).toHaveBeenCalledWith({ type: "ready" });
  await f.looked();
  expect(f.tabMessage.mock.calls).toEqual([[3, nothing, { frameId: 0 }]]);

  f.tabMessage.mockClear();
  for (const [listener] of f.attached.mock.calls) listener(3, { newWindowId: 7 });
  await f.looked();
  expect(f.tabMessage.mock.calls).toEqual([[3, nothing, { frameId: 0 }]]);
});

it("does not broadcast rejected playback messages", () => {
  const f = commandBroadcastFixture();
  const respond = vi.fn();
  expect(
    f.receive(
      { version: 1, type: "PLAYBACK_STOP_ALL", extra: true },
      f.panel,
      respond,
    ),
  ).toBe(false);
  expect(
    f.receive(
      { version: 1, type: "PLAYBACK_STOP_ALL" },
      { id: "test-extension", url: "https://mylms.korea.ac.kr/" },
      respond,
    ),
  ).toBe(false);
  expect(respond).toHaveBeenCalledWith({ status: "error", code: "POLICY" });
  expect(f.command).not.toHaveBeenCalled();
  expect(f.sendMessage).not.toHaveBeenCalled();
});

it("discards unsent statistics and the popup opt-in before the existing clear-data command and restores the on/off choice", async () => {
  const f = commandBroadcastFixture();
  f.command.mockResolvedValue({ status: "error", code: "STORAGE" });
  const order: string[] = [];
  vi.mocked(chrome.storage.local.remove).mockImplementation(
    async (key: string | string[]) => {
      order.push(`erase:${String(key)}`);
    },
  );
  f.command.mockImplementation(async (message) => {
    // The status read that refreshes progress afterwards is not part of the order.
    if (message.type !== "PLAYBACK_STATUS") order.push("playback");
    return { status: "error", code: "STORAGE" };
  });
  await new Promise((resolve) => {
    expect(
      f.receive(
        { version: 1, type: "LOCAL_DATA_DELETE_ALL" },
        f.panel,
        resolve,
      ),
    ).toBe(true);
  });
  expect(order).toEqual([
    "erase:unidock.analytics.v2,unidock.analytics-counters.v1,unidock.analytics.v1",
    "erase:unidock.popup-auto-close.v1,unidock.video-captions.v1",
    "erase:unidock.caption-session.v1,unidock.caption-install-salt.v1,unidock.caption-active-job.v1,unidock.caption-transcripts.v1",
    "playback",
  ]);
});

it("does not publish a new caption epoch until pending cache writes are erased", async () => {
  const {
    CAPTION_TRANSCRIPT_CACHE_KEY: cacheKey,
    readCaptionCacheEpoch,
    saveCachedTranscript,
  } = await import("../src/captions/transcript-cache");
  const f = commandBroadcastFixture();
  f.command.mockResolvedValue({
    status: "success",
    snapshot: {
      courses: [],
      labels: {},
      queue: [],
      status: "idle",
      current: null,
    },
  });
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let holdRead = true;
  let cacheRemoved = false;
  vi.mocked(chrome.storage.local.get).mockImplementation(async (name) => {
    if (name === cacheKey && holdRead) {
      holdRead = false;
      started.resolve();
      await release.promise;
    }
    return { ...local };
  });
  vi.mocked(chrome.storage.local.set).mockImplementation(async (patch) => {
    Object.assign(local, patch);
  });
  vi.mocked(chrome.storage.local.remove).mockImplementation(async (names) => {
    for (const name of typeof names === "string" ? [names] : names) {
      delete local[name];
      if (name === cacheKey) cacheRemoved = true;
    }
  });
  vi.mocked(chrome.storage.session.get).mockImplementation(async () => ({
    ...session,
  }));
  vi.mocked(chrome.storage.session.set).mockImplementation(async (patch) => {
    Object.assign(session, patch);
  });
  const epoch = await readCaptionCacheEpoch();
  const value = {
    items: [{ index: 0, time: "00:00", text: "삭제할 자막" }],
    engine: "whisper",
    modelRevision: "r1",
    extractedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const saving = saveCachedTranscript(
    `unidock-${"1".repeat(40)}`,
    value,
    epoch,
  );
  await started.promise;
  const deleting = new Promise((resolve) => {
    f.receive({ version: 1, type: "LOCAL_DATA_DELETE_ALL" }, f.panel, resolve);
  });
  await vi.waitFor(async () => {
    const snapshot = await navigator.locks.query();
    expect(
      snapshot.pending?.some((lock) => lock.name === "unidock-caption-cache"),
    ).toBe(true);
  });
  const capturing = readCaptionCacheEpoch().then((nextEpoch) => {
    expect(cacheRemoved).toBe(true);
    return nextEpoch;
  });
  const lateSave = saveCachedTranscript(
    `unidock-${"2".repeat(40)}`,
    value,
    epoch,
  );
  release.resolve();
  const [, , nextEpoch] = await Promise.all([
    saving,
    deleting,
    capturing,
    lateSave,
  ]);
  expect(nextEpoch).not.toBe(epoch);
  expect(local[cacheKey]).toBeUndefined();
});

function popupFixture(
  local: Record<string, unknown> = {},
  // Present only when a test exercises the optional grant and registration.
  grant?: { granted: boolean; registered: boolean },
) {
  let receive!: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (value: unknown) => void,
  ) => boolean;
  let changed!: (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => void;
  const get = vi.fn(async () => local);
  const query = vi.fn().mockResolvedValue([{ id: 3 }]);
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const order: string[] = [];
  let removed: (() => void) | undefined;
  const scripting = {
    getRegisteredContentScripts: vi.fn(async () =>
      grant?.registered ? [{ id: "unidock-lms-popup" }] : [],
    ),
    registerContentScripts: vi.fn(async () => {
      order.push("register");
    }),
    unregisterContentScripts: vi.fn(async () => {
      order.push("unregister");
    }),
    executeScript: vi.fn(async () => {
      order.push("inject");
      return [];
    }),
  };
  const permissions = {
    contains: vi.fn(async () => grant?.granted ?? false),
    remove: vi.fn(async () => {
      order.push("return-grant");
      return true;
    }),
    onRemoved: {
      addListener: (listener: () => void) => {
        removed = listener;
      },
    },
  };
  sendMessage.mockImplementation(async () => {
    order.push("notify");
  });
  const remove = vi.fn(async () => {
    order.push("reset");
  });
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: {
        addListener: (listener: typeof receive) => {
          receive = listener;
        },
      },
    },
    action: actionMocks(),
    storage: {
      local: {
        get,
        remove,
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: {
        addListener: (listener: typeof changed) => {
          changed = listener;
        },
      },
    },
    tabs: { query, sendMessage },
    ...(grant ? { scripting, permissions } : {}),
  });
  background.main();
  return {
    get,
    query,
    sendMessage,
    remove,
    scripting,
    permissions,
    order,
    revoked: () => removed?.(),
    receive,
    changed,
    page: {
      id: "test",
      frameId: 0,
      tab: { id: 3 } as chrome.tabs.Tab,
      url: "https://lms.korea.ac.kr/main",
      origin: "https://lms.korea.ac.kr",
    } as chrome.runtime.MessageSender,
  };
}

it("answers the popup content script with only the stored boolean", async () => {
  const f = popupFixture({
    "unidock.popup-auto-close.v1": true,
    "unidock.analytics.v1": { choice: "granted" },
  });
  const reply = await new Promise((resolve) => {
    expect(
      f.receive({ version: 1, type: "POPUP_AUTO_CLOSE_GET" }, f.page, resolve),
    ).toBe(true);
  });
  expect(reply).toEqual({
    version: 1,
    type: "POPUP_AUTO_CLOSE_STATE",
    enabled: true,
  });
  expect(f.get).toHaveBeenCalledWith("unidock.popup-auto-close.v1");
});

it("refuses popup setting reads from other pages, frames, and extensions", () => {
  const f = popupFixture({ "unidock.popup-auto-close.v1": true });
  const respond = vi.fn();
  for (const sender of [
    { ...f.page, url: "https://mylms.korea.ac.kr/" },
    { ...f.page, frameId: 2 },
    { ...f.page, id: "other" },
    { id: "test", url: "chrome-extension://test/sidepanel.html" },
  ])
    expect(
      f.receive(
        { version: 1, type: "POPUP_AUTO_CLOSE_GET" },
        sender as chrome.runtime.MessageSender,
        respond,
      ),
    ).toBe(false);
  expect(respond.mock.calls).toEqual(Array(4).fill([{ ok: false }]));
  expect(
    f.receive(
      { version: 1, type: "POPUP_AUTO_CLOSE_GET", key: "x" },
      f.page,
      respond,
    ),
  ).toBe(false);
  expect(respond).toHaveBeenCalledTimes(4);
  expect(f.get).not.toHaveBeenCalled();
});

it("reports a popup setting read failure without exposing the error", async () => {
  const f = popupFixture();
  f.get.mockRejectedValueOnce(new Error("storage detail"));
  const reply = await new Promise((resolve) => {
    f.receive({ version: 1, type: "POPUP_AUTO_CLOSE_GET" }, f.page, resolve);
  });
  expect(reply).toEqual({ ok: false });
});

it("tells open portal pages to reread when the opt-in ends and leaves the grant to the panel", async () => {
  const f = popupFixture({}, { granted: true, registered: true });
  // Startup: no opt-in, so the leftover registration goes; the grant stays.
  await vi.waitFor(() => expect(f.order).toEqual(["unregister"]));
  f.order.length = 0;
  f.changed({ "unidock.analytics.v1": { newValue: {} } }, "local");
  f.changed({ "unidock.popup-auto-close.v1": { newValue: true } }, "sync");
  await Promise.resolve();
  expect(f.query).not.toHaveBeenCalled();
  // clear() and remove() report the key with no newValue: pages reread OFF.
  f.changed({ "unidock.popup-auto-close.v1": { oldValue: true } }, "local");
  await vi.waitFor(() => expect(f.order).toEqual(["unregister", "notify"]));
  expect(f.sendMessage).toHaveBeenCalledWith(
    3,
    { version: 1, type: "POPUP_AUTO_CLOSE_CHANGED" },
    { frameId: 0 },
  );
  expect(f.query).toHaveBeenCalledWith({ url: ["https://lms.korea.ac.kr/*"] });
  // The panel returns the grant after saving OFF; a late worker task must not.
  expect(f.permissions.remove).not.toHaveBeenCalled();
  expect(f.scripting.executeScript).not.toHaveBeenCalled();
});

it("registers the portal script only with the opt-in and its optional grant, and covers open tabs", async () => {
  const f = popupFixture(
    { "unidock.popup-auto-close.v1": true },
    { granted: true, registered: false },
  );
  await vi.waitFor(() => expect(f.order).toEqual(["register"]));
  expect(f.scripting.registerContentScripts).toHaveBeenCalledWith([
    {
      id: "unidock-lms-popup",
      matches: ["https://lms.korea.ac.kr/*"],
      js: ["content-scripts/lms-popup.js"],
      runAt: "document_idle",
      allFrames: false,
      persistAcrossSessions: true,
    },
  ]);
  f.order.length = 0;
  f.scripting.getRegisteredContentScripts.mockResolvedValue([
    { id: "unidock-lms-popup" },
  ] as never);
  f.changed({ "unidock.popup-auto-close.v1": { newValue: true } }, "local");
  // Running pages reread first; open tabs get the script without a reload.
  await vi.waitFor(() => expect(f.order).toEqual(["notify", "inject"]));
  expect(f.scripting.executeScript).toHaveBeenCalledWith({
    target: { tabId: 3, frameIds: [0] },
    files: ["content-scripts/lms-popup.js"],
  });
  expect(f.permissions.remove).not.toHaveBeenCalled();
});

it("resets an opt-in whose optional grant is gone and never registers without it", async () => {
  const f = popupFixture(
    { "unidock.popup-auto-close.v1": true },
    { granted: false, registered: false },
  );
  await vi.waitFor(() => expect(f.order).toEqual(["reset"]));
  expect(f.remove).toHaveBeenCalledWith("unidock.popup-auto-close.v1");
  expect(f.scripting.registerContentScripts).not.toHaveBeenCalled();
  // Revoked later in chrome://extensions: the same check runs again.
  f.order.length = 0;
  f.revoked();
  await vi.waitFor(() => expect(f.order).toEqual(["reset"]));
});

// One shared state behind storage, permissions and scripting, so a slow
// background task and a newer panel action can interleave as in Chrome.
function statefulPopupChrome(local: Record<string, unknown>, granted: boolean) {
  const state = { local, granted, registered: false };
  let changed!: (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => void;
  const notified = deferred<void>();
  const notify = vi.fn(() => notified.promise);
  const removeGrant = vi.fn(async () => {
    order.push("return-grant");
    state.granted = false;
    return true;
  });
  let receive!: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (value: unknown) => void,
  ) => boolean;
  const order: string[] = [];
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: {
        addListener: (listener: typeof receive) => {
          receive = listener;
        },
      },
    },
    action: actionMocks(),
    storage: {
      local: {
        get: vi.fn(async () => ({ ...state.local })),
        clear: vi.fn(async () => {
          order.push("clear");
          for (const key of Object.keys(state.local)) delete state.local[key];
        }),
        remove: vi.fn(async (key: string) => {
          delete state.local[key];
        }),
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: {
        addListener: (listener: typeof changed) => {
          changed = listener;
        },
      },
    },
    tabs: { query: vi.fn(async () => [{ id: 3 }]), sendMessage: notify },
    permissions: {
      contains: vi.fn(async () => state.granted),
      remove: removeGrant,
      onRemoved: { addListener: () => {} },
    },
    scripting: {
      getRegisteredContentScripts: vi.fn(async () =>
        state.registered ? [{ id: "unidock-lms-popup" }] : [],
      ),
      registerContentScripts: vi.fn(async () => {
        state.registered = true;
      }),
      unregisterContentScripts: vi.fn(async () => {
        state.registered = false;
      }),
      executeScript: vi.fn(async () => []),
    },
  });
  background.main();
  return {
    state,
    notified,
    removeGrant,
    order,
    deleteAll: () =>
      new Promise((resolve) =>
        receive(
          { version: 1, type: "LOCAL_DATA_DELETE_ALL" },
          {
            id: "test",
            url: "chrome-extension://test/sidepanel.html",
          } as chrome.runtime.MessageSender,
          resolve,
        ),
      ),
    // What the panel does when the user writes the opt-in.
    write(value: boolean) {
      const oldValue = state.local["unidock.popup-auto-close.v1"];
      state.local["unidock.popup-auto-close.v1"] = value;
      changed(
        { "unidock.popup-auto-close.v1": { oldValue, newValue: value } },
        "local",
      );
    },
  };
}

it("never lets a slow OFF task return a grant the newer ON still uses", async () => {
  const f = statefulPopupChrome({ "unidock.popup-auto-close.v1": true }, true);
  await vi.waitFor(() => expect(f.state.registered).toBe(true));
  // OFF: the worker is still telling an open portal tab when ON arrives.
  f.write(false);
  await vi.waitFor(() => expect(f.state.registered).toBe(false));
  // ON: the grant is still there, so the panel's request needs no prompt.
  f.write(true);
  f.notified.resolve();
  await vi.waitFor(() => expect(f.state.registered).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.removeGrant).not.toHaveBeenCalled();
  expect(f.state).toEqual({
    local: { "unidock.popup-auto-close.v1": true },
    granted: true,
    registered: true,
  });
});

it("clears the opt-in, then returns its grant, before answering local-data deletion", async () => {
  const f = statefulPopupChrome({ "unidock.popup-auto-close.v1": true }, true);
  await vi.waitFor(() => expect(f.state.registered).toBe(true));
  expect(await f.deleteAll()).toEqual({ status: "success" });
  expect(f.order).toEqual(["clear", "return-grant"]);
  expect(f.state.granted).toBe(false);
  expect(f.state.local).toEqual({});
});

function activationListenerFixture(
  get: (tabId: number) => Promise<chrome.tabs.Tab>,
) {
  const activated: Array<(activeInfo: { tabId: number; windowId: number }) => void> = [];
  let dedicatedTabId: number | null = 9;
  vi.spyOn(PlaybackRuntime.prototype, "startup").mockReturnValue(
    new Promise(() => {}),
  );
  const command = vi
    .spyOn(PlaybackRuntime.prototype, "command")
    .mockResolvedValue({ status: "error", code: "PLAYER_LOST" });
  vi.spyOn(
    PlaybackRuntime.prototype,
    "dedicatedTabId",
    "get",
  ).mockImplementation(() => dedicatedTabId);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test-extension",
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
    },
    action: actionMocks(),
    sidePanel: { setPanelBehavior: vi.fn().mockResolvedValue(undefined) },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      get: vi.fn(get),
      onRemoved: { addListener: vi.fn() },
      onActivated: {
        addListener: (listener: (activeInfo: { tabId: number; windowId: number }) => void) => {
          activated.push(listener);
        },
      },
      onUpdated: { addListener: vi.fn() },
    },
    alarms: {
      clear: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue(undefined),
      getAll: vi.fn().mockResolvedValue([]),
      onAlarm: { addListener: vi.fn() },
    },
  });
  background.main();
  command.mockClear();
  return {
    activate(tabId: number, windowId: number) {
      for (const listener of activated) listener({ tabId, windowId });
    },
    command,
    replaceDedicated(tabId: number | null) {
      dedicatedTabId = tabId;
    },
  };
}

it("keeps playback running when another tab makes the dedicated tab inactive", async () => {
  let active = true;
  const get = vi.fn(
    async () => ({ id: 9, windowId: 3, active }) as chrome.tabs.Tab,
  );
  const fixture = activationListenerFixture(get);

  fixture.activate(20, 4);
  await Promise.resolve();
  await Promise.resolve();
  expect(fixture.command).not.toHaveBeenCalled();

  fixture.activate(21, 3);
  await Promise.resolve();
  await Promise.resolve();
  expect(fixture.command).not.toHaveBeenCalled();

  active = false;
  fixture.activate(22, 3);
  await Promise.resolve();
  await Promise.resolve();
  expect(fixture.command).not.toHaveBeenCalled();
});

it("ignores a dedicated-tab lookup failure", async () => {
  const get = vi
    .fn<(tabId: number) => Promise<chrome.tabs.Tab>>()
    .mockRejectedValue(new Error("removed"));
  const fixture = activationListenerFixture(get);

  fixture.activate(20, 3);
  await Promise.resolve();
  await Promise.resolve();
  expect(fixture.command).not.toHaveBeenCalled();
});

it("ignores a lookup response after the dedicated tab is replaced", async () => {
  const lookup = deferred<chrome.tabs.Tab>();
  const fixture = activationListenerFixture(() => lookup.promise);

  fixture.activate(20, 3);
  fixture.replaceDedicated(10);
  lookup.resolve({ id: 9, windowId: 3, active: false } as chrome.tabs.Tab);
  await lookup.promise;
  await Promise.resolve();

  expect(fixture.command).not.toHaveBeenCalled();
});

it("ignores a stale lookup response after the dedicated tab is reactivated", async () => {
  const lookup = deferred<chrome.tabs.Tab>();
  const fixture = activationListenerFixture(() => lookup.promise);

  fixture.activate(20, 3);
  fixture.activate(9, 3);
  lookup.resolve({ id: 9, windowId: 3, active: false } as chrome.tabs.Tab);
  await lookup.promise;
  await Promise.resolve();

  expect(fixture.command).not.toHaveBeenCalled();
});

function playbackAdapterFixture({
  response,
  tabUrl = "https://mylms.korea.ac.kr/",
  changedUrl,
}: {
  response: unknown;
  tabUrl?: string | null;
  changedUrl?: string;
}) {
  const values: Record<string, unknown> = {};
  const sendMessage = vi.fn().mockResolvedValue(
    response !== null &&
      typeof response === "object" &&
      "status" in response &&
      response.status === "success" &&
      "discovery" in response &&
      !("items" in response)
      ? {
          ...response,
          documentToken: "00000000-0000-4000-8000-000000000099",
        }
      : response,
  );
  const tabs = tabUrl ? [{ id: 7, url: tabUrl, active: true }] : [];
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: values[key] }),
        set: async (next: Record<string, unknown>) =>
          Object.assign(values, next),
        remove: async (key: string) => {
          delete values[key];
        },
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      session: {
        get: async () => ({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue(tabs),
      get: vi.fn().mockResolvedValue({ id: 7, url: changedUrl ?? tabUrl }),
      sendMessage,
      remove: vi.fn().mockResolvedValue(undefined),
    },
    alarms: {
      clear: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue(undefined),
    },
  });
  return { runtime: createChromePlaybackRuntime(), sendMessage, values };
}

const validDiscovery = {
  accountKey: "a".repeat(64),
  origin: "https://mylms.korea.ac.kr",
  courses: [{ id: "101", name: "Synthetic Course" }],
  candidates: [],
};

it("keeps overlapping created-tab ownership isolated through late cleanup", async () => {
  const candidates = [
    { id: "101:501", courseId: "101", title: "First" },
    { id: "101:502", courseId: "101", title: "Second" },
  ];
  const discovery = { ...validDiscovery, candidates };
  const firstHandle = "00000000-0000-4000-8000-000000000001";
  const secondHandle = "00000000-0000-4000-8000-000000000002";
  const firstCreate = deferred<chrome.tabs.Tab>();
  const creating = deferred<void>();
  let creates = 0;
  const removed: number[] = [];
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: local[key] }),
        set: async (values: Record<string, unknown>) =>
          Object.assign(local, values),
        remove: async (key: string) => {
          delete local[key];
        },
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      session: {
        get: async (key: string) => ({ [key]: session[key] }),
        set: async (values: Record<string, unknown>) =>
          Object.assign(session, values),
        remove: async (key: string) => {
          delete session[key];
        },
      },
    },
    tabs: {
      query: vi
        .fn()
        .mockResolvedValue([
          { id: 7, url: "https://mylms.korea.ac.kr/", active: true },
        ]),
      get: vi.fn(async (tabId: number) =>
        tabId === 7
          ? { id: 7, url: "https://mylms.korea.ac.kr/", active: true }
          : { id: tabId, url: "about:blank", active: true },
      ),
      sendMessage: vi.fn(
        async (
          _tabId: number,
          message: { type: string; handles?: string[] },
        ) => {
          if (message.type === "PLAYBACK_DISCOVER")
            return { status: "success", discovery };
          const id =
            message.handles?.[0] === firstHandle ? "101:501" : "101:502";
          return {
            status: "success",
            discovery,
            items: [{ id, courseId: "101" }],
          };
        },
      ),
      create: vi.fn(async () => {
        creates++;
        if (creates === 1) {
          creating.resolve();
          return firstCreate.promise;
        }
        return { id: 10, url: "about:blank" };
      }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn(async (tabId: number) => {
        removed.push(tabId);
      }),
    },
    alarms: {
      clear: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue(undefined),
      getAll: vi.fn().mockResolvedValue([]),
    },
  });
  const runtime = createChromePlaybackRuntime();
  const oldStart = runtime.command({
    version: 1,
    type: "PLAYBACK_START",
    sourceTabId: 7,
    documentToken: "00000000-0000-4000-8000-000000000099",
    handles: [firstHandle],
  });
  await creating.promise;
  await runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" });
  expect(
    await runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
      handles: [secondHandle],
    }),
  ).toMatchObject({ status: "success" });

  firstCreate.resolve({ id: 9, url: "about:blank" } as chrome.tabs.Tab);
  expect(await oldStart).toEqual({ status: "error", code: "BUSY" });
  expect(removed).toEqual([]);
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
    9,
    { version: 1, type: "PLAYBACK_PLAYER_REVOKE" },
    {},
  );
  expect(session["unidock.playback.owned-tab"]).toEqual({
    version: 1,
    tabs: { "10": { courseId: "101", itemId: "502" } },
  });

  await runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" });
  expect(removed).toEqual([]);
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
    10,
    { version: 1, type: "PLAYBACK_PLAYER_REVOKE" },
    {},
  );
  expect(session).not.toHaveProperty("unidock.playback.owned-tab");
});

it("revokes a pending created tab without closing it after local deletion", async () => {
  const discovery = {
    ...validDiscovery,
    candidates: [{ id: "101:501", courseId: "101", title: "First" }],
  };
  const handle = "00000000-0000-4000-8000-000000000001";
  const registration = deferred<void>();
  const releaseRegistration = deferred<void>();
  const removed: number[] = [];
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: local[key] }),
        set: async (values: Record<string, unknown>) =>
          Object.assign(local, values),
        remove: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys])
            delete local[key];
        },
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      session: {
        get: async (key: string) => ({ [key]: session[key] }),
        set: async (values: Record<string, unknown>) => {
          Object.assign(session, values);
          registration.resolve();
          await releaseRegistration.promise;
        },
        remove: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys])
            delete session[key];
        },
      },
    },
    tabs: {
      query: vi
        .fn()
        .mockResolvedValue([
          { id: 7, url: "https://mylms.korea.ac.kr/", active: true },
        ]),
      get: vi.fn(async (tabId: number) =>
        tabId === 7
          ? { id: 7, url: "https://mylms.korea.ac.kr/", active: true }
          : { id: tabId, url: "about:blank", active: true },
      ),
      sendMessage: vi.fn(async () => ({
        status: "success",
        discovery,
        items: [{ id: "101:501", courseId: "101" }],
      })),
      create: vi.fn().mockResolvedValue({ id: 9, url: "about:blank" }),
      update: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn(async (tabId: number) => {
        removed.push(tabId);
      }),
    },
    alarms: {
      clear: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue(undefined),
      getAll: vi.fn().mockResolvedValue([]),
    },
  });
  const runtime = createChromePlaybackRuntime();
  const start = runtime.command({
    version: 1,
    type: "PLAYBACK_START",
    sourceTabId: 7,
    documentToken: "00000000-0000-4000-8000-000000000099",
    handles: [handle],
  });
  await registration.promise;
  expect(session).toHaveProperty("unidock.playback.owned-tab");

  expect(
    await runtime.command({ version: 1, type: "LOCAL_DATA_DELETE_ALL" }),
  ).toMatchObject({ status: "success", snapshot: { status: "idle" } });
  expect(session).not.toHaveProperty("unidock.playback.owned-tab");
  releaseRegistration.resolve();

  expect(await start).toEqual({ status: "error", code: "BUSY" });
  expect(removed).toEqual([]);
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
    9,
    { version: 1, type: "PLAYBACK_PLAYER_REVOKE" },
    {},
  );
  expect(session).not.toHaveProperty("unidock.playback.owned-tab");
});

it("projects only a bounded top-frame discovery without persisting data while OFF", async () => {
  const f = playbackAdapterFixture({
    response: { status: "success", discovery: validDiscovery },
  });
  const result = await f.runtime.command({
    version: 1,
    type: "PLAYBACK_REFRESH",
  });
  expect(result.status).toBe("success");
  if (result.status !== "success") throw new Error(result.code);
  expect(result.snapshot.courses).toEqual(validDiscovery.courses);
  expect(result.snapshot.current).toBeNull();
  expect(f.sendMessage).toHaveBeenCalledOnce();
  const [tabId, message, options] = f.sendMessage.mock.calls[0]!;
  expect(tabId).toBe(7);
  expect(message).toEqual({
    version: 1,
    type: "PLAYBACK_DISCOVER",
    salt: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(options).toEqual({ frameId: 0 });
  expect(f.values).not.toHaveProperty(PLAYBACK_STORAGE_KEY);
});

it("does not retain an unverified source across independent refreshes", async () => {
  const f = playbackAdapterFixture({
    response: { status: "success", discovery: validDiscovery },
  });
  expect(
    await f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" }),
  ).toMatchObject({ status: "success" });
  expect(
    await f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" }),
  ).toMatchObject({ status: "success" });
  expect(chrome.tabs.query).toHaveBeenCalledTimes(2);
  expect(f.sendMessage).toHaveBeenCalledTimes(2);
});

it("resolves selection in its listing document and revalidates in the player tab", async () => {
  const handle = "00000000-0000-4000-8000-000000000001";
  const documentToken = "00000000-0000-4000-8000-000000000099";
  const discovery = {
    ...validDiscovery,
    candidates: [{ id: "101:501", courseId: "101", title: "Lecture" }],
  };
  const f = playbackAdapterFixture({
    response: {
      status: "success",
      discovery,
      items: [{ id: "101:501", courseId: "101" }],
    },
  });
  chrome.tabs.query = vi
    .fn()
    .mockResolvedValue([
      { id: 9, url: "https://mylms.korea.ac.kr/", active: true },
    ]);
  chrome.tabs.get = vi.fn(async (tabId: number) =>
    tabId === 8
      ? { id: 8, url: "https://mylms.korea.ac.kr/", active: false }
      : { id: tabId, url: "about:blank", active: true },
  ) as unknown as typeof chrome.tabs.get;
  chrome.tabs.create = vi
    .fn()
    .mockResolvedValue({ id: 10, url: "about:blank" });
  chrome.tabs.update = vi.fn().mockResolvedValue(undefined);

  expect(
    await f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles: [handle],
      sourceTabId: 8,
      documentToken,
    }),
  ).toMatchObject({ status: "success" });
  expect(chrome.tabs.query).not.toHaveBeenCalled();
  expect(f.sendMessage).toHaveBeenCalledWith(
    8,
    {
      version: 1,
      type: "PLAYBACK_RESOLVE_BATCH",
      handles: [handle],
      salt: expect.stringMatching(/^[a-f0-9]{64}$/),
      documentToken,
    },
    { frameId: 0 },
  );

  f.sendMessage.mockResolvedValue({
    status: "success",
    discovery,
    documentToken,
  });
  chrome.tabs.get = vi.fn().mockResolvedValue({
    id: 10,
    url: "https://mylms.korea.ac.kr/courses/101/modules/items/501",
    active: true,
  });
  await f.runtime.sourceLost(8);
  expect(
    await f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" }),
  ).toMatchObject({ status: "success" });
  expect(f.sendMessage).toHaveBeenLastCalledWith(
    10,
    {
      version: 1,
      type: "PLAYBACK_DISCOVER",
      salt: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
    { frameId: 0 },
  );
  expect(chrome.tabs.query).not.toHaveBeenCalled();

  expect(
    await f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles: ["00000000-0000-4000-8000-000000000002"],
      sourceTabId: 10,
      documentToken,
    }),
  ).toEqual({ status: "error", code: "RELOAD_TAB" });
  expect(chrome.tabs.query).not.toHaveBeenCalled();
});

it("opens the next selected lecture after its last old LMS document closes during release", async () => {
  const discovery = {
    ...validDiscovery,
    candidates: [
      { id: "101:501", courseId: "101", title: "First" },
      { id: "101:502", courseId: "101", title: "Second" },
    ],
  };
  const f = playbackAdapterFixture({ response: null });
  const tabs = new Map([[7, "https://mylms.korea.ac.kr/"]]);
  let nextTabId = 9;
  chrome.tabs.query = vi
    .fn()
    .mockImplementation(async () =>
      [...tabs].map(([id, url]) => ({ id, url, active: true })),
    );
  chrome.tabs.get = vi.fn().mockImplementation(async (id: number) => {
    const url = tabs.get(id);
    if (!url) throw new Error("closed tab");
    return { id, url, active: true };
  });
  chrome.tabs.create = vi.fn().mockImplementation(async () => {
    const id = nextTabId++;
    tabs.set(id, "about:blank");
    return { id };
  });
  chrome.tabs.update = vi
    .fn()
    .mockImplementation(async (id: number, change: { url: string }) => {
      tabs.set(id, change.url);
    });
  f.sendMessage.mockImplementation(
    async (id: number, message: { type: string }) => {
      if (message.type === "PLAYBACK_PLAYER_REVOKE") {
        tabs.delete(id);
        return { ok: true };
      }
      if (!tabs.has(id)) throw new Error("closed receiver");
      return {
        status: "success",
        discovery,
        ...(message.type === "PLAYBACK_RESOLVE_BATCH"
          ? {
              items: discovery.candidates.map(({ id, courseId }) => ({
                id,
                courseId,
              })),
            }
          : { documentToken: "00000000-0000-4000-8000-000000000099" }),
      };
    },
  );
  expect(
    await f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles: [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ],
      sourceTabId: 7,
      documentToken: "00000000-0000-4000-8000-000000000099",
    }),
  ).toMatchObject({ status: "success" });
  const address = { tabId: 9, frameId: 2, documentId: "first" };
  const first = await f.runtime.authorize(address);
  if (!first) throw new Error("missing first authorization");
  await f.runtime.signal(address, first.binding, "playing");
  tabs.delete(7);
  await f.runtime.sourceLost(7);
  await f.runtime.signal(address, first.binding, "ended");
  expect(f.runtime.dedicatedTabId).toBe(10);
  expect(tabs.get(10)).toBe(
    "https://mylms.korea.ac.kr/courses/101/modules/items/502",
  );
  const next = await f.runtime.authorize({
    tabId: 10,
    frameId: 2,
    documentId: "next",
  });
  expect(next).not.toBeNull();
});

it("invalidates an adapter resolution when the source reloads at the same URL", async () => {
  const handle = "00000000-0000-4000-8000-000000000001";
  const documentToken = "00000000-0000-4000-8000-000000000099";
  const discovery = {
    ...validDiscovery,
    candidates: [{ id: "101:501", courseId: "101", title: "Lecture" }],
  };
  const f = playbackAdapterFixture({
    response: {
      status: "success",
      discovery,
      items: [{ id: "101:501", courseId: "101" }],
    },
  });
  const postReply = deferred<chrome.tabs.Tab>();
  let gets = 0;
  chrome.tabs.get = vi.fn(async () => {
    gets++;
    if (gets === 1)
      return { id: 8, url: "https://mylms.korea.ac.kr/" } as chrome.tabs.Tab;
    return postReply.promise;
  }) as unknown as typeof chrome.tabs.get;
  const start = f.runtime.command({
    version: 1,
    type: "PLAYBACK_START",
    handles: [handle],
    sourceTabId: 8,
    documentToken,
  });
  await vi.waitFor(() => expect(gets).toBe(2));
  const invalidated = f.runtime.sourceLost(8);
  postReply.resolve({
    id: 8,
    url: "https://mylms.korea.ac.kr/",
  } as chrome.tabs.Tab);
  await invalidated;
  expect(await start).toEqual({ status: "error", code: "BUSY" });
  expect(chrome.tabs.query).not.toHaveBeenCalled();
});

it("does not search another LMS tab when the listing tab has closed", async () => {
  const f = playbackAdapterFixture({
    response: { status: "success", discovery: validDiscovery },
  });
  chrome.tabs.get = vi.fn().mockRejectedValue(new Error("closed"));
  expect(
    await f.runtime.command({
      version: 1,
      type: "PLAYBACK_START",
      handles: ["00000000-0000-4000-8000-000000000001"],
      sourceTabId: 8,
      documentToken: "00000000-0000-4000-8000-000000000099",
    }),
  ).toEqual({ status: "error", code: "RELOAD_TAB" });
  expect(chrome.tabs.query).not.toHaveBeenCalled();
  expect(f.sendMessage).not.toHaveBeenCalled();
});

it("rediscovers an inactive LMS tab when the in-memory source pointer is absent", async () => {
  const f = playbackAdapterFixture({
    response: { status: "success", discovery: validDiscovery },
  });
  chrome.tabs.query = vi.fn(async () => [
    { id: 7, url: "https://mylms.korea.ac.kr/", active: false },
  ]) as unknown as typeof chrome.tabs.query;
  expect(
    await f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" }),
  ).toMatchObject({ status: "success" });
  expect(chrome.tabs.query).toHaveBeenCalledWith({
    url: ["https://mylms.korea.ac.kr/*", "https://canvas.korea.ac.kr/*"],
  });
  expect(f.sendMessage).toHaveBeenCalledOnce();
});

it.each([
  {
    name: "missing LMS tab",
    tabUrl: null,
    response: { status: "success", discovery: validDiscovery },
    code: "OPEN_LMS",
  },
  {
    name: "navigation after a successful read",
    changedUrl: "https://mylms.korea.ac.kr/courses/101",
    response: { status: "success", discovery: validDiscovery },
    code: "RELOAD_TAB",
  },
  {
    name: "login expiry reported by the content script",
    response: { status: "error", code: "LOGIN_REQUIRED" },
    code: "LOGIN_REQUIRED",
  },
  {
    name: "forged discovery origin",
    response: {
      status: "success",
      discovery: { ...validDiscovery, origin: "https://evil.example" },
    },
    code: "INVALID_RESPONSE",
  },
  {
    name: "malformed response",
    response: { status: "success", discovery: { courses: [] } },
    code: "INVALID_RESPONSE",
  },
])(
  "rejects $name without accepting a playback target",
  async ({ tabUrl, changedUrl, response, code }) => {
    const f = playbackAdapterFixture({ response, tabUrl, changedUrl });
    expect(
      await f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" }),
    ).toEqual({ status: "error", code });
    expect(f.values).not.toHaveProperty(PLAYBACK_STORAGE_KEY);
  },
);

function tabLifecycleFixture(saved: unknown, coldStart = false) {
  const listeners = {
    removed: [] as ((tabId: number) => void)[],
    updated: [] as ((
      tabId: number,
      change: { status?: string; url?: string },
      tab: chrome.tabs.Tab,
    ) => void)[],
  };
  const local: Record<string, unknown> = { [PLAYBACK_STORAGE_KEY]: saved };
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  // A cold start leaves initialization to the first tab event, as after a worker wake-up.
  if (coldStart)
    vi.spyOn(PlaybackRuntime.prototype, "startup").mockReturnValue(
      new Promise(() => {}),
    );
  const lost = vi.spyOn(PlaybackRuntime.prototype, "lost");
  const sourceLost = vi.spyOn(PlaybackRuntime.prototype, "sourceLost");
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test-extension",
      sendMessage,
      onMessage: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
    },
    action: actionMocks(),
    sidePanel: { setPanelBehavior: vi.fn().mockResolvedValue(undefined) },
    storage: {
      local: {
        get: async (key: string | string[]) =>
          Object.fromEntries(
            [key].flat().map((name) => [name, local[name]]),
          ),
        set: async (next: Record<string, unknown>) =>
          Object.assign(local, next),
        remove: vi.fn().mockResolvedValue(undefined),
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      get: vi.fn().mockRejectedValue(new Error("gone")),
      query: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
      onRemoved: {
        addListener: (listener: (tabId: number) => void) =>
          listeners.removed.push(listener),
      },
      onActivated: { addListener: vi.fn() },
      onUpdated: {
        addListener: (listener: (typeof listeners.updated)[number]) =>
          listeners.updated.push(listener),
      },
    },
    alarms: {
      clear: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue(undefined),
      getAll: vi.fn().mockResolvedValue([]),
      onAlarm: { addListener: vi.fn() },
    },
  });
  background.main();
  const notifications = () =>
    sendMessage.mock.calls.filter(
      ([message]) => message?.type === "PLAYBACK_UPDATED",
    ).length;
  return {
    local,
    notifications,
    async ready() {
      await vi.waitFor(() => expect(notifications()).toBe(1));
      sendMessage.mockClear();
      lost.mockClear();
      sourceLost.mockClear();
    },
    async settle() {
      await Promise.all(
        [...lost.mock.results, ...sourceLost.mock.results].map(
          (result) => result.value as Promise<unknown>,
        ),
      );
      await new Promise((resolve) => setImmediate(resolve));
    },
    remove: (tabId: number) => listeners.removed.forEach((l) => l(tabId)),
    update: (tabId: number, change: { status?: string; url?: string }) =>
      listeners.updated.forEach((l) => l(tabId, change, { id: tabId } as chrome.tabs.Tab)),
  };
}

const savedPlayer = {
  ...emptyPlayback("a".repeat(64), "https://mylms.korea.ac.kr"),
  playlist: [{ id: "101:501", courseId: "101" }],
  player: { tabId: 9, id: "101:501", courseId: "101" },
  stopped: false,
};

it("sends no playback notification for unrelated tab loading and removal bursts", async () => {
  const f = tabLifecycleFixture(savedPlayer);
  await f.ready();

  for (let tabId = 100; tabId < 120; tabId++) {
    f.update(tabId, { status: "loading" });
    f.remove(tabId + 100);
  }
  await f.settle();

  expect(f.notifications()).toBe(0);
  expect((f.local[PLAYBACK_STORAGE_KEY] as typeof savedPlayer).player).toEqual(
    savedPlayer.player,
  );
});

it("still notifies once when the first event after a cold start recovers the saved player", async () => {
  const f = tabLifecycleFixture(savedPlayer, true);

  f.remove(9);
  await f.settle();

  expect(f.notifications()).toBe(1);
  expect(
    (f.local[PLAYBACK_STORAGE_KEY] as typeof savedPlayer).player,
  ).toBeNull();
});

const captionPanel = { id: "test", url: "chrome-extension://test/sidepanel.html" };
const captionCues = [{ start: 1000, end: 2000, text: "첫 자막" }];
const captionForward = (cues: readonly unknown[]) => ({
  version: 1,
  type: "PLAYBACK_CAPTION_FORWARD",
  tabId: 7,
  documentId: "player",
  cues,
});
const playerTrack = (cues: readonly unknown[]) => [
  7,
  { version: 1, type: "PLAYBACK_CAPTION_TRACK", cues },
  { documentId: "player" },
];
function videoCaptionFixture() {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const pick =
    (store: Record<string, unknown>) =>
    async (keys?: string | string[] | null) =>
      Object.fromEntries(
        (keys == null ? Object.keys(store) : [keys].flat())
          .filter((key) => key in store)
          .map((key) => [key, store[key]]),
      );
  const onMessage = vi.fn();
  const changed = vi.fn();
  const removed = vi.fn();
  const sendMessage = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener: onMessage },
    },
    action: actionMocks(),
    storage: {
      local: {
        get: pick(local),
        set: async (values: Record<string, unknown>) => {
          Object.assign(local, values);
        },
        remove: vi.fn().mockResolvedValue(undefined),
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      session: {
        get: pick(session),
        set: async (values: Record<string, unknown>) => {
          Object.assign(session, values);
        },
        remove: async (key: string) => {
          delete session[key];
        },
      },
      onChanged: { addListener: changed },
    },
    tabs: { sendMessage, onRemoved: { addListener: removed } },
  });
  // Each boot is a fresh worker over the same storage; only its own listeners fire.
  const boot = () => {
    const from = [onMessage, changed, removed].map((spy) => spy.mock.calls.length);
    background.main();
    const receive = onMessage.mock.calls[from[0]!]![0];
    return {
      forward: (message: unknown, sender: chrome.runtime.MessageSender = captionPanel) =>
        new Promise<unknown>((resolve) => receive(message, sender, resolve)),
      settingOff: () => {
        local["unidock.video-captions.v1"] = false;
        for (const [listener] of changed.mock.calls.slice(from[1]))
          listener({ "unidock.video-captions.v1": { newValue: false } }, "local");
      },
      tabRemoved: (tabId: number) => {
        for (const [listener] of removed.mock.calls.slice(from[2])) listener(tabId, {});
      },
    };
  };
  return { session, sendMessage, boot };
}

it("forwards panel subtitles through the worker and clears them after a restart when the setting goes off", async () => {
  const fixture = videoCaptionFixture();
  const worker = fixture.boot();
  // Given: a page cannot route subtitles; the panel can.
  expect(
    await worker.forward(captionForward(captionCues), {
      id: "test",
      url: "https://mylms.korea.ac.kr/",
    }),
  ).toEqual({ ok: false });
  expect(fixture.sendMessage).not.toHaveBeenCalled();
  expect(await worker.forward(captionForward(captionCues))).toEqual({ ok: true });
  expect(fixture.sendMessage.mock.calls).toEqual([playerTrack(captionCues)]);
  // When: the worker restarts, then the setting goes off.
  const restarted = fixture.boot();
  const cleared = new Promise<unknown[]>((resolve) =>
    fixture.sendMessage.mockImplementationOnce(async (...call: unknown[]) => {
      resolve(call);
      return { ok: true };
    }),
  );
  restarted.settingOff();
  // Then: the restarted worker clears the document it never saw shown.
  expect(await cleared).toEqual(playerTrack([]));
  expect(fixture.session).toEqual({});
  expect(await restarted.forward(captionForward(captionCues))).toEqual({ ok: false });
  expect(fixture.sendMessage).toHaveBeenCalledTimes(2);
});

it("records a document before showing it subtitles and forgets it only after a clear succeeds", async () => {
  const fixture = videoCaptionFixture();
  const worker = fixture.boot();
  // Given: the record cannot be written.
  vi.spyOn(chrome.storage.session, "set").mockRejectedValueOnce(new Error("QUOTA"));
  // Then: nothing reaches the document, so no subtitles are left unrecorded.
  expect(await worker.forward(captionForward(captionCues))).toEqual({ ok: false });
  expect(fixture.sendMessage).not.toHaveBeenCalled();
  expect(await worker.forward(captionForward(captionCues))).toEqual({ ok: true });
  // When: a clear does not reach the document.
  fixture.sendMessage.mockRejectedValueOnce(new Error("GONE"));
  expect(await worker.forward(captionForward([]))).toEqual({ ok: false });
  // Then: the record stays until a clear succeeds.
  expect(fixture.session).toEqual({
    "unidock.video-caption-targets.v1": [{ tabId: 7, documentId: "player" }],
  });
  expect(await worker.forward(captionForward([]))).toEqual({ ok: true });
  expect(fixture.session).toEqual({});
});

it("forgets the subtitles of a closed tab", async () => {
  const fixture = videoCaptionFixture();
  const worker = fixture.boot();
  await worker.forward(captionForward(captionCues));
  expect(fixture.session).toEqual({
    "unidock.video-caption-targets.v1": [{ tabId: 7, documentId: "player" }],
  });
  // When: the tab closes, then the setting goes off.
  worker.tabRemoved(7);
  worker.settingOff();
  // Then: changes run in order, so this refusal settles after both; nothing was sent to the closed tab.
  expect(await worker.forward(captionForward(captionCues))).toEqual({ ok: false });
  expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
  expect(fixture.session).toEqual({});
});

const WORK_RUN = "00000000-0000-4000-8000-000000000001";
const workStart = { version: 1, type: "CAPTION_WORK_START", kind: "single", run: WORK_RUN, tabId: 3 };
const mediaRequest = { version: 1, type: "CAPTION_OFFSCREEN_MEDIA", tabId: 3 };
const panelPage = { id: "test", url: "chrome-extension://test/sidepanel.html" };
const offscreenPage = { id: "test", url: "chrome-extension://test/offscreen.html" };
const otherSenders = [
  { id: "test", url: "https://mylms.korea.ac.kr/", tab: { id: 3 } },
  { id: "test", url: "chrome-extension://test/privacy.html" },
  { id: "other", url: "chrome-extension://other/offscreen.html" },
  { id: "other", url: "chrome-extension://other/sidepanel.html" },
];

function captionWorkFixture({ offscreen = true, sessionRules = [] as { id: number }[] } = {}) {
  const messages = vi.fn();
  const connect = vi.fn<(listener: (port: chrome.runtime.Port) => void) => void>();
  const changed =
    vi.fn<(listener: (changes: Record<string, unknown>, area: string) => void) => void>();
  const updateSessionRules = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(CaptionJobMonitor.prototype, "storageChanged").mockImplementation(() => {});
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener: messages },
      onConnect: { addListener: connect },
    },
    action: actionMocks(),
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: changed },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onUpdated: { addListener: vi.fn() },
    },
    declarativeNetRequest: {
      getSessionRules: vi.fn().mockResolvedValue(sessionRules),
      updateSessionRules,
    },
    ...(offscreen ? { offscreen: { createDocument: vi.fn(), closeDocument: vi.fn() } } : {}),
  });
  background.main();
  const receive = messages.mock.calls[0]![0] as (
    message: unknown,
    sender: unknown,
    respond: (value: unknown) => void,
  ) => boolean;
  return {
    receive,
    updateSessionRules,
    /** Sends a message and resolves with the worker's answer and whether it kept the channel open. */
    ask: async (message: unknown, sender: unknown) => {
      let answered!: (reply: unknown) => void;
      const reply = new Promise<unknown>((resolve) => (answered = resolve));
      const open = receive(message, sender, answered);
      return { reply: await reply, open };
    },
    open(name: string, sender: unknown) {
      const port = {
        name,
        sender,
        postMessage: vi.fn(),
        disconnect: vi.fn(),
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
      };
      for (const [listener] of connect.mock.calls)
        listener(port as unknown as chrome.runtime.Port);
      return port;
    },
    storageChanged(changes: Record<string, unknown>, area: string) {
      for (const [listener] of changed.mock.calls) listener(changes, area);
    },
  };
}

it("takes caption work commands from the panel only and passes the host's answer back", async () => {
  vi.spyOn(CaptionMediaRules.prototype, "sweep").mockResolvedValue();
  const answer = { status: "error", code: "ACTIVE_JOB_EXISTS" } as const;
  const command = vi.spyOn(CaptionWorkHost.prototype, "command").mockResolvedValue(answer);
  const f = captionWorkFixture();
  for (const sender of [...otherSenders, offscreenPage])
    expect(await f.ask(workStart, sender)).toEqual({
      reply: { status: "error", code: "POLICY" },
      open: false,
    });
  expect(command).not.toHaveBeenCalled();

  expect(await f.ask(workStart, panelPage)).toEqual({ reply: answer, open: true });
  expect(command).toHaveBeenCalledExactlyOnceWith(workStart);
  command.mockRejectedValueOnce(new Error("boom"));
  expect((await f.ask(workStart, panelPage)).reply).toEqual({ status: "error", code: "UNKNOWN" });

  // A command with anything extra is not a caption work command at all.
  const respond = vi.fn();
  expect(f.receive({ ...workStart, url: "https://example.com/a.mp4" }, panelPage, respond)).toBe(false);
  expect(respond).not.toHaveBeenCalled();
  expect(command).toHaveBeenCalledTimes(2);
});

it("answers the offscreen document's requests for that document only", async () => {
  vi.spyOn(CaptionMediaRules.prototype, "sweep").mockResolvedValue();
  const pending = { status: "pending" } as const;
  const request = vi.spyOn(CaptionWorkHost.prototype, "request").mockResolvedValue(pending);
  const f = captionWorkFixture();
  for (const sender of [
    ...otherSenders,
    panelPage,
    // The offscreen page opened in a tab is not the offscreen document.
    { ...offscreenPage, tab: { id: 9 } },
  ])
    expect(await f.ask(mediaRequest, sender)).toEqual({
      reply: { status: "error", code: "POLICY" },
      open: false,
    });
  expect(request).not.toHaveBeenCalled();

  expect(await f.ask(mediaRequest, offscreenPage)).toEqual({ reply: pending, open: true });
  expect(request).toHaveBeenCalledExactlyOnceWith(mediaRequest);
  request.mockRejectedValueOnce(new Error("boom"));
  expect((await f.ask(mediaRequest, offscreenPage)).reply).toEqual({
    status: "error",
    code: "UNKNOWN",
  });
});

it("gives the work port to the offscreen document and refuses it to every other page", () => {
  vi.spyOn(CaptionMediaRules.prototype, "sweep").mockResolvedValue();
  const connected = vi.spyOn(CaptionWorkHost.prototype, "connect").mockImplementation(() => {});
  const f = captionWorkFixture();
  for (const sender of [...otherSenders, panelPage]) {
    const forged = f.open(CAPTION_WORK_PORT, sender);
    expect(forged.disconnect).toHaveBeenCalledOnce();
  }
  expect(f.open(CAPTION_WORK_PORT, undefined).disconnect).toHaveBeenCalledOnce();
  expect(connected).not.toHaveBeenCalled();

  const port = f.open(CAPTION_WORK_PORT, offscreenPage);
  expect(port.disconnect).not.toHaveBeenCalled();
  expect(connected).toHaveBeenCalledExactlyOnceWith(port);
});

it("ends caption work when the sign-in changes or local data is deleted, and at nothing else", () => {
  vi.spyOn(CaptionMediaRules.prototype, "sweep").mockResolvedValue();
  const ended = vi.spyOn(CaptionWorkHost.prototype, "sessionEnded").mockImplementation(() => {});
  const f = captionWorkFixture();
  f.storageChanged({ [CAPTION_SESSION_EPOCH_KEY]: { oldValue: "a", newValue: "a" } }, "session");
  f.storageChanged({ [CAPTION_SESSION_EPOCH_KEY]: { oldValue: "a", newValue: "b" } }, "local");
  f.storageChanged({ [CAPTION_TRANSCRIPT_CACHE_KEY]: { oldValue: {}, newValue: {} } }, "local");
  f.storageChanged({ [CAPTION_TRANSCRIPT_CACHE_KEY]: { newValue: {} } }, "local");
  f.storageChanged({ unrelated: { oldValue: 1 } }, "local");
  expect(ended).not.toHaveBeenCalled();

  f.storageChanged({ [CAPTION_SESSION_EPOCH_KEY]: { oldValue: "a", newValue: "b" } }, "session");
  expect(ended).toHaveBeenCalledTimes(1);
  f.storageChanged({ [CAPTION_TRANSCRIPT_CACHE_KEY]: { oldValue: {} } }, "local");
  expect(ended).toHaveBeenCalledTimes(2);
});

it("refuses caption work where the browser has no offscreen documents", async () => {
  vi.spyOn(CaptionMediaRules.prototype, "sweep").mockResolvedValue();
  const f = captionWorkFixture({ offscreen: false });
  expect(await f.ask(workStart, panelPage)).toEqual({
    reply: { status: "error", code: "UNAVAILABLE" },
    open: false,
  });
  expect((await f.ask(mediaRequest, offscreenPage)).reply).toEqual({
    status: "error",
    code: "POLICY",
  });
});

it("removes the Referer rules an earlier worker left, once its document had time to claim them", async () => {
  vi.useFakeTimers();
  try {
    const f = captionWorkFixture({ sessionRules: [{ id: 1_947_005 }, { id: 7 }] });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(chrome.declarativeNetRequest.getSessionRules).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // Only rules in the caption range are this feature's to remove.
    expect(f.updateSessionRules).toHaveBeenCalledExactlyOnceWith({ removeRuleIds: [1_947_005] });
  } finally {
    vi.useRealTimers();
  }
});
