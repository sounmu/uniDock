import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  SCREEN_SERVICES,
  collecting,
  type AnalyticsScreen,
} from "../../src/analytics/contract";
import type { Service } from "../../src/analytics/report";
import {
  analyticsSnapshot,
  signal,
  startAnalyticsSettings,
  subscribeAnalytics,
} from "./analytics";

function useVisible() {
  const [visible, setVisible] = useState(
    () => document.visibilityState === "visible",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/**
 * Counts a service entry when this panel first shows a service or moves to a
 * different one. Sub-screen moves inside a service, re-renders, StrictMode
 * effect replays (refs survive them), re-selecting the current tab and focus
 * or visibility returns never count. Settings is an overlay: returning from it
 * to the same learning service is not a new entry.
 */
export function useAnalytics(screen: AnalyticsScreen) {
  const status = useSyncExternalStore(subscribeAnalytics, analyticsSnapshot);
  const visible = useVisible();
  const active = collecting(status);
  const lastLearning = useRef<Service | null>(null);
  const inSettings = useRef(false);
  useEffect(startAnalyticsSettings, []);
  useEffect(() => {
    if (!active || !visible) return;
    const service = SCREEN_SERVICES[screen];
    if (service === "settings") {
      if (inSettings.current) return;
      inSettings.current = true;
    } else {
      inSettings.current = false;
      if (lastLearning.current === service) return;
      lastLearning.current = service;
    }
    signal({ kind: "service", service });
  }, [screen, active, visible]);
  return status;
}
