import { afterEach, expect, it, vi } from "vitest";

vi.mock("wxt/utils/define-background", () => ({
  defineBackground: (main: () => void) => ({ main }),
}));

import background, {
  createChromePlaybackRuntime,
} from "../entrypoints/background";
import { emptyPlayback, PLAYBACK_STORAGE_KEY } from "../src/playback/storage";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
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

function actionMocks() {
  const setPopup = vi.fn().mockResolvedValue(undefined);
  const setBadgeText = vi.fn().mockResolvedValue(undefined);
  const setBadgeBackgroundColor = vi.fn().mockResolvedValue(undefined);
  let configured!: () => void;
  const done = new Promise<void>((resolve) => {
    configured = resolve;
  });
  const setTitle = vi.fn(async () => {
    configured();
  });
  return { setPopup, setBadgeText, setBadgeBackgroundColor, setTitle, done };
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
  expect(action.setBadgeText).toHaveBeenCalledWith({ text: "" });
  expect(action.setTitle).toHaveBeenCalledWith({ title: "uniDock 열기" });
});

it.each([
  {
    label: "unowned LMS tab",
    owned: false,
    target: "canonical",
    closed: false,
  },
  { label: "owned LMS item", owned: true, target: "canonical", closed: true },
  {
    label: "changed item route",
    owned: true,
    target: "wrong-item",
    closed: false,
  },
  { label: "foreign origin", owned: true, target: "foreign", closed: false },
  { label: "tab without a URL", owned: true, target: "no-url", closed: false },
  { label: "verified KU player", owned: true, target: "player", closed: true },
  { label: "staged blank tab", owned: true, target: "blank", closed: true },
  {
    label: "already removed tab",
    owned: true,
    target: "missing",
    closed: false,
  },
])(
  "requires verified session ownership and document for $label",
  async ({ owned, target, closed }) => {
    const accountKey = "a".repeat(64),
      origin = "https://mylms.korea.ac.kr";
    const saved = emptyPlayback(accountKey, origin);
    saved.playlist = [{ id: "101:501", courseId: "101" }];
    saved.player = { tabId: 9, courseId: "101", id: "101:501" };
    const remove = vi.fn().mockResolvedValue(undefined);
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
        sendMessage: async () => ({
          status: "success",
          discovery: {
            accountKey,
            origin,
            courses: [{ id: "101", name: "Course" }],
            candidates: [],
          },
        }),
      },
      alarms: { clear: vi.fn(), create: vi.fn() },
    });
    const result = await createChromePlaybackRuntime().startup();
    expect(result.status).toBe("success");
    expect(remove).toHaveBeenCalledTimes(closed ? 1 : 0);
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
      "discovery" in response
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
        async (_tabId: number, message: { type: string; handle?: string }) => {
          if (message.type === "PLAYBACK_DISCOVER")
            return { status: "success", discovery };
          const id = message.handle === firstHandle ? "101:501" : "101:502";
          return {
            status: "success",
            resolved: { discovery, id, courseId: "101" },
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
  expect(removed).toEqual([9]);
  expect(session["unidock.playback.owned-tab"]).toEqual({
    version: 1,
    tabs: { "10": { courseId: "101", itemId: "502" } },
  });

  await runtime.command({ version: 1, type: "PLAYBACK_STOP_ALL" });
  expect(removed).toEqual([9, 10]);
  expect(session).not.toHaveProperty("unidock.playback.owned-tab");
});

it("closes a pending created tab after local deletion erases its stored ownership", async () => {
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
        resolved: { discovery, id: "101:501", courseId: "101" },
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
  expect(removed).toEqual([9]);
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

it("resolves and revalidates a run only through its document-bound listing tab", async () => {
  const handle = "00000000-0000-4000-8000-000000000001";
  const documentToken = "00000000-0000-4000-8000-000000000099";
  const discovery = {
    ...validDiscovery,
    candidates: [{ id: "101:501", courseId: "101", title: "Lecture" }],
  };
  const f = playbackAdapterFixture({
    response: {
      status: "success",
      resolved: { discovery, id: "101:501", courseId: "101" },
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
      type: "PLAYBACK_RESOLVE",
      handle,
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
  await f.runtime.command({ version: 1, type: "PLAYBACK_REFRESH" });
  expect(f.sendMessage).toHaveBeenLastCalledWith(
    8,
    {
      version: 1,
      type: "PLAYBACK_DISCOVER",
      salt: expect.stringMatching(/^[a-f0-9]{64}$/),
      documentToken,
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
      resolved: { discovery, id: "101:501", courseId: "101" },
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
