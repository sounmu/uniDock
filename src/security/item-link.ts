import { allowedPage } from "./policy";

export function itemUrl(value: unknown, origin?: string): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2000)
    return undefined;
  try {
    const url = new URL(value, origin ?? "https://mylms.korea.ac.kr");
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
