export const popupAutoCloseKey = "unidock.popup-auto-close.v1";

/** Subscribe before reading so a stale initial read cannot undo a newer change. */
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
