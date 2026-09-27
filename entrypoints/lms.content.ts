import { NavigationCatalog } from "../src/navigation-catalog";
import { safeDownloadPath } from "../src/security/download";
import { defineContentScript } from "wxt/utils/define-content-script";
import { listCourses, listQuery } from "../src/api/client";
import {
  panelQuery,
  parseResult,
  validHandle,
  type Result,
  type Request,
} from "../src/protocol";
import { QueryResultCache } from "../src/query-result-cache";
import { allowedPage, LMS_MATCHES, readUrl } from "../src/security/policy";
import {
  backgroundSender,
  object,
  type DiscoveryResult,
  type PlaybackDiscovery,
} from "../src/playback/bridge";
import { readJsonBounded } from "../src/api/body";
import { nextPage } from "../src/api/pagination";
import { rows } from "../src/domain-items";
import {
  accessible,
  internalId,
  recordingCandidate,
  recordingLabel,
} from "../src/recordings";
import type { PlaybackCandidate } from "../src/playback/playlist";

const cacheTtl = (request: Request): number | undefined => {
  switch (request.type) {
    case "COURSES_LIST":
      return 120_000;
    case "ASSIGNMENTS_LIST":
    case "DEADLINES_LIST":
    case "UPCOMING_LIST":
    case "TODO_LIST":
      return 30_000;
    default:
      return undefined;
  }
};

