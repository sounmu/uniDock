import {
  ANALYTICS_KEY,
  isAnalyticsStatus,
  record,
  type AnalyticsEvent,
  type AnalyticsStatus,
  type AnalyticsFeature,
} from "../../src/analytics/contract";

let status: AnalyticsStatus = { available: false, choice: "undecided" };
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
export async function refreshAnalytics() {
  const current = ++revision;
  try {
    const next: unknown = await chrome.runtime.sendMessage({
      version: 1,
      type: "ANALYTICS_STATUS",
    });
    if (current === revision && isAnalyticsStatus(next)) publish(next);
  } catch {
    /* Analytics availability must not affect LMS features. */
  }
}
export async function setAnalyticsConsent(enabled: boolean): Promise<boolean> {
  const current = ++revision;
  // Disable capture in this panel immediately, including on a storage error.
  publish({ available: status.available, choice: "disabled" });
  try {
    const next: unknown = await chrome.runtime.sendMessage({
      version: 1,
      type: "ANALYTICS_CONSENT",
      enabled,
    });
    if (!isAnalyticsStatus(next)) return false;
    if (current === revision) publish(next);
    return next.choice === (enabled ? "enabled" : "disabled");
  } catch {
    return false;
  }
}
export function startAnalyticsSettings() {
  const changed = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== "local" || !changes[ANALYTICS_KEY]) return;
    const next: unknown = changes[ANALYTICS_KEY].newValue;
    // The storage notification may arrive after the consent command's reply.
    if (
      record(next) &&
      next.version === 1 &&
      next.enabled === true &&
      Object.keys(next).length === 3 &&
      status.choice === "enabled" &&
      next.id === status.consentId
    )
      return;
    revision++;
    publish({ available: status.available, choice: "disabled" });
    void refreshAnalytics();
  };
  chrome.storage?.onChanged?.addListener(changed);
  void refreshAnalytics();
  return () => chrome.storage?.onChanged?.removeListener(changed);
}
export function track(data: AnalyticsEvent) {
  if (status.choice !== "enabled" || !status.consentId) return;
  try {
    void chrome.runtime
      .sendMessage({
        version: 1,
        type: "ANALYTICS_CAPTURE",
        consentId: status.consentId,
        data,
      })
      .catch(() => {});
  } catch {
    /* Disappearing extension context. */
  }
}
/** Captures the consent generation at operation start; never backfills pre-consent work. */
export function featureResult(feature: AnalyticsFeature) {
  const consentId = status.consentId;
  return (success: boolean) => {
    if (!consentId || status.consentId !== consentId) return;
    track({
      event: "feature_result",
      feature,
      outcome: success ? "success" : "failure",
    });
  };
}
