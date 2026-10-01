// This contract deliberately cannot carry LMS labels, identifiers, URLs or errors.
export const ANALYTICS_KEY = "unidock.analytics.v1";
export const ANALYTICS_HOST = "https://eu.i.posthog.com";
export const screens = [
  "COURSES_LIST",
  "ASSIGNMENTS_LIST",
  "TODO_LIST",
  "UPCOMING_LIST",
  "RECORDINGS_LIST",
  "DOCUMENTS_LIST",
  "PLAYBACK",
  "CAPTIONS",
  "INFO",
] as const;
export type AnalyticsScreen = (typeof screens)[number];
export const actions = [
  "nav_courses",
  "nav_tasks",
  "nav_playback",
  "nav_captions",
  "info",
  "lms_open",
  "privacy_open",
  "back",
  "refresh",
  "course_select",
  "tab_assignments",
  "tab_recordings",
  "tab_materials",
  "tasks_mode",
  "item_detail",
  "recording_launch",
  "recording_module",
  "document_open",
  "download_batch",
  "download_one",
  "download_cancel",
  "download_folder",
  "ai_handoff",
  "select_all",
  "select_item",
  "page_previous",
  "page_next",
  "filter_remaining",
  "filter_period",
  "sort",
  "date_start",
  "date_end",
  "view_options",
  "guidance",
  "captions_detect",
  "captions_export",
  "playback_select",
  "playback_course",
  "playback_load",
  "playback_start",
  "playback_stop",
  "playback_resume",
  "playback_cancel",
  "delete_prompt",
  "delete_cancel",
] as const;
export type AnalyticsAction = (typeof actions)[number];
export const features = [
  "courses",
  "assignments",
  "tasks",
  "recordings",
  "documents",
  "recording_open",
  "document_open",
  "download",
  "captions_detect",
  "captions_export",
  "ai_handoff",
  "playback_start",
  "playback_stop",
  "playback_resume",
  "playback_refresh",
] as const;
export type AnalyticsFeature = (typeof features)[number];
export type AnalyticsEvent =
  | { event: "panel_opened"; screen: AnalyticsScreen }
  | { event: "screen_viewed"; screen: AnalyticsScreen }
  | {
      event: "action_clicked";
      screen: AnalyticsScreen;
      action: AnalyticsAction;
    }
  | {
      event: "panel_engagement";
      screen: AnalyticsScreen;
      visible_seconds: number;
      active_seconds: number;
    }
  | {
      event: "feature_result";
      feature: AnalyticsFeature;
      outcome: "success" | "failure";
    };

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isInstallId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
  );
}
function member(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}
export function isAnalyticsEvent(value: unknown): value is AnalyticsEvent {
  if (!record(value)) return false;
  const count = Object.keys(value).length;
  if (value.event === "feature_result")
    return (
      count === 3 &&
      member(features, value.feature) &&
      member(["success", "failure"], value.outcome)
    );
  if (!member(screens, value.screen)) return false;
  switch (value.event) {
    case "panel_opened":
    case "screen_viewed":
      return count === 2;
    case "action_clicked":
      return count === 3 && member(actions, value.action);
    case "panel_engagement":
      return (
        count === 4 &&
        Number.isInteger(value.visible_seconds) &&
        Number.isInteger(value.active_seconds) &&
        (value.visible_seconds as number) >= 0 &&
        (value.visible_seconds as number) <= 60 &&
        (value.active_seconds as number) >= 0 &&
        (value.active_seconds as number) <= (value.visible_seconds as number)
      );
    default:
      return false;
  }
}
export type AnalyticsCommand =
  | { version: 1; type: "ANALYTICS_STATUS" }
  | { version: 1; type: "ANALYTICS_CONSENT"; enabled: boolean }
  | {
      version: 1;
      type: "ANALYTICS_CAPTURE";
      consentId: string;
      data: AnalyticsEvent;
    };
export function isAnalyticsCommand(value: unknown): value is AnalyticsCommand {
  if (!record(value) || value.version !== 1) return false;
  const count = Object.keys(value).length;
  return (
    (value.type === "ANALYTICS_STATUS" && count === 2) ||
    (value.type === "ANALYTICS_CONSENT" &&
      count === 3 &&
      typeof value.enabled === "boolean") ||
    (value.type === "ANALYTICS_CAPTURE" &&
      count === 4 &&
      isInstallId(value.consentId) &&
      isAnalyticsEvent(value.data))
  );
}
export interface AnalyticsStatus {
  available: boolean;
  choice: "undecided" | "enabled" | "disabled";
  consentId?: string;
}
export function isAnalyticsStatus(value: unknown): value is AnalyticsStatus {
  return (
    record(value) &&
    typeof value.available === "boolean" &&
    (value.choice === "enabled"
      ? Object.keys(value).length === 3 &&
        value.available &&
        isInstallId(value.consentId)
      : Object.keys(value).length === 2 &&
        (value.choice === "undecided" || value.choice === "disabled"))
  );
}
