export const popupAutoCloseKey = "unidock.popup-auto-close.v1";
/** The only origin where the popup content script runs. */
export const POPUP_ORIGIN = "https://lms.korea.ac.kr";
export const POPUP_MATCHES = [`${POPUP_ORIGIN}/*`];
/**
 * Optional host grant requested only when the user turns the feature on.
 * It is never an install-time permission, so updates do not re-prompt.
 */
export const POPUP_PERMISSION = { origins: POPUP_MATCHES };
/** Runtime-registered content script; absent from the manifest. */
export const POPUP_SCRIPT = {
  id: "unidock-lms-popup",
  file: "content-scripts/lms-popup.js",
} as const;

/**
 * Closed messages between the popup content script and the service worker.
 * `storage.local` is locked to TRUSTED_CONTEXTS, so the content script asks
 * the worker for the boolean and the worker only ever answers with it.
 */
export const popupAutoCloseGet = {
  version: 1,
  type: "POPUP_AUTO_CLOSE_GET",
} as const;
/** Payload-free invalidation; the content script rereads through the worker. */
export const popupAutoCloseChanged = {
  version: 1,
  type: "POPUP_AUTO_CLOSE_CHANGED",
} as const;
export interface PopupAutoCloseState {
  readonly version: 1;
  readonly type: "POPUP_AUTO_CLOSE_STATE";
  readonly enabled: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, type: string): boolean {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    value.version === 1 &&
    value.type === type
  );
}
export function isPopupAutoCloseGet(value: unknown): boolean {
  return exact(value, popupAutoCloseGet.type);
}
export function isPopupAutoCloseChanged(value: unknown): boolean {
  return exact(value, popupAutoCloseChanged.type);
}
/** Returns the boolean only for an exact state reply; anything else is null. */
export function parsePopupAutoCloseState(value: unknown): boolean | null {
  return record(value) &&
    Object.keys(value).length === 3 &&
    value.version === 1 &&
    value.type === "POPUP_AUTO_CLOSE_STATE" &&
    typeof value.enabled === "boolean"
    ? value.enabled
    : null;
}

/** Top frame of this extension's popup content script on the portal origin. */
export function popupPageSender(sender: chrome.runtime.MessageSender): boolean {
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    sender.tab?.id === undefined ||
    !sender.url ||
    (sender.origin !== undefined && sender.origin !== POPUP_ORIGIN)
  )
    return false;
  try {
    const url = new URL(sender.url);
    return url.origin === POPUP_ORIGIN && !url.username && !url.password;
  } catch {
    return false;
  }
}
/** The extension service worker, never a tab or another extension. */
function workerSender(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    sender.tab === undefined &&
    (sender.url === undefined ||
      sender.url === chrome.runtime.getURL("background.js"))
  );
}

/** Worker side: a missing or non-boolean value is off. */
export async function readPopupAutoClose(): Promise<PopupAutoCloseState> {
  const values = await chrome.storage.local.get(popupAutoCloseKey);
  return {
    version: 1,
    type: "POPUP_AUTO_CLOSE_STATE",
    enabled: values[popupAutoCloseKey] === true,
  };
}

// Portal tabs, found through the optional `lms.korea.ac.kr` grant for the URL
// filter, not broad `tabs`. Without the grant no tab matches.
async function popupTabs(): Promise<number[]> {
  try {
    const tabs = await chrome.tabs.query({ url: POPUP_MATCHES });
    return tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
  } catch {
    return [];
  }
}

/** Worker side: tell top-level portal documents to reread. */
export async function notifyPopupAutoCloseTabs(): Promise<void> {
  await Promise.all(
    (await popupTabs()).map(async (tabId) => {
      try {
        await chrome.tabs.sendMessage(tabId, popupAutoCloseChanged, {
          frameId: 0,
        });
      } catch {
        // No content script in that tab yet; it reads on its own start.
      }
    }),
  );
}

async function popupGranted(): Promise<boolean> {
  try {
    return await chrome.permissions.contains(POPUP_PERMISSION);
  } catch {
    return false;
  }
}

/**
 * Worker side: the portal script is registered only while both the opt-in
 * boolean and the optional grant hold. Returns whether the feature is active.
 * The worker never changes the grant itself: the panel requests it before it
 * saves ON and returns it after it saves OFF, one change at a time, so a late
 * worker task cannot undo a newer panel action.
 *
 * `resetOrphan` (worker start, grant revoked in chrome://extensions) also
 * turns off an opt-in left without its grant, after a second read so a panel
 * change in between is not mistaken for one.
 */
