import {
  allowedCaptionMediaUrl,
  CAPTION_MEDIA_ORIGIN_PATTERN,
  LMS_ORIGINS,
} from "../security/policy";

const PLAYER_ORIGIN = "https://kucom.korea.ac.kr";
// The player runs as its own tab or inside a lecture page on the LMS.
const PLAYER_TAB_ORIGINS: readonly string[] = [PLAYER_ORIGIN, ...LMS_ORIGINS];

/**
 * Ask for the optional CDN host grant. Without it the session rule cannot set
 * Referer and the CDN's missing CORS headers block the read. Call it first in
 * the click handler, before any await, so the user gesture is still active.
 */
export function requestCaptionMediaAccess(): Promise<boolean> {
  return chrome.permissions
    .request({ origins: [CAPTION_MEDIA_ORIGIN_PATTERN] })
    .catch(() => false);
}

export interface MediaSource {
  mediaUrl: string;
  durationS: number;
  contentId: string;
  /** Tab title as the professor wrote it; stays in the browser. */
  title: string;
  tabId: number;
  windowId: number;
}

/**
 * Reads the KU player's media descriptor from the current page. Serialized into
 * the tab by chrome.scripting, so it is self-contained and reads only own data
 * descriptors — never player methods or accessors.
 */
export function readPlayerMedia(): {
  mediaUrl: string;
  durationS: number;
  contentId: string;
} | null {
  const own = (value: unknown, key: string): unknown => {
    if (!value || (typeof value !== "object" && typeof value !== "function"))
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const data = (value: unknown, key: string): unknown => {
    for (let depth = 0; value && typeof value === "object" && depth < 5; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
      value = Object.getPrototypeOf(value);
    }
    return undefined;
  };
  const string = (value: unknown): string =>
    typeof value === "string" ? value : "";
  // Only the KU player document; an LMS page hosting it holds no descriptor.
  if (
    location.origin !== "https://kucom.korea.ac.kr" ||
    !location.pathname.startsWith("/em/")
  )
    return null;
  const pattern =
    /^https:\/\/korea-cms-object\.cdn\.gov-ntruss\.com\/contents7\/kruniv1001\/([0-9a-f]{13})\/contents\/media_files\/[\w.-]+\.mp4$/;
  const config = own(window, "uniPlayerConfig");
  if (!config) return null;
  const info = data(config, "_contentPlayingInfoData");
  if (!info) return null;
  const stories = data(info, "storyList");
  if (!Array.isArray(stories) || stories.length > 200) return null;
  const durationValue = data(info, "contentDuration") ?? data(info, "duration");
  const duration =
    typeof durationValue === "number" || typeof durationValue === "string"
      ? Number(durationValue)
      : 0;
  const durationS = Number.isFinite(duration) && duration > 0 ? duration : 0;
  for (let index = 0; index < stories.length; index++) {
    const story = own(stories, String(index));
    if (!story || data(story, "isIntro") === true) continue;
    const mainMediaList = data(story, "mainMediaList");
    const list = data(mainMediaList, "list");
    if (!Array.isArray(list)) continue;
    for (let mediaIndex = 0; mediaIndex < list.length; mediaIndex++) {
      const media = own(list, String(mediaIndex));
      const uri = string(data(media, "desktopMediaUri"));
      const match = pattern.exec(uri);
      if (match)
        return { mediaUrl: uri, durationS, contentId: match[1]! };
    }
  }
  return null;
}

export class MediaSourceError extends Error {
  constructor(readonly code: "ACTIVATE_TAB" | "UNSUPPORTED_MEDIA") {
    super(code);
  }
}

export async function identifyMedia(): Promise<MediaSource> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (
    tab?.id === undefined ||
    !tab.url ||
    !PLAYER_TAB_ORIGINS.includes(new URL(tab.url).origin)
  )
    throw new MediaSourceError("ACTIVATE_TAB");
  let results: chrome.scripting.InjectionResult<ReturnType<typeof readPlayerMedia>>[];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: "MAIN",
      func: readPlayerMedia,
    });
  } catch {
    throw new MediaSourceError("UNSUPPORTED_MEDIA");
  }
  for (const entry of results) {
    const found = entry.result;
    if (found && allowedCaptionMediaUrl(found.mediaUrl))
      return { ...found, title: tab.title ?? "", tabId: tab.id, windowId: tab.windowId };
  }
  throw new MediaSourceError("UNSUPPORTED_MEDIA");
}
