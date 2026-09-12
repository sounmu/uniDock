import {
  isRequest,
  parseResult,
  request,
  type Request,
  type Result,
} from "./protocol";
import { allowedPage } from "./security/policy";
export interface QueryTarget {
  id: number;
  url: string;
}
export interface QueryOptions {
  target?: QueryTarget;
  onTarget?: (target: QueryTarget) => void;
}
export async function queryActive(
  query: Request,
  options: QueryOptions = {},
): Promise<Result> {
  if (!isRequest(query)) return { status: "error", code: "POLICY" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const tab =
      options.target ??
      (
        await chrome.tabs.query({
          active: true,
          currentWindow: true,
        })
      )[0];
    if (tab?.id === undefined || !tab.url || !allowedPage(tab.url))
      return { status: "error", code: "OPEN_LMS" };
    if (options.target) {
      const current = await chrome.tabs.get(tab.id);
      if (current.url !== tab.url)
        return { status: "error", code: "RELOAD_TAB" };
    }
    options.onTarget?.({ id: tab.id, url: tab.url });
    const result: unknown = await Promise.race([
      chrome.tabs.sendMessage(tab.id, query, { frameId: 0 }),
      new Promise<Result>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "error", code: "TIMEOUT" }),
          23000,
        );
      }),
    ]);
    const current = await chrome.tabs.get(tab.id);
    if (current.url !== tab.url) return { status: "error", code: "RELOAD_TAB" };
    return parseResult(result, query);
  } catch {
    return { status: "error", code: "RELOAD_TAB" };
  } finally {
    clearTimeout(timer);
  }
}

export function queryActiveCourses(): Promise<Result> {
  return queryActive(request);
}
