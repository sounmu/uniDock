import { allowedPage } from "./policy";

export function itemUrl(
  value: unknown,
  origin = "https://mylms.korea.ac.kr",
): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2000)
    return undefined;
  try {
    const url = new URL(value, origin);
    if (
      !allowedPage(url.href) ||
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