async function currentAccount(
  origin: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const controller = new AbortController();
  // Two identity checks wrap a list miss. Keep their combined budget below
  // the 23s panel deadline while listQuery retains its own 20s bound.
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetcher(
      readUrl("/api/v1/users/self", origin, "/api/v1/users/self").href,
      {
        method: "GET",
        credentials: "same-origin",
        redirect: "manual",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    );
    if (
      response.type === "opaqueredirect" ||
      response.status === 401 ||
      (response.status >= 300 && response.status < 400) ||
      response.headers.get("content-type")?.includes("text/html")
    )
      throw new Error("LOGIN_REQUIRED");
    if (response.status === 403) throw new Error("FORBIDDEN");
    if (!response.ok) throw new Error("NETWORK");
    if (
      !/^application\/json\b/i.test(response.headers.get("content-type") ?? "")
    )
      throw new Error("INVALID_RESPONSE");
    const value = await readJsonBounded(response);
    const id = object(value) ? internalId(value.id) : undefined;
    if (!id) throw new Error("LOGIN_REQUIRED");
    return id;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function accountError(error: unknown): Result {
  const known = [
    "LOGIN_REQUIRED",
    "FORBIDDEN",
    "NETWORK",
    "INVALID_RESPONSE",
  ] as const;
  return {
    status: "error",
    code:
      known.find((code) => error instanceof Error && error.message === code) ??
      "NETWORK",
  };
}

/** Closed, GET-only discovery. No caller-supplied endpoint or navigation target. */
export async function discoverPlayback(
  origin: string,
  salt: string,
  fetcher: typeof fetch = fetch,
): Promise<DiscoveryResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 20000);
  let pages = 0;
  async function read(url: string): Promise<Response> {
    if (++pages > 100) throw new Error("LIMIT");
    const response = await fetcher(url, {
      method: "GET",
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (
      response.type === "opaqueredirect" ||
      response.status === 401 ||
      (response.status >= 300 && response.status < 400) ||
      response.headers.get("content-type")?.includes("text/html")
    )
      throw new Error("LOGIN_REQUIRED");
    if (response.status === 403) throw new Error("FORBIDDEN");
    if (!response.ok) throw new Error("NETWORK");
    if (
      !/^application\/json\b/i.test(response.headers.get("content-type") ?? "")
    )
      throw new Error("INVALID_RESPONSE");
    return response;
  }
  async function identity(): Promise<string> {
    const value = await readJsonBounded(
      await read(
        readUrl("/api/v1/users/self", origin, "/api/v1/users/self").href,
      ),
    );
    const id = object(value) ? internalId(value.id) : undefined;
    if (!id) throw new Error("LOGIN_REQUIRED");
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `unidock-playback-v1\0${salt}\0${origin}\0${id}`,
      ),
    );
    return Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  async function collect(
    path: string,
    query: string,
  ): Promise<Record<string, unknown>[]> {
    let url: string | null = readUrl(`${path}?${query}`, origin, path).href;
    const result: Record<string, unknown>[] = [],
      seen = new Set<string>();
    while (url) {
      if (seen.has(url)) throw new Error("LIMIT");
      seen.add(url);
      const response = await read(readUrl(url, origin, path).href);
      result.push(...rows(await readJsonBounded(response)));
      if (result.length > 10000) throw new Error("LIMIT");
      url = nextPage(response.headers.get("link"), origin, path);
    }
    return result;
  }
  try {
    if (
      !allowedPage(origin) ||
      new URL(origin).origin !== origin ||
      !/^[a-f0-9]{64}$/.test(salt)
    )
      throw new Error("POLICY");
    const accountKey = await identity();
    const courses: { id: string; name: string }[] = [];
    const candidates: PlaybackCandidate[] = [];
    const now = Date.now();
    for (const course of await collect(
      "/api/v1/courses",
      "per_page=100&enrollment_state=active",
    )) {
      const courseId = internalId(course.id);
      if (!courseId || typeof course.name !== "string") continue;
      courses.push({ id: courseId, name: recordingLabel(course.name) });
      if (courses.length > 100) throw new Error("LIMIT");
      const modulesPath = `/api/v1/courses/${courseId}/modules`;
      for (const module of await collect(
        modulesPath,
        "per_page=100&include[]=items&include[]=content_details",
      )) {
        if (!accessible(module, now)) continue;
        if (
          module.items_count != null &&
          (!Number.isSafeInteger(module.items_count) ||
            Number(module.items_count) < 0)
        )
          throw new Error("INVALID_RESPONSE");
        let items = Array.isArray(module.items) ? module.items : [];
        if (
          Number(module.items_count) > items.length ||
          (module.items == null && module.items_count !== 0)
        ) {
          const moduleId = internalId(module.id);
          if (!moduleId) throw new Error("INVALID_RESPONSE");
          items = await collect(
            `${modulesPath}/${moduleId}/items`,
            "per_page=100&include[]=content_details",
          );
        }
        for (const item of rows(items)) {
          if (!recordingCandidate(item, now)) continue;
          const itemId = internalId(item.id);
          if (!itemId) continue;
          candidates.push({
            id: `${courseId}:${itemId}`,
            courseId,
            title: recordingLabel(item.title),
          });
          // Canvas completion and due-date fields do not prove KUCOM attendance or credit.
          if (candidates.length > 10000) throw new Error("LIMIT");
        }
      }
    }
    if ((await identity()) !== accountKey) throw new Error("ACCOUNT_CHANGED");
    const discovery: PlaybackDiscovery = {
      accountKey,
      origin,
      courses,
      candidates,
    };
    return { status: "success", discovery };
  } catch (error) {
    const known = [
      "LOGIN_REQUIRED",
      "FORBIDDEN",
      "NETWORK",
      "INVALID_RESPONSE",
      "POLICY",
      "LIMIT",
      "ACCOUNT_CHANGED",
    ] as const;
    const code = timedOut
      ? "TIMEOUT"
      : (known.find(
          (code) => error instanceof Error && error.message === code,
        ) ?? "NETWORK");
    return { status: "error", code };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
export default defineContentScript({
  matches: LMS_MATCHES,
  runAt: "document_idle",
  allFrames: false,
  main() {
    const catalog = new NavigationCatalog();
    const cache = new QueryResultCache();
    let cacheAccount: string | undefined;
    let lifecycleEpoch = 0;
    const clearCachedState = () => {
      lifecycleEpoch++;
      cache.clear();
      cacheAccount = undefined;
      catalog.clear();
    };
    globalThis.addEventListener?.("pagehide", clearCachedState);
    async function open(
      handle: string,
      type: "RECORDING_OPEN" | "DOCUMENT_OPEN",
    ): Promise<Result> {
      const url = catalog.take(
        handle,
        location.origin,
        Date.now(),
        type === "DOCUMENT_OPEN" ? "document" : "recording",
      );
      if (!url) return { status: "error", code: "STALE_SELECTION" };
      try {
        const result: unknown = await chrome.runtime.sendMessage({
          version: 1,
          type: "OPEN_LMS_TARGET",
          url,
        });
        return parseResult(result, {
          version: 1,
          type,
          handle,
        });
      } catch {
        return { status: "error", code: "TAB_OPEN_FAILED" };
      }
    }
    async function download(
      message: Extract<Request, { type: "DOCUMENT_DOWNLOAD" }>,
    ): Promise<Result> {
      const entry = catalog.takeDownload(message.handle, location.origin);
      if (!entry) return { status: "error", code: "STALE_SELECTION" };
      const filename = safeDownloadPath(
        message.course,
        entry.module,
        entry.title,
      );
      if (!filename) return { status: "error", code: "POLICY" };
      try {
        const result: unknown = await chrome.runtime.sendMessage({
          version: 1,
          type: "DOWNLOAD_LMS_FILE",
          url: entry.url,
          filename,
        });
        return parseResult(result, message);
      } catch {
        return { status: "error", code: "DOWNLOAD_FAILED" };
      }
    }
    let playbackPending: Promise<DiscoveryResult> | undefined;
    interface CachedOwner {
      account: string;
      epoch: number;
    }
    interface PendingQuery {
      key: string;
      result: Promise<Result>;
      owner?: Promise<CachedOwner | undefined>;
    }
    let pending: PendingQuery | undefined;
    const invalidateScope = (epoch: number) => {
      if (epoch !== lifecycleEpoch) return;
      clearCachedState();
    };
    async function list(
      message: Request,
      refresh: boolean,
      initialEpoch?: number,
      initialAccount?: Promise<string>,
      publishOwner?: (owner: CachedOwner | undefined) => void,
    ): Promise<Result> {
      const ttl = cacheTtl(message);
      const execute = () =>
        message.type === "COURSES_LIST"
          ? listCourses(location.origin)
          : message.type === "RECORDINGS_LIST" ||
              message.type === "DOCUMENTS_LIST"
            ? listQuery(location.origin, message, fetch, Date.now(), catalog)
            : listQuery(location.origin, message);
      if (ttl === undefined) {
        const result = await execute();
        if (
          result.status === "error" &&
          (result.code === "LOGIN_REQUIRED" || result.code === "FORBIDDEN")
        )
          clearCachedState();
        return result;
      }

      let epoch = initialEpoch ?? lifecycleEpoch;
      let account: string;
      try {
        account = await (initialAccount ?? currentAccount(location.origin));
      } catch (error) {
        publishOwner?.(undefined);
        if (epoch !== lifecycleEpoch)
          return { status: "error", code: "RELOAD_TAB" };
        invalidateScope(epoch);
        return accountError(error);
      }
      if (epoch !== lifecycleEpoch) {
        publishOwner?.(undefined);
        return { status: "error", code: "RELOAD_TAB" };
      }
      if (cacheAccount !== account) {
        if (cacheAccount !== undefined) {
          invalidateScope(epoch);
          epoch = lifecycleEpoch;
        }
        cacheAccount = account;
      }
      publishOwner?.({ account, epoch });
      const key = JSON.stringify(message);
      if (!refresh) {
        const hit = cache.get(key);
        if (hit) return hit;
      }
      const result = await execute();
      if (epoch !== lifecycleEpoch)
        return { status: "error", code: "RELOAD_TAB" };
      if (
        result.status === "error" &&
        (result.code === "LOGIN_REQUIRED" || result.code === "FORBIDDEN")
      ) {
        clearCachedState();
        return result;
      }
      if (result.status !== "success") return result;
      let confirmedAccount: string;
      try {
        confirmedAccount = await currentAccount(location.origin);
      } catch (error) {
        if (epoch !== lifecycleEpoch)
          return { status: "error", code: "RELOAD_TAB" };
        invalidateScope(epoch);
        return accountError(error);
      }
      if (epoch !== lifecycleEpoch)
        return { status: "error", code: "RELOAD_TAB" };
      if (confirmedAccount !== account) {
        invalidateScope(epoch);
        return { status: "error", code: "LOGIN_REQUIRED" };
      }
      cache.set(key, result, ttl);
      return result;
    }
    chrome.runtime.onMessage.addListener(
      (message: unknown, sender, respond) => {
        if (
          object(message) &&
          message.version === 1 &&
          backgroundSender(sender) &&
          allowedPage(location.href) &&
          typeof message.salt === "string" &&
          /^[a-f0-9]{64}$/.test(message.salt)
        ) {
          if (
            message.type === "PLAYBACK_DISCOVER" &&
            Object.keys(message).length === 3
          ) {
            const href = location.href;
            playbackPending ??= discoverPlayback(
              location.origin,
              message.salt,
            ).finally(() => {
              playbackPending = undefined;
            });
            void playbackPending.then((result) =>
              respond(
                location.href === href
                  ? result
                  : { status: "error", code: "RELOAD_TAB" },
              ),
            );
            return true;
          }
          if (
            message.type === "PLAYBACK_RESOLVE" &&
            Object.keys(message).length === 4 &&
            validHandle(message.handle)
          ) {
            const url = catalog.take(message.handle, location.origin);
            const ids = url
              ? /^\/courses\/([1-9]\d{0,19})\/modules\/items\/([1-9]\d{0,19})$/.exec(
                  new URL(url).pathname,
                )
              : null;
            if (!ids) {
              respond({ status: "error", code: "STALE_SELECTION" });
              return false;
            }
            const href = location.href;
            void discoverPlayback(location.origin, message.salt).then(
              (result) => {
                if (location.href !== href) {
                  respond({ status: "error", code: "RELOAD_TAB" });
                  return;
                }
                if (result.status === "error") {
                  respond(result);
                  return;
                }
                const candidate = result.discovery.candidates.find(
                  (item) =>
                    item.courseId === ids[1] &&
                    item.id === `${ids[1]}:${ids[2]}`,
                );
                respond(
                  candidate
                    ? {
                        status: "success",
                        resolved: {
                          discovery: result.discovery,
                          id: candidate.id,
                          courseId: candidate.courseId,
                        },
                      }
                    : { status: "error", code: "STALE_SELECTION" },
                );
              },
            );
            return true;
          }
        }
        const parsed = panelQuery(message);
        if (
          sender.id !== chrome.runtime.id ||
          sender.url !== chrome.runtime.getURL("sidepanel.html") ||
          !parsed ||
          !allowedPage(location.href)
        )
          return false;
        const request = parsed.request;
        const key = JSON.stringify(message);
        if (pending && pending.key !== key) {
          respond({ status: "error", code: "BUSY" });
          return false;
        }
        const joined = pending !== undefined;
        let operation = pending;
        if (!operation) {
          if (
            request.type !== "RECORDING_OPEN" &&
            request.type !== "DOCUMENT_OPEN" &&
            request.type !== "DOCUMENT_DOWNLOAD"
          )
            catalog.clear();
          const cacheable = cacheTtl(request) !== undefined;
          let resolveOwner:
            ((owner: CachedOwner | undefined) => void) | undefined;
          let owner: Promise<CachedOwner | undefined> | undefined;
          if (cacheable) {
            let publishOwner!: (owner: CachedOwner | undefined) => void;
            owner = new Promise<CachedOwner | undefined>((resolve) => {
              publishOwner = resolve;
            });
            let ownerPublished = false;
            resolveOwner = (value) => {
              if (ownerPublished) return;
              ownerPublished = true;
              publishOwner(value);
            };
          }
          let resolveResult!: (result: Result) => void;
          let rejectResult!: (error: unknown) => void;
          const sharedResult = new Promise<Result>((resolve, reject) => {
            resolveResult = resolve;
            rejectResult = reject;
          });
          operation = { key, result: sharedResult, owner };
          const ownedOperation = operation;
          ownedOperation.result = sharedResult.finally(() => {
            if (pending === ownedOperation) pending = undefined;
          });
          // Publish the stable operation slot before starting any identity or
          // query work, so every synchronously admitted follower captures it.
          pending = ownedOperation;
          let result: Promise<Result>;
          if (cacheable) {
            const epoch = lifecycleEpoch;
            const account = currentAccount(location.origin);
            result = list(
              request,
              parsed.refresh,
              epoch,
              account,
              resolveOwner,
            ).finally(() => resolveOwner?.(undefined));
          } else {
            result =
              request.type === "DOCUMENT_DOWNLOAD"
                ? download(request)
                : request.type === "RECORDING_OPEN" ||
                    request.type === "DOCUMENT_OPEN"
                  ? open(request.handle, request.type)
                  : list(request, parsed.refresh);
          }
          void result.then(resolveResult, rejectResult);
        }
        const captured = operation;
        if (!captured.owner) {
          void captured.result.then(respond);
          return true;
        }
        if (!joined) {
          void (async (): Promise<Result> => {
            const owner = await captured.owner;
            const result = await captured.result;
            if (
              result.status === "success" &&
              (!owner || owner.epoch !== lifecycleEpoch)
            )
              return { status: "error", code: "RELOAD_TAB" };
            return result;
          })().then(respond);
          return true;
        }
        const callerEpoch = lifecycleEpoch;
        const callerAccount = currentAccount(location.origin);
        void (async (): Promise<Result> => {
          let account: string;
          try {
            account = await callerAccount;
          } catch (error) {
            if (callerEpoch !== lifecycleEpoch)
              return { status: "error", code: "RELOAD_TAB" };
            invalidateScope(callerEpoch);
            return accountError(error);
          }
          if (callerEpoch !== lifecycleEpoch)
            return { status: "error", code: "RELOAD_TAB" };
          const owner = await captured.owner;
          if (!owner) {
            const result = await captured.result;
            if (result.status === "success" && callerEpoch !== lifecycleEpoch)
              return { status: "error", code: "RELOAD_TAB" };
            return result;
          }
          if (owner.epoch !== callerEpoch)
            return { status: "error", code: "RELOAD_TAB" };
          if (owner.account !== account) {
            invalidateScope(owner.epoch);
            return { status: "error", code: "LOGIN_REQUIRED" };
          }
          const result = await captured.result;
          if (
            result.status === "success" &&
            (owner.epoch !== lifecycleEpoch || callerEpoch !== lifecycleEpoch)
          )
            return { status: "error", code: "RELOAD_TAB" };
          return result;
        })().then(respond);
        return true;
      },
    );
  },
});
