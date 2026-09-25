import { openLmsTab } from "../src/open-tab";
import { defineBackground } from "wxt/utils/define-background";
import { safeLog } from "../src/security/logger";
import { ChromePlaybackStore } from "../src/playback/storage";
import {
  PlaybackRuntime,
  PlaybackRuntimeError,
  type PlayerAddress,
} from "../src/playback/runtime";
import {
  isDiscovery,
  isPlaybackCommand,
  isPlayerBinding,
  object,
  panelSender,
  playbackErrors,
  playerPage,
  itemKey,
  stableId,
  type PlayerSignal,
} from "../src/playback/bridge";
import { allowedPage, LMS_MATCHES } from "../src/security/policy";
import { navigationUrl } from "../src/security/navigation";

async function boundedMessage(
  tabId: number,
  message: unknown,
  options: chrome.tabs.MessageSendOptions,
): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, message, options),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new PlaybackRuntimeError("TIMEOUT")),
          25000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
export function createChromePlaybackRuntime(): PlaybackRuntime {
  const store = new ChromePlaybackStore();
  const ownershipKey = "unidock.playback.owned-tab";
  let sourceTabId: number | undefined;
  async function query(
    handle?: string,
  ): Promise<{ result: Record<string, unknown>; origin: string }> {
    const tabs = (await chrome.tabs.query({ url: LMS_MATCHES })).filter(
      (tab) =>
        tab.id !== runtime.dedicatedTabId &&
        tab.id !== undefined &&
        tab.url &&
        allowedPage(tab.url),
    );
    const tab =
      tabs.find((tab) => tab.id === sourceTabId) ??
      tabs.find((tab) => tab.active) ??
      tabs[0];
    if (tab?.id === undefined || !tab.url)
      throw new PlaybackRuntimeError("OPEN_LMS");
    sourceTabId = tab.id;
    const salt = await store.accountSalt();
    const result = await boundedMessage(
      tab.id,
      handle
        ? { version: 1, type: "PLAYBACK_RESOLVE", handle, salt }
        : { version: 1, type: "PLAYBACK_DISCOVER", salt },
      { frameId: 0 },
    );
    const current = await chrome.tabs.get(tab.id);
    if (current.url !== tab.url) throw new PlaybackRuntimeError("RELOAD_TAB");
    if (object(result) && result.status === "error") {
      const code = playbackErrors.find((code) => code === result.code);
      throw new PlaybackRuntimeError(code ?? "INVALID_RESPONSE");
    }
    if (!object(result) || result.status !== "success")
      throw new PlaybackRuntimeError("INVALID_RESPONSE");
    return { result, origin: new URL(tab.url).origin };
  }
  const runtime: PlaybackRuntime = new PlaybackRuntime({
    store,
    now: Date.now,
    uuid: () => crypto.randomUUID(),
    async discover() {
      const { result, origin } = await query();
      if (!isDiscovery(result.discovery) || result.discovery.origin !== origin)
        throw new PlaybackRuntimeError("INVALID_RESPONSE");
      return result.discovery;
    },
    async resolve(handle) {
      const { result, origin } = await query(handle);
      const value = result.resolved;
      if (
        !object(value) ||
        Object.keys(value).length !== 3 ||
        !isDiscovery(value.discovery) ||
        value.discovery.origin !== origin ||
        !itemKey(value.id) ||
        !stableId(value.courseId) ||
        !value.id.startsWith(`${value.courseId}:`)
      )
        throw new PlaybackRuntimeError("INVALID_RESPONSE");
      return {
        discovery: value.discovery,
        id: value.id,
        courseId: value.courseId,
      };
    },
    async open(url) {
      if (navigationUrl(url, url) !== url)
        throw new PlaybackRuntimeError("POLICY");
      const tab = await chrome.tabs.create({
        url: "about:blank",
        active: true,
      });
      if (tab.id === undefined)
        throw new PlaybackRuntimeError("TAB_OPEN_FAILED");
      const path = new URL(url).pathname.split("/");
      try {
        await chrome.storage.session.set({
          [ownershipKey]: { tabId: tab.id, courseId: path[2], itemId: path[5] },
        });
      } catch {
        await chrome.tabs.remove(tab.id);
        throw new PlaybackRuntimeError("STORAGE");
      }
      return tab.id;
    },
    async navigate(tabId, url) {
      if (navigationUrl(url, url) !== url)
        throw new PlaybackRuntimeError("POLICY");
      await chrome.tabs.update(tabId, { url, active: true });
    },
    async close(tabId) {
      // Session storage survives worker eviction but not browser restart. Never trust a reused tab ID.
      const stored = await chrome.storage.session.get(ownershipKey);
      const owner: unknown = stored[ownershipKey];
      if (
        !object(owner) ||
        owner.tabId !== tabId ||
        !stableId(owner.courseId) ||
        !stableId(owner.itemId)
      )
        return;
      await chrome.storage.session.remove(ownershipKey);
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        return; /* A removed tab is already stopped. */
      }
      if (!tab.url || (tab.url !== "about:blank" && !playerPage(tab.url)))
        return;
      if (
        allowedPage(tab.url) &&
        new URL(tab.url).pathname !==
          `/courses/${owner.courseId}/modules/items/${owner.itemId}`
      )
        return;
      await chrome.tabs.remove(tabId);
    },
    async control(address, binding, action) {
      if (action === "resume")
        await chrome.tabs.update(address.tabId, { active: true });
      const result = await boundedMessage(
        address.tabId,
        { version: 1, type: "PLAYBACK_PLAYER_CONTROL", ...binding, action },
        { frameId: address.frameId, documentId: address.documentId },
      );
      if (!object(result) || result.ok !== true)
        throw new PlaybackRuntimeError("PLAYER_LOST");
    },
    async alarm(name, when) {
      await chrome.alarms.clear(name);
      if (when !== null) await chrome.alarms.create(name, { when });
    },
  });
  return runtime;
}
async function playerAddress(
  sender: chrome.runtime.MessageSender,
  runtime: PlaybackRuntime,
): Promise<PlayerAddress | null> {
  if (
    sender.id !== chrome.runtime.id ||
    sender.tab?.id !== runtime.dedicatedTabId ||
    sender.tab?.id === undefined ||
    sender.frameId === undefined ||
    !sender.documentId ||
    !sender.url ||
    !playerPage(sender.url) ||
    (sender.documentLifecycle && sender.documentLifecycle !== "active") ||
    (sender.origin && sender.origin !== new URL(sender.url).origin)
  )
    return null;
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!tab.url || !playerPage(tab.url)) return null;
  const item = runtime.dedicatedItem;
  if (!item) return null;
  if (
    allowedPage(tab.url) &&
    new URL(tab.url).pathname !==
      `/courses/${item.courseId}/modules/items/${item.id.split(":")[1]}`
  )
    return null;
  if (sender.frameId === 0 && tab.url !== sender.url) return null;
  return {
    tabId: sender.tab.id,
    frameId: sender.frameId,
    documentId: sender.documentId,
  };
}

