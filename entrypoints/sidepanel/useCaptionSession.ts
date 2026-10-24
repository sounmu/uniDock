import { useEffect, useState } from "react";
import {
  CAPTION_SESSION_KEY,
  loadSession,
  type CaptionSession,
} from "../../src/caption-server-settings";

/** The stored broker session; `undefined` until storage has been read. */
export function useCaptionSession(): CaptionSession | null | undefined {
  const [session, setSession] = useState<CaptionSession | null | undefined>();
  useEffect(() => {
    let live = true;
    const read = () =>
      void loadSession().then(
        (value) => live && setSession(value),
        () => live && setSession(null),
      );
    const changed = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local" && CAPTION_SESSION_KEY in changes) read();
    };
    read();
    chrome.storage.onChanged.addListener(changed);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);
  return session;
}
