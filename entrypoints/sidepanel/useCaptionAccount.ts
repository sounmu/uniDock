import { useEffect, useState } from "react";
import type { CaptionSession } from "../../src/caption-server-settings";
import { getAccount, type CaptionAccount } from "../../src/captions/job-client";

const DAY_MS = 86_400_000;

/** The signed-in caption account, read again whenever `revision` changes, when
    the quota resets and when the panel is shown again; null while signed out
    or when the server could not be read. */
export function useCaptionAccount(
  session: CaptionSession | null | undefined,
  revision: unknown = 0,
): CaptionAccount | null {
  const [read, setRead] = useState<{ loginId: string; account: CaptionAccount } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const loginId = session?.loginId ?? null;
  useEffect(() => {
    if (!loginId) return;
    let live = true;
    void getAccount().then(
      (account) => live && setRead({ loginId, account }),
      () => live && setRead(null),
    );
    return () => {
      live = false;
    };
  }, [loginId, revision, refresh]);
  // A read from another sign-in is never shown, even before the new one lands.
  const account = read && read.loginId === loginId ? read.account : null;
  const resetsAt = account?.quota.resetsAt;
  useEffect(() => {
    if (!loginId) return;
    const again = () => setRefresh((value) => value + 1);
    const visible = () => {
      if (document.visibilityState === "visible") again();
    };
    document.addEventListener("visibilitychange", visible);
    // A reset that already looks past (a fast local clock) schedules nothing,
    // so the panel cannot loop on reads.
    const wait = resetsAt ? Date.parse(resetsAt) - Date.now() : NaN;
    const timer = wait > 0 ? setTimeout(again, Math.min(wait, DAY_MS) + 1_000) : undefined;
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [loginId, resetsAt]);
  return account;
}

/** Jobs the account can still start today; reserved work already holds a slot. */
export function remainingJobs({ quota }: CaptionAccount): number {
  return Math.max(0, quota.limit - quota.used - quota.reserved);
}
