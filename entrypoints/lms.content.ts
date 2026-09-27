import { NavigationCatalog } from "../src/navigation-catalog";
import {
  NavigationCatalogRegistry,
  type NavigationCatalogAdmission,
} from "../src/navigation-catalog-registry";
import { safeDownloadPath } from "../src/security/download";
import { defineContentScript } from "wxt/utils/define-content-script";
import { listCourses, listQuery } from "../src/api/client";
import {
  panelQuery,
  parseResult,
  validDownloadDeadline,
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

function accountError(error: unknown): Extract<Result, { status: "error" }> {
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
  expectedAccount?: string,
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
  async function identity(): Promise<{ account: string; key: string }> {
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
    return {
      account: id,
      key: Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    };
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
    const identityBefore = await identity();
    if (
      expectedAccount !== undefined &&
      identityBefore.account !== expectedAccount
    )
      throw new Error("ACCOUNT_CHANGED");
    const accountKey = identityBefore.key;
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
    const identityAfter = await identity();
    if (
      identityAfter.account !== identityBefore.account ||
      identityAfter.key !== accountKey
    )
      throw new Error("ACCOUNT_CHANGED");
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
    const documentToken = crypto.randomUUID();
    const catalogs = new NavigationCatalogRegistry();
    const cache = new QueryResultCache();
    let cacheAccount: string | undefined;
    let lifecycleEpoch = 0;
    const clearCachedState = () => {
      lifecycleEpoch++;
      cache.clear();
      cacheAccount = undefined;
      catalogs.revokeAll();
    };
    globalThis.addEventListener?.("pagehide", clearCachedState);
    async function open(
      handle: string,
      type: "RECORDING_OPEN" | "DOCUMENT_OPEN",
    ): Promise<Result> {
      const epoch = lifecycleEpoch;
      const catalog = catalogs.findPublished(handle);
      let account: string;
      try {
        account = await currentAccount(location.origin);
      } catch (error) {
        if (epoch !== lifecycleEpoch)
          return { status: "error", code: "RELOAD_TAB" };
        invalidateScope(epoch);
        return accountError(error);
      }
      if (epoch !== lifecycleEpoch)
        return { status: "error", code: "RELOAD_TAB" };
      if (!catalog || !catalogs.isPublished(catalog) || !catalog.hasOwner())
        return { status: "error", code: "STALE_SELECTION" };
      if (!catalog.ownedBy(account, epoch)) {
        invalidateScope(epoch);
        return { status: "error", code: "LOGIN_REQUIRED" };
      }
      const url = catalog.take(
        handle,
        location.origin,
        Date.now(),
        type === "DOCUMENT_OPEN" ? "document" : "recording",
      );
      if (!url) return { status: "error", code: "STALE_SELECTION" };
      try {
        const dispatched = chrome.runtime.sendMessage({
          version: 1,
          type: "OPEN_LMS_TARGET",
          url,
        });
        const result: unknown = await dispatched;
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
      deadline: number,
    ): Promise<Result> {
      const epoch = lifecycleEpoch;
      const catalog = catalogs.findPublished(message.handle);
      let account: string;
      try {
        account = await currentAccount(location.origin);
      } catch (error) {
        if (epoch !== lifecycleEpoch)
          return { status: "error", code: "RELOAD_TAB" };
        invalidateScope(epoch);
        return accountError(error);
      }
      if (epoch !== lifecycleEpoch)
        return { status: "error", code: "RELOAD_TAB" };
      if (!catalog || !catalogs.isPublished(catalog) || !catalog.hasOwner())
        return { status: "error", code: "STALE_SELECTION" };
      if (!catalog.ownedBy(account, epoch)) {
        invalidateScope(epoch);
        return { status: "error", code: "LOGIN_REQUIRED" };
      }
      // Account verification is the final await before accepting the one-use
      // capability. An expired panel operation must not spend it.
      if (!validDownloadDeadline(deadline))
        return { status: "error", code: "TIMEOUT" };
      const entry = catalog.takeDownload(message.handle, location.origin);
      if (!entry) return { status: "error", code: "STALE_SELECTION" };
      const filename = safeDownloadPath(
        message.course,
        entry.module,
        entry.title,
      );
      if (!filename) return { status: "error", code: "POLICY" };
      try {
        const dispatched = chrome.runtime.sendMessage({
          version: 1,
          type: "DOWNLOAD_LMS_FILE",
          deadline,
          url: entry.url,
          filename,
        });
        const result: unknown = await dispatched;
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
      scope?: string;
      admission?: NavigationCatalogAdmission;
    }
    const pending = new Map<string, PendingQuery>();
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
      admission?: NavigationCatalogAdmission,
    ): Promise<Result> {
      const ttl = cacheTtl(message);
      const capabilityList =
        message.type === "RECORDINGS_LIST" || message.type === "DOCUMENTS_LIST";
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
      if (ttl !== undefined && refresh) cache.delete(key);
      if (ttl !== undefined && !refresh) {
        const hit = cache.get(key);
        if (hit) return hit;
      }
      let staging: NavigationCatalog | undefined;
      try {
        if (capabilityList) {
          if (!admission) return { status: "error", code: "POLICY" };
          staging = catalogs.begin(admission, account, epoch);
          if (!staging) return { status: "error", code: "RELOAD_TAB" };
        }
        const result = await (message.type === "COURSES_LIST"
          ? listCourses(location.origin)
          : staging
            ? listQuery(location.origin, message, fetch, Date.now(), staging)
            : listQuery(location.origin, message));
        if (epoch !== lifecycleEpoch)
          return { status: "error", code: "RELOAD_TAB" };
        if (
          result.status === "error" &&
          (result.code === "LOGIN_REQUIRED" || result.code === "FORBIDDEN")
        ) {
          invalidateScope(epoch);
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
        if (staging) {
          if (!staging.ownedBy(account, epoch))
            return { status: "error", code: "RELOAD_TAB" };
          if (!catalogs.publish(admission!, staging))
            return { status: "error", code: "RELOAD_TAB" };
        }
        if (ttl !== undefined) cache.set(key, result, ttl);
        return result;
      } finally {
        if (admission) catalogs.discard(admission, staging);
      }
    }
    async function scopedPlaybackDiscovery(
      salt: string,
      initialEpoch: number,
    ): Promise<DiscoveryResult> {
      let epoch = initialEpoch;
      let account: string;
      try {
        account = await currentAccount(location.origin);
      } catch (error) {
        if (epoch !== lifecycleEpoch)
          return { status: "error", code: "RELOAD_TAB" };
        invalidateScope(epoch);
        return accountError(error);
      }
      if (epoch !== lifecycleEpoch)
        return { status: "error", code: "RELOAD_TAB" };
      if (cacheAccount !== account) {
        if (cacheAccount !== undefined) {
          invalidateScope(epoch);
          epoch = lifecycleEpoch;
        }
        cacheAccount = account;
      }
      const result = await discoverPlayback(
        location.origin,
        salt,
        fetch,
        account,
      );
      if (epoch !== lifecycleEpoch)
        return { status: "error", code: "RELOAD_TAB" };
      if (result.status === "error") invalidateScope(epoch);
      return result;
    }
    chrome.runtime.onMessage.addListener(
      (message: unknown, sender, respond) => {
        if (
          object(message) &&
          message.version === 1 &&
          message.type === "DOWNLOAD_SOURCE_CHECK" &&
          Object.keys(message).length === 3 &&
          validHandle(message.nonce) &&
          backgroundSender(sender) &&
          allowedPage(location.href)
        ) {
          respond({
            version: 1,
            type: "DOWNLOAD_SOURCE_OK",
            nonce: message.nonce,
          });
          return false;
        }
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
            (Object.keys(message).length === 3 ||
              (Object.keys(message).length === 4 &&
                validHandle(message.documentToken)))
          ) {
            if (
              message.documentToken !== undefined &&
              message.documentToken !== documentToken
            ) {
              respond({ status: "error", code: "RELOAD_TAB" });
              return false;
            }
            const href = location.href;
            playbackPending ??= scopedPlaybackDiscovery(
              message.salt,
              lifecycleEpoch,
            ).finally(() => {
              playbackPending = undefined;
            });
            void playbackPending.then((result) => {
              respond(
                location.href !== href
                  ? { status: "error", code: "RELOAD_TAB" }
                  : result.status === "success"
                    ? { ...result, documentToken }
                    : result,
              );
            });
            return true;
          }
          if (
            message.type === "PLAYBACK_RESOLVE_BATCH" &&
            Object.keys(message).length === 5 &&
            message.documentToken === documentToken &&
            Array.isArray(message.handles) &&
            message.handles.length > 0 &&
            message.handles.length <= 100 &&
            message.handles.every(validHandle) &&
            new Set(message.handles).size === message.handles.length
          ) {
            const href = location.href;
            const epoch = lifecycleEpoch;
            const handles = message.handles;
            const catalog = catalogs.findPublished(handles[0]!);
            const salt = message.salt;
            void (async () => {
              let account: string;
              try {
                account = await currentAccount(location.origin);
              } catch (error) {
                if (epoch !== lifecycleEpoch)
                  respond({ status: "error", code: "RELOAD_TAB" });
                else {
                  invalidateScope(epoch);
                  respond(accountError(error));
                }
                return;
              }
              if (
                epoch !== lifecycleEpoch ||
                !catalog ||
                !catalogs.isPublished(catalog) ||
                location.href !== href
              ) {
                respond({ status: "error", code: "RELOAD_TAB" });
                return;
              }
              if (!catalog.hasOwner()) {
                respond({ status: "error", code: "STALE_SELECTION" });
                return;
              }
              if (!catalog.ownedBy(account, epoch)) {
                invalidateScope(epoch);
                respond({ status: "error", code: "LOGIN_REQUIRED" });
                return;
              }
              const reservation = catalogs.takeRecordingBatch(
                handles,
                location.origin,
                Date.now(),
              );
              if (!reservation) {
                respond({ status: "error", code: "STALE_SELECTION" });
                return;
              }
              try {
                const ids = reservation.urls.map((url) =>
                  /^\/courses\/([1-9]\d{0,19})\/modules\/items\/([1-9]\d{0,19})$/.exec(
                    new URL(url).pathname,
                  ),
                );
                if (ids.some((value) => !value)) {
                  respond({ status: "error", code: "STALE_SELECTION" });
                  return;
                }
                const discovery = discoverPlayback(
                  location.origin,
                  salt,
                  fetch,
                  account,
                );
                const result = await discovery;
                if (epoch !== lifecycleEpoch || location.href !== href) {
                  respond({ status: "error", code: "RELOAD_TAB" });
                  return;
                }
                if (result.status === "error") {
                  invalidateScope(epoch);
                  respond(result);
                  return;
                }
                if (
                  !catalogs.isPublished(catalog) ||
                  !catalog.ownedBy(account, epoch)
                ) {
                  respond({ status: "error", code: "RELOAD_TAB" });
                  return;
                }
                const items = ids.map((value) =>
                  result.discovery.candidates.find(
                    (item) =>
                      item.courseId === value![1] &&
                      item.id === `${value![1]}:${value![2]}`,
                  ),
                );
                respond(
                  items.every(Boolean) &&
                    new Set(items.map((item) => item!.id)).size === items.length
                    ? {
                        status: "success",
                        discovery: result.discovery,
                        items: items.map((item) => ({
                          id: item!.id,
                          courseId: item!.courseId,
                        })),
                      }
                    : { status: "error", code: "STALE_SELECTION" },
                );
              } finally {
                reservation.release();
              }
            })();
            return true;
          }
          if (
            message.type === "PLAYBACK_RESOLVE" ||
            message.type === "PLAYBACK_RESOLVE_BATCH" ||
            message.type === "PLAYBACK_DISCOVER"
          ) {
            respond({ status: "error", code: "RELOAD_TAB" });
            return false;
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
        const joined = pending.has(key);
        let operation = pending.get(key);
        if (
          !operation &&
          pending.size > 0 &&
          (!parsed.scope ||
            [...pending.values()].some((item) => item.scope === undefined))
        ) {
          respond({ status: "error", code: "BUSY" });
          return false;
        }
        if (!operation) {
          let admission: NavigationCatalogAdmission | undefined;
          if (parsed.scope) {
            try {
              admission = catalogs.admit(parsed.scope);
            } catch {
              respond({ status: "error", code: "LIMIT" });
              return false;
            }
          }
          const identityScoped = request.type.endsWith("_LIST");
          let resolveOwner:
            ((owner: CachedOwner | undefined) => void) | undefined;
          let owner: Promise<CachedOwner | undefined> | undefined;
          if (identityScoped) {
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
          operation = {
            key,
            result: sharedResult,
            owner,
            scope: parsed.scope,
            admission,
          };
          const ownedOperation = operation;
          ownedOperation.result = sharedResult.finally(() => {
            if (pending.get(key) === ownedOperation) pending.delete(key);
          });
          // Publish the stable operation slot before starting any identity or
          // query work, so every synchronously admitted follower captures it.
          pending.set(key, ownedOperation);
          let result: Promise<Result>;
          if (identityScoped) {
            const epoch = lifecycleEpoch;
            const account = currentAccount(location.origin);
            result = list(
              request,
              parsed.refresh,
              epoch,
              account,
              resolveOwner,
              admission,
            ).finally(() => resolveOwner?.(undefined));
          } else {
            result =
              request.type === "DOCUMENT_DOWNLOAD"
                ? download(request, parsed.deadline!)
                : request.type === "RECORDING_OPEN" ||
                    request.type === "DOCUMENT_OPEN"
                  ? open(request.handle, request.type)
                  : list(request, parsed.refresh);
          }
          void result.then(resolveResult, rejectResult);
        }
        const captured = operation;
        if (!captured.owner) {
          void captured.result.then((result) =>
            respond(
              request.type === "RECORDINGS_LIST" && result.status === "success"
                ? { ...result, documentToken }
                : result,
            ),
          );
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
          })().then((result) =>
            respond(
              request.type === "RECORDINGS_LIST" && result.status === "success"
                ? { ...result, documentToken }
                : result,
            ),
          );
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
        })().then((result) =>
          respond(
            request.type === "RECORDINGS_LIST" && result.status === "success"
              ? { ...result, documentToken }
              : result,
          ),
        );
        return true;
      },
    );
  },
});
