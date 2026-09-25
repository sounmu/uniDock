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
    saved.settings = { ...saved.settings, enabled: true, courseIds: ["101"] };
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
  const noLms = await deliver({ version: 1, type: "PLAYBACK_STATUS" }, panel);
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
  const sendMessage = vi.fn().mockResolvedValue(response);
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

it("projects only a bounded top-frame discovery without persisting data while OFF", async () => {
  const f = playbackAdapterFixture({
    response: { status: "success", discovery: validDiscovery },
  });
  const result = await f.runtime.command({
    version: 1,
    type: "PLAYBACK_STATUS",
  });
  expect(result.status).toBe("success");
  if (result.status !== "success") throw new Error(result.code);
  expect(result.snapshot.courses).toEqual(validDiscovery.courses);
  expect(result.snapshot.settings.enabled).toBe(false);
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
      await f.runtime.command({ version: 1, type: "PLAYBACK_STATUS" }),
    ).toEqual({ status: "error", code });
    expect(f.values).not.toHaveProperty(PLAYBACK_STORAGE_KEY);
  },
);
