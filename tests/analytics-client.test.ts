import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ANALYTICS_KEY } from "../src/analytics/contract";

const consentId = "00000000-0000-4000-8000-000000000001";
const enabled = { available: true, choice: "enabled", consentId };
const disabled = { available: true, choice: "disabled" };
beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture() {
  const sendMessage = vi.fn().mockResolvedValue(disabled);
  let changed!: (changes: Record<string, unknown>, area: string) => void;
  const removeListener = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: { sendMessage },
    storage: {
      onChanged: {
        addListener: (callback: typeof changed) => {
          changed = callback;
        },
        removeListener,
      },
    },
  });
  return {
    sendMessage,
    removeListener,
    changed: (value: unknown, area = "local") =>
      changed({ [ANALYTICS_KEY]: value }, area),
  };
}

it("never backfills actions or in-flight operations that began before consent", async () => {
  const f = fixture();
  const client = await import("../entrypoints/sidepanel/analytics");
  const operation = client.featureResult("download");
  client.track({ event: "panel_opened", screen: "INFO" });
  expect(f.sendMessage).not.toHaveBeenCalled();
  f.sendMessage.mockResolvedValue(enabled);
  expect(await client.setAnalyticsConsent(true)).toBe(true);
  f.sendMessage.mockClear();
  operation(true);
  expect(f.sendMessage).not.toHaveBeenCalled();
  client.featureResult("download")(true);
  expect(f.sendMessage).toHaveBeenCalledWith({
    version: 1,
    type: "ANALYTICS_CAPTURE",
    consentId,
    data: { event: "feature_result", feature: "download", outcome: "success" },
  });
});

it("disables capture immediately on revoke failure and discards old async results after reconsent", async () => {
  const f = fixture();
  const client = await import("../entrypoints/sidepanel/analytics");
  f.sendMessage.mockResolvedValue(enabled);
  await client.setAnalyticsConsent(true);
  const report = client.featureResult("captions_detect");
  f.sendMessage.mockRejectedValueOnce(new Error("STORAGE"));
  const revoke = client.setAnalyticsConsent(false);
  expect(client.analyticsSnapshot().choice).toBe("disabled");
  expect(await revoke).toBe(false);
  f.sendMessage.mockResolvedValue({
    ...enabled,
    consentId: "00000000-0000-4000-8000-000000000002",
  });
  await client.setAnalyticsConsent(true);
  f.sendMessage.mockClear();
  report(true);
  expect(f.sendMessage).not.toHaveBeenCalled();
});

it("ignores a stale status reply after another panel deletes consent", async () => {
  const f = fixture();
  const client = await import("../entrypoints/sidepanel/analytics");
  let release!: (value: unknown) => void;
  f.sendMessage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const stop = client.startAnalyticsSettings();
  f.changed({ newValue: undefined });
  await vi.waitFor(() => expect(client.analyticsSnapshot()).toEqual(disabled));
  release(enabled);
  await Promise.resolve();
  expect(client.analyticsSnapshot()).toEqual(disabled);
  stop();
  expect(f.removeListener).toHaveBeenCalledOnce();
});

it("fails closed on malformed status and isolates transport errors from UI actions", async () => {
  const f = fixture();
  const client = await import("../entrypoints/sidepanel/analytics");
  f.sendMessage.mockResolvedValue({ ...enabled, consentId: "PRIVATE" });
  expect(await client.setAnalyticsConsent(true)).toBe(false);
  expect(client.analyticsSnapshot().choice).toBe("disabled");
  f.sendMessage.mockResolvedValue(enabled);
  await client.refreshAnalytics();
  f.sendMessage.mockRejectedValue(new Error("CLOSED"));
  expect(() =>
    client.track({ event: "panel_opened", screen: "INFO" }),
  ).not.toThrow();
  await Promise.resolve();
  f.sendMessage.mockImplementation(() => {
    throw new Error("NO_CONTEXT");
  });
  expect(() =>
    client.track({ event: "panel_opened", screen: "INFO" }),
  ).not.toThrow();
});

it("does not restart measurement for a late matching storage notification", async () => {
  const f = fixture();
  const client = await import("../entrypoints/sidepanel/analytics");
  f.sendMessage.mockResolvedValue(enabled);
  const stop = client.startAnalyticsSettings();
  await vi.waitFor(() => expect(client.analyticsSnapshot()).toEqual(enabled));
  const changed = vi.fn();
  const unsubscribe = client.subscribeAnalytics(changed);
  f.changed({ newValue: { version: 1, enabled: true, id: consentId } });
  expect(changed).not.toHaveBeenCalled();
  unsubscribe();
  stop();
});
