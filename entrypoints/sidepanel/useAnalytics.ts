import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  actions,
  type AnalyticsEvent,
  type AnalyticsScreen,
} from "../../src/analytics/contract";
import { EngagementClock } from "../../src/analytics/engagement";
import {
  analyticsSnapshot,
  subscribeAnalytics,
  startAnalyticsSettings,
  track,
} from "./analytics";

export function useAnalytics(screen: AnalyticsScreen) {
  const status = useSyncExternalStore(subscribeAnalytics, analyticsSnapshot);
  const screenRef = useRef(screen);
  const transition = useRef<(next: AnalyticsScreen) => void>(() => {});
  useEffect(startAnalyticsSettings, []);
  useEffect(() => {
    screenRef.current = screen;
    transition.current(screen);
  }, [screen]);
  useEffect(() => {
    if (status.choice !== "enabled") return;
    const capture = (event: AnalyticsEvent) => {
      if (analyticsSnapshot().consentId === status.consentId) track(event);
    };
    let currentScreen = screenRef.current;
    let visible = document.visibilityState === "visible";
    let focused = document.hasFocus();
    const clock = new EngagementClock(performance.now());
    const tick = () => clock.tick(performance.now(), visible, focused);
    const flush = () => {
      tick();
      const times = clock.take();
      if (times.visible_seconds)
        capture({ event: "panel_engagement", screen: currentScreen, ...times });
    };
    capture({ event: "panel_opened", screen: currentScreen });
    capture({ event: "screen_viewed", screen: currentScreen });
    transition.current = (next) => {
      if (next === currentScreen) return;
      flush();
      currentScreen = next;
      capture({ event: "screen_viewed", screen: currentScreen });
    };
    const visibility = () => {
      flush();
      visible = document.visibilityState === "visible";
    };
    const focus = () => {
      tick();
      focused = true;
      clock.interact(performance.now());
    };
    const blur = () => {
      flush();
      focused = false;
    };
    const activity = () => {
      tick();
      clock.interact(performance.now());
    };
    // Only static, explicitly authored data attributes are read. No DOM text/values/URLs.
    const action = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const element = event.target.closest<HTMLElement>(
        "[data-analytics-action]",
      );
      if (
        !element ||
        element.closest("[hidden]") ||
        element.matches(":disabled")
      )
        return;
      const isField = element.matches(
        "select, input:not([type=checkbox]):not([type=radio])",
      );
      if ((event.type === "change") !== isField) return;
      const id = actions.find(
        (value) => value === element.dataset.analyticsAction,
      );
      if (id)
        capture({ event: "action_clicked", action: id, screen: currentScreen });
    };
    const ticker = window.setInterval(tick, 5000);
    const flusher = window.setInterval(flush, 30000);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    window.addEventListener("pagehide", flush);
    for (const name of ["pointerdown", "keydown", "scroll"])
      document.addEventListener(name, activity, true);
    document.addEventListener("click", action, true);
    document.addEventListener("change", action, true);
    return () => {
      // Cleanup after revoke must not send a final event or attribute it to a new ID.
      clearInterval(ticker);
      clearInterval(flusher);
      transition.current = () => {};
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      window.removeEventListener("pagehide", flush);
      for (const name of ["pointerdown", "keydown", "scroll"])
        document.removeEventListener(name, activity, true);
      document.removeEventListener("click", action, true);
      document.removeEventListener("change", action, true);
    };
  }, [status.choice, status.consentId]);
  return status;
}
