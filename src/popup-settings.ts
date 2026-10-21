export const popupAutoCloseKey = "unidock.popup-auto-close.v1";
/** The only origin where the popup content script runs. */
export const POPUP_ORIGIN = "https://lms.korea.ac.kr";
export const POPUP_MATCHES = [`${POPUP_ORIGIN}/*`];

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

/**
 * Worker side: tell top-level portal documents to reread. Uses the existing
 * `lms.korea.ac.kr` host permission for the URL filter, not broad `tabs`.
 */
export async function notifyPopupAutoCloseTabs(): Promise<void> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ url: POPUP_MATCHES });
  } catch {
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.tabs.sendMessage(tab.id, popupAutoCloseChanged, {
          frameId: 0,
        });
      } catch {
        // No content script in that tab yet; it reads on its own start.
      }
    }),
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
