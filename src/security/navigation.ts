import { allowedPage } from "./policy";
// The KU player (kucom) hosts lecture videos that LearningX board posts embed as
// iframes. A board video opens its canonical player page directly: the LMS has
// no clean route to one post inside the board tool.
export const PLAYER_ORIGIN = "https://kucom.korea.ac.kr";
export function playerUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== PLAYER_ORIGIN ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/em\/[0-9a-f]{8,32}$/.test(url.pathname)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
// Tabs may open only clean, canonical LMS course/module-item routes, including a
// course tool tab (Canvas launches it), or a canonical KU player page. No LTI
// URL proxy.
export function navigationUrl(value: unknown, source: string): string | null {
  if (typeof value !== "string" || value.length > 300 || !allowedPage(source))
    return null;
  const player = playerUrl(value);
  if (player) return player;
  try {
    const url = new URL(value);
    if (
      !allowedPage(value) ||
      url.origin !== new URL(source).origin ||
      url.search ||
      url.hash
    )
      return null;
    if (
      !/^\/courses\/[1-9]\d{0,19}\/(?:modules(?:\/items\/[1-9]\d{0,19})?|discussion_topics\/[1-9]\d{0,19}|external_tools\/[1-9]\d{0,19})$/.test(
        url.pathname,
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
