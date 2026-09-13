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
  const deadline = Date.now() + 23000;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = () => expired || Date.now() >= deadline;
  try {
    const timeout = new Promise<Result>((resolve) => {
      timer = setTimeout(
        () => {
          expired = true;
          resolve({ status: "error", code: "TIMEOUT" });
        },
        Math.max(0, deadline - Date.now()),
      );
    });
    const work = async (): Promise<Result> => {
      const tab =
        options.target ??
        (
          await chrome.tabs.query({
            active: true,
            currentWindow: true,
          })
        )[0];
      if (timedOut()) return { status: "error", code: "TIMEOUT" };
      if (tab?.id === undefined || !tab.url || !allowedPage(tab.url))
        return { status: "error", code: "OPEN_LMS" };
      if (options.target) {
        const current = await chrome.tabs.get(tab.id);
        if (timedOut()) return { status: "error", code: "TIMEOUT" };
        if (current.url !== tab.url)
          return { status: "error", code: "RELOAD_TAB" };
      }
      options.onTarget?.({ id: tab.id, url: tab.url });
      if (timedOut()) return { status: "error", code: "TIMEOUT" };
      const result: unknown = await chrome.tabs.sendMessage(tab.id, query, {
        frameId: 0,
      });
      if (timedOut()) return { status: "error", code: "TIMEOUT" };
      const current = await chrome.tabs.get(tab.id);
      if (timedOut()) return { status: "error", code: "TIMEOUT" };
      if (current.url !== tab.url)
        return { status: "error", code: "RELOAD_TAB" };
      return parseResult(result, query, new URL(tab.url).origin);
    };
    return await Promise.race([work(), timeout]);
  } catch {
    return { status: "error", code: "RELOAD_TAB" };
  } finally {
    clearTimeout(timer);
  }
}

export function queryActiveCourses(): Promise<Result> {
  return queryActive(request);
}