export async function syncPopupAutoClose(
  resetOrphan = false,
): Promise<boolean> {
  const [{ enabled }, granted] = await Promise.all([
    readPopupAutoClose(),
    popupGranted(),
  ]);
  const active = enabled && granted;
  const registered =
    (
      await chrome.scripting.getRegisteredContentScripts({
        ids: [POPUP_SCRIPT.id],
      })
    ).length > 0;
  if (active && !registered)
    await chrome.scripting.registerContentScripts([
      {
        id: POPUP_SCRIPT.id,
        matches: POPUP_MATCHES,
        js: [POPUP_SCRIPT.file],
        runAt: "document_idle",
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
  else if (!active && registered)
    await chrome.scripting.unregisterContentScripts({ ids: [POPUP_SCRIPT.id] });
  if (resetOrphan && enabled && !granted) {
    const [again, stillGranted] = await Promise.all([
      readPopupAutoClose(),
      popupGranted(),
    ]);
    if (again.enabled && !stillGranted)
      await chrome.storage.local.remove(popupAutoCloseKey);
  }
  return active;
}

/**
 * Worker side, after the opt-in changed (set, cleared or deleted). Open portal
 * pages reread; turning on also injects the script into portal tabs opened
 * before the grant (a reinjected script supersedes an older instance in the
 * same document). Every step reads the current state, so a task that runs
 * late only repeats the newest outcome.
 */
export async function applyPopupAutoCloseChange(): Promise<void> {
  const active = await syncPopupAutoClose();
  await notifyPopupAutoCloseTabs();
  if (!active) return;
  await Promise.all(
    (await popupTabs()).map((tabId) =>
      chrome.scripting
        .executeScript({
          target: { tabId, frameIds: [0] },
          files: [POPUP_SCRIPT.file],
        })
        .catch(() => {}),
    ),
  );
}

/** Returns the optional portal grant; a grant already gone is not an error. */
export async function returnPopupGrant(): Promise<void> {
  try {
    await chrome.permissions.remove(POPUP_PERMISSION);
  } catch {
    // Nothing is registered without the opt-in either way.
  }
}

// Panel side: grant and opt-in changes (the switch, local-data deletion) run
// one at a time. The grant request has to start inside the click, so a busy
// panel refuses a new change instead of queueing it, and shows it as busy.
let popupChangeRunning = false;
const popupChangeListeners = new Set<(busy: boolean) => void>();
function setPopupChangeRunning(running: boolean) {
  popupChangeRunning = running;
  for (const listener of popupChangeListeners) listener(running);
}
export function watchPopupChangeBusy(
  listener: (busy: boolean) => void,
): () => void {
  popupChangeListeners.add(listener);
  listener(popupChangeRunning);
  return () => popupChangeListeners.delete(listener);
}
/**
 * Starts `task` synchronously (keeping the click's user gesture) unless
 * another change is running; resolves false when refused.
 */
export function runPopupChange(task: () => Promise<void>): Promise<boolean> {
  if (popupChangeRunning) return Promise.resolve(false);
  setPopupChangeRunning(true);
  let running: Promise<void>;
  try {
    running = task();
  } catch (error) {
    running = Promise.reject(error);
  }
  return running.then(
    () => {
      setPopupChangeRunning(false);
      return true;
    },
    (error: unknown) => {
      setPopupChangeRunning(false);
      throw error;
    },
  );
}

/**
 * Side-panel (trusted context) watcher over `storage.local`.
 * Subscribe before reading so a stale initial read cannot undo a newer change.
 */
export function watchPopupAutoClose(
  receive: (enabled: boolean) => void,
  failed: () => void,
): () => void {
  let current = true;
  let changed = false;
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (!current || area !== "local" || !(popupAutoCloseKey in changes)) return;
    changed = true;
    receive(changes[popupAutoCloseKey]?.newValue === true);
  };
  chrome.storage.onChanged.addListener(listener);
  void chrome.storage.local.get(popupAutoCloseKey).then(
    (values) => {
      if (current && !changed) receive(values[popupAutoCloseKey] === true);
    },
    () => {
      if (current && !changed) failed();
    },
  );
  return () => {
    current = false;
    chrome.storage.onChanged.removeListener(listener);
  };
}

/**
 * Content-script watcher. Content scripts cannot read `storage.local`, so the
 * value comes from the worker. Subscribe before reading, and apply only the
 * newest read so an older reply cannot undo a newer change.
 */
export function watchPopupAutoCloseFromWorker(
  receive: (enabled: boolean) => void,
  failed: () => void,
): () => void {
  let current = true;
  let generation = 0;
  const read = () => {
    const mine = ++generation;
    let reply: Promise<unknown>;
    try {
      reply = chrome.runtime.sendMessage(popupAutoCloseGet);
    } catch {
      reply = Promise.reject(new Error("unavailable"));
    }
    void reply.then(
      (value) => {
        if (!current || mine !== generation) return;
        const enabled = parsePopupAutoCloseState(value);
        if (enabled === null) failed();
        else receive(enabled);
      },
      () => {
        if (current && mine === generation) failed();
      },
    );
  };
  const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
    if (current && isPopupAutoCloseChanged(message) && workerSender(sender))
      read();
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  read();
  return () => {
    current = false;
    chrome.runtime.onMessage.removeListener(listener);
  };
}
