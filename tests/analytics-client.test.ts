// @vitest-environment jsdom
import { StrictMode, createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ANALYTICS_SETTINGS_KEY,
  type AnalyticsScreen,
} from "../src/analytics/contract";
import { mount } from "./ui-helpers";

const on = { available: true, enabled: true, notice: null };
const off = { available: true, enabled: false, notice: null };
beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture(status: object = on) {
  let current = status;
  const sendMessage = vi.fn(
    async (message: { type: string; enabled?: boolean }) => {
      if (message.type === "ANALYTICS_SET")
        current = { ...current, enabled: message.enabled };
      return message.type === "ANALYTICS_SIGNAL" ? { ok: true } : current;
    },
  );
  const listeners = new Set<(changes: object, area: string) => void>();
  vi.stubGlobal("chrome", {
    runtime: { sendMessage },
    storage: {
      onChanged: {
        addListener: (fn: (changes: object, area: string) => void) =>
          listeners.add(fn),
        removeListener: (fn: (changes: object, area: string) => void) =>
          listeners.delete(fn),
      },
    },
  });
  const signals = () =>
    sendMessage.mock.calls
      .map(([message]) => message as { type: string; signal?: unknown })
      .filter((message) => message.type === "ANALYTICS_SIGNAL")
      .map((message) => message.signal);
  return {
    sendMessage,
    signals,
    setStatus: (next: object) => {
      current = next;
    },
    changed: () => {
      for (const fn of listeners)
        fn({ [ANALYTICS_SETTINGS_KEY]: { newValue: current } }, "local");
    },
  };
}

it("records each operation's final outcome once and never backfills work started while off", async () => {
  const f = fixture(off);
  const client = await import("../entrypoints/sidepanel/analytics");
  await client.refreshAnalytics();
  const early = client.startOperation("document_download");
  f.setStatus(on);
  await client.refreshAnalytics();
  early.success();
  expect(f.signals()).toEqual([]);
  const op = client.startOperation("captions_export");
  op.result({ status: "error", code: "TIMEOUT" });
  op.success();
  op.failure("NETWORK");
  expect(f.signals()).toEqual([
    { kind: "op_start", operation: "captions_export", trigger: "user" },
    {
      kind: "op_end",
      operation: "captions_export",
      trigger: "user",
      outcome: "timeout",
    },
  ]);
});

it("maps dynamic error strings to fixed codes", async () => {
  const f = fixture();
  const client = await import("../entrypoints/sidepanel/analytics");
  await client.refreshAnalytics();
  client
    .startOperation("recording_open")
    .failure("Error: https://lms/x?token=1");
  expect(f.signals()[1]).toMatchObject({ outcome: "failure", error: "OTHER" });
});

it("stops capture in this panel immediately on OFF and follows another panel's change", async () => {
  const f = fixture();
  const client = await import("../entrypoints/sidepanel/analytics");
  await client.refreshAnalytics();
  const pending = client.setAnalyticsEnabled(false);
  client.signal({ kind: "service", service: "courses" });
  expect(await pending).toBe(true);
  expect(f.signals()).toEqual([]);
  const stop = client.startAnalyticsSettings();
  f.setStatus(on);
  f.changed();
  await vi.waitFor(() => expect(client.analyticsSnapshot()).toEqual(on));
  stop();
});

it("counts core results only while the panel is visible", async () => {
  const f = fixture();
  const client = await import("../entrypoints/sidepanel/analytics");
  await client.refreshAnalytics();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  client.coreResult("document_downloaded");
  expect(f.signals()).toEqual([]);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  client.coreResult("document_downloaded");
  expect(f.signals()).toEqual([
    { kind: "core", result: "document_downloaded" },
  ]);
});

it("counts service entries once per real entry despite StrictMode, re-renders, sub-screens and settings round trips", async () => {
  const f = fixture();
  const { useAnalytics } =
    await import("../entrypoints/sidepanel/useAnalytics");
  function Probe({ screen }: { readonly screen: AnalyticsScreen }) {
    useAnalytics(screen);
    return null;
  }
  const view = (screen: AnalyticsScreen) =>
    createElement(StrictMode, null, createElement(Probe, { screen }));
  const ui = await mount(view("COURSES_LIST"));
  await vi.waitFor(() => expect(f.signals()).toHaveLength(1));
  for (const screen of [
    "COURSES_LIST",
    "ASSIGNMENTS_LIST",
    "DOCUMENTS_LIST",
    "RECORDINGS_LIST",
    "TODO_LIST",
    "UPCOMING_LIST",
    "INFO",
    "UPCOMING_LIST",
    "INFO",
    "INFO",
    "CAPTIONS",
  ] as const)
    await ui.render(view(screen));
  document.dispatchEvent(new Event("visibilitychange"));
  await ui.render(view("CAPTIONS"));
  expect(f.signals()).toEqual([
    { kind: "service", service: "courses" },
    { kind: "service", service: "tasks" },
    { kind: "service", service: "settings" },
    { kind: "service", service: "settings" },
    { kind: "service", service: "captions" },
  ]);
  await ui.unmount();
});
