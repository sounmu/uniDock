import {
  ANALYTICS_SETTINGS_KEY,
  collecting,
  isAnalyticsStatus,
  type AnalyticsSignal,
  type AnalyticsStatus,
} from "../../src/analytics/contract";
import {
  errorCode,
  type CoreResult,
  type ErrorCode,
  type Operation,
  type Trigger,
} from "../../src/analytics/report";

let status: AnalyticsStatus = {
  available: false,
  enabled: false,
  notice: null,
};
let revision = 0;
const listeners = new Set<() => void>();
export const analyticsSnapshot = () => status;
export function subscribeAnalytics(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function publish(next: AnalyticsStatus) {
  status = next;
  for (const listener of listeners) listener();
}
async function command(message: object): Promise<unknown> {
  try {
    return await chrome.runtime.sendMessage({ version: 1, ...message });
  } catch {
    // Statistics must never affect learning features.
    return undefined;
  }
}
export async function refreshAnalytics() {
  const current = ++revision;
  const next = await command({ type: "ANALYTICS_STATUS" });
  if (current === revision && isAnalyticsStatus(next)) publish(next);
}
export async function setAnalyticsEnabled(enabled: boolean): Promise<boolean> {
  const current = ++revision;
  // Stop capture in this panel at once, even if the write later fails.
  if (!enabled) publish({ ...status, enabled: false });
  const next = await command({ type: "ANALYTICS_SET", enabled });
  if (!isAnalyticsStatus(next)) return false;
  if (current === revision) publish(next);
  return next.enabled === enabled;
}
export async function markNoticeShown() {
  const current = ++revision;
  const next = await command({ type: "ANALYTICS_NOTICE_SHOWN" });
  if (current === revision && isAnalyticsStatus(next)) publish(next);
}
export function startAnalyticsSettings() {
  const changed = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== "local" || !changes[ANALYTICS_SETTINGS_KEY]) return;
    // Another panel changed the setting: stop first, then read the new value.
    revision++;
    publish({ ...status, enabled: false });
    void refreshAnalytics();
  };
  chrome.storage?.onChanged?.addListener(changed);
  void refreshAnalytics();
  return () => chrome.storage?.onChanged?.removeListener(changed);
}
export function signal(data: AnalyticsSignal) {
  if (!collecting(status)) return;
  void command({ type: "ANALYTICS_SIGNAL", signal: data });
}
/** Core results count only when the user can see them in the foreground panel. */
export function coreResult(result: CoreResult) {
  if (document.visibilityState === "visible") signal({ kind: "core", result });
}

export interface OperationHandle {
  success(): void;
  failure(code: ErrorCode | string): void;
  timeout(): void;
  cancel(): void;
  /** Maps a closed `{status, code}` result; TIMEOUT becomes a timeout. */
  result(value: { status: string; code?: string }): void;
}
const NOOP: OperationHandle = {
  success() {},
  failure() {},
  timeout() {},
  cancel() {},
  result() {},
};
/**
 * One logical operation started by the panel. Its final outcome is recorded
 * at most once; the handle (the only operation identity) never leaves this
 * page. Work started while statistics were off is never backfilled.
 */
export function startOperation(
  operation: Operation,
  trigger: Trigger = "user",
): OperationHandle {
  if (!collecting(status)) return NOOP;
  const started = performance.now();
  let done = false;
  signal({ kind: "op_start", operation, trigger });
  const finish = (end: AnalyticsSignal) => {
    if (done) return;
    done = true;
    signal(end);
  };
  const handle: OperationHandle = {
    success: () =>
      finish({
        kind: "op_end",
        operation,
        trigger,
        outcome: "success",
        duration_ms: Math.max(0, Math.round(performance.now() - started)),
      }),
    failure: (code) =>
      finish({
        kind: "op_end",
        operation,
        trigger,
        outcome: "failure",
        error: errorCode(code),
      }),
    timeout: () =>
      finish({ kind: "op_end", operation, trigger, outcome: "timeout" }),
    cancel: () =>
      finish({ kind: "op_end", operation, trigger, outcome: "cancel" }),
    result: (value) => {
      if (value.status === "success") handle.success();
      else if (value.code === "TIMEOUT") handle.timeout();
      else handle.failure(value.code ?? "OTHER");
    },
  };
  return handle;
}
