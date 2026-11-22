import { allowedPage } from "./policy";
import { KOREA_ORIGINS } from "./origins";

export function itemUrl(value: unknown, origin?: string): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2000)
    return undefined;
  try {
    const url = new URL(value, origin ?? KOREA_ORIGINS.lms[0]);
    if (
      !allowedPage(url.href) ||
      (origin !== undefined && url.origin !== origin) ||
      !/^\/(?:courses\/[1-9]\d*\/(?:assignments|discussion_topics|quizzes|pages)\/[^/]+|calendar)$/.test(
        url.pathname,
      )
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
