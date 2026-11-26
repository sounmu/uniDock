import { useEffect, useState } from "react";
import type { CaptionSession } from "../../src/caption-server-settings";
import { getAccount, type CaptionAccount } from "../../src/captions/job-client";

/** The signed-in caption account, read again whenever `revision` changes;
    null while signed out or when the server could not be read. */
export function useCaptionAccount(
  session: CaptionSession | null | undefined,
  revision: unknown = 0,
): CaptionAccount | null {
  const [account, setAccount] = useState<CaptionAccount | null>(null);
  const signedIn = Boolean(session);
  useEffect(() => {
    if (!signedIn) {
      setAccount(null);
      return;
    }
    let live = true;
    void getAccount().then(
      (value) => live && setAccount(value),
      () => live && setAccount(null),
    );
    return () => {
      live = false;
    };
  }, [signedIn, revision]);
  return account;
}

/** Jobs the account can still start today; reserved work already holds a slot. */
export function remainingJobs({ quota }: CaptionAccount): number {
  return Math.max(0, quota.limit - quota.used - quota.reserved);
}
