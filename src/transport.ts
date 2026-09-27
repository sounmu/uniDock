import {
  isRequest,
  parseResult,
  request,
  type Request,
  type Result,
  type PanelQueryMessage,
  type ListRequest,
  type CapabilityListRequest,
  DOWNLOAD_REQUEST_WINDOW_MS,
} from "./protocol";
import { allowedPage } from "./security/policy";
export interface QueryTarget {
  id: number;
  url: string;
  /** Ephemeral content-document identity; present for recording catalogs. */
  documentToken?: string;
}
export interface QueryOptions {
  target?: QueryTarget;
  onTarget?: (target: QueryTarget) => void;
  /** Explicit user refresh: bypass a short-lived content-script cache. */
  refresh?: boolean;
  /** Stable identity of one mounted capability-list consumer. */
  capabilityScope?: string;
}
export async function queryActive(
  query: Request,
  options: QueryOptions = {},
): Promise<Result> {
  if (!isRequest(query)) return { status: "error", code: "POLICY" };
  const deadline = Date.now() + DOWNLOAD_REQUEST_WINDOW_MS;
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
      if (timedOut()) return { status: "error", code: "TIMEOUT" };
      if (options.refresh && !query.type.endsWith("_LIST"))
        return { status: "error", code: "POLICY" };
      const capabilityList =
        query.type === "RECORDINGS_LIST" || query.type === "DOCUMENTS_LIST";
      if (
        (capabilityList && !validScope(options.capabilityScope)) ||
        (!capabilityList && options.capabilityScope !== undefined)
      )
        return { status: "error", code: "POLICY" };
      const message: PanelQueryMessage =
        query.type === "DOCUMENT_DOWNLOAD"
          ? {
              version: 1,
              type: "DOCUMENT_DOWNLOAD_REQUEST",
              deadline,
              request: query,
            }
          : capabilityList
            ? {
                version: 1,
                type: "CAPABILITY_LIST",
                scope: options.capabilityScope!,
                refresh: options.refresh === true,
                request: query as CapabilityListRequest,
              }
            : options.refresh
              ? {
                  version: 1,
                  type: "QUERY_REFRESH",
                  request: query as ListRequest,
                }
              : query;
      const result: unknown = await chrome.tabs.sendMessage(tab.id, message, {
        frameId: 0,
      });
      if (timedOut()) return { status: "error", code: "TIMEOUT" };
      const current = await chrome.tabs.get(tab.id);
      if (timedOut()) return { status: "error", code: "TIMEOUT" };
      if (current.url !== tab.url)
        return { status: "error", code: "RELOAD_TAB" };
      if (
        query.type === "RECORDINGS_LIST" &&
        result !== null &&
        typeof result === "object" &&
        "status" in result &&
        result.status === "success" &&
        (Object.keys(result).length !== 3 ||
          !("recordings" in result) ||
          !("documentToken" in result))
      )
        return { status: "error", code: "INVALID_RESPONSE" };
      const parsed = parseResult(result, query, new URL(tab.url).origin);
      if (parsed.status === "success") {
        const documentToken =
          result !== null &&
          typeof result === "object" &&
          "documentToken" in result &&
          typeof result.documentToken === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            result.documentToken,
          )
            ? result.documentToken
            : undefined;
        if (query.type === "RECORDINGS_LIST" && !documentToken)
          return { status: "error", code: "INVALID_RESPONSE" };
        options.onTarget?.({
          id: tab.id,
          url: tab.url,
          ...(documentToken ? { documentToken } : {}),
        });
      }
      return parsed;
    };
    return await Promise.race([work(), timeout]);
  } catch {
    return { status: "error", code: "RELOAD_TAB" };
  } finally {
    clearTimeout(timer);
  }
}

function validScope(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

export function queryActiveCourses(): Promise<Result> {
  return queryActive(request);
}