const DEFAULT_ACTION_TITLE = "uniDock 열기";
const FALLBACK_ACTION_TITLE = "uniDock — 사이드 패널 대신 팝업으로 엽니다";

async function usePopupFallback() {
  await Promise.all([
    chrome.action.setPopup({ popup: "sidepanel.html" }),
    chrome.action.setBadgeText({ text: "!" }),
    chrome.action.setBadgeBackgroundColor({ color: "#872038" }),
    chrome.action.setTitle({ title: FALLBACK_ACTION_TITLE }),
  ]);
}

async function configurePanelAction() {
  if (typeof chrome.sidePanel?.setPanelBehavior !== "function") {
    await usePopupFallback();
    return;
  }
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    await usePopupFallback();
    return;
  }
  await Promise.all([
    chrome.action.setPopup({ popup: "" }),
    chrome.action.setBadgeText({ text: "" }),
    chrome.action.setTitle({ title: DEFAULT_ACTION_TITLE }),
  ]);
}

export default defineBackground(() => {
  // Chrome 114 supports these APIs; baseline tests/older unsupported runtimes may not.
  const playback =
    chrome.storage?.local && chrome.alarms?.onAlarm
      ? createChromePlaybackRuntime()
      : null;
  const notifyPlayback = () => {
    void chrome.runtime
      .sendMessage({ version: 1, type: "PLAYBACK_UPDATED" })
      .catch(() => {});
  };
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (isPlaybackCommand(message)) {
      if (!panelSender(sender)) {
        respond({ status: "error", code: "POLICY" });
        return false;
      }
      if (!playback) {
        respond({ status: "error", code: "UNAVAILABLE" });
        return false;
      }
      void playback.command(message).then(respond);
      return true;
    }
    if (
      playback &&
      object(message) &&
      message.version === 1 &&
      [
        "PLAYBACK_PLAYER_HELLO",
        "PLAYBACK_PLAYER_EVENT",
        "PLAYBACK_PLAYER_LEASE",
      ].includes(String(message.type))
    ) {
      void (async () => {
        const address = await playerAddress(sender, playback);
        if (!address) return { ok: false };
        if (
          message.type === "PLAYBACK_PLAYER_HELLO" &&
          Object.keys(message).length === 2
        )
          return { ok: true, authorization: await playback.authorize(address) };
        if (!isPlayerBinding(message)) return { ok: false };
        if (
          message.type === "PLAYBACK_PLAYER_LEASE" &&
          Object.keys(message).length === 5
        )
          return {
            ok: true,
            authorization: await playback.lease(address, message),
          };
        const states: readonly PlayerSignal[] = [
          "starting",
          "playing",
          "paused",
          "ended",
          "blocked-login",
          "blocked-autoplay",
          "failed",
        ];
        const state = states.find((state) => state === message.state);
        if (
          message.type === "PLAYBACK_PLAYER_EVENT" &&
          Object.keys(message).length === 6 &&
          state
        ) {
          const ok = await playback.signal(address, message, state);
          if (ok) notifyPlayback();
          return { ok };
        }
        return { ok: false };
      })().then(respond, () => respond({ ok: false }));
      return true;
    }
    if (
      !message ||
      typeof message !== "object" ||
      (message as Record<string, unknown>).type !== "OPEN_LMS_TARGET"
    )
      return false;
    void openLmsTab(message, sender).then(respond);
    return true;
  });
  if (playback) {
    // Recreate alarms on every worker boot as well as browser startup: Chrome does not guarantee persistence.
    const recover = () => {
      void playback.startup().then(notifyPlayback);
    };
    chrome.alarms.onAlarm.addListener((alarm) => {
      void playback.alarm(alarm.name).then(notifyPlayback);
    });
    chrome.runtime.onStartup?.addListener(recover);
    chrome.runtime.onInstalled?.addListener(recover);
    chrome.tabs.onRemoved.addListener((tabId) => {
      void playback.lost(tabId).then(notifyPlayback);
    });
    chrome.tabs.onActivated.addListener(({ tabId }) => {
      if (playback.dedicatedTabId !== null && tabId !== playback.dedicatedTabId)
        void playback
          .command({ version: 1, type: "PLAYBACK_PAUSE" })
          .then(notifyPlayback);
    });
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (
        tabId === playback.dedicatedTabId &&
        change.url &&
        change.url !== "about:blank" &&
        !playerPage(change.url)
      )
        void playback.lost(tabId).then(notifyPlayback);
    });
    recover();
  }
  void configurePanelAction().catch(() => safeLog("PANEL_SETUP_FAILED"));
});
