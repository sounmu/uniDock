import { NavigationCatalog } from "../src/navigation-catalog";
import { defineContentScript } from "wxt/utils/define-content-script";
import { listCourses, listQuery } from "../src/api/client";
import {
  isRequest,
  parseResult,
  validHandle,
  type Result,
} from "../src/protocol";
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
import type { PlaybackCandidate } from "../src/playback/scheduler";

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
            deadline: null,
            durationMinutes: null,
            completion: "unknown",
          });
          // LearningX/KUCOM duration and attendance fields have no live-session proof.
          // Never infer a duration, deadline or LMS credit from labels or arbitrary fields.
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
    async function open(handle: string): Promise<Result> {
      const url = catalog.take(handle, location.origin);
      if (!url) return { status: "error", code: "STALE_SELECTION" };
      try {
        const result: unknown = await chrome.runtime.sendMessage({
          version: 1,
          type: "OPEN_LMS_TARGET",
          url,
        });
        return parseResult(result, {
          version: 1,
          type: "RECORDING_OPEN",
          handle,
        });
      } catch {
        return { status: "error", code: "TAB_OPEN_FAILED" };
      }
    }
    let playbackPending: Promise<DiscoveryResult> | undefined;
    let pending: { key: string; result: Promise<Result> } | undefined;
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
        if (
          sender.id !== chrome.runtime.id ||
          sender.url !== chrome.runtime.getURL("sidepanel.html") ||
          !isRequest(message) ||
          !allowedPage(location.href)
        )
          return false;
        const key = JSON.stringify(message);
        if (pending && pending.key !== key) {
          respond({ status: "error", code: "BUSY" });
          return false;
        }
        if (!pending) {
          if (message.type !== "RECORDING_OPEN") catalog.clear();
          const result =
            message.type === "RECORDING_OPEN"
              ? open(message.handle)
              : message.type === "COURSES_LIST"
                ? listCourses(location.origin)
                : message.type === "RECORDINGS_LIST"
                  ? listQuery(
                      location.origin,
                      message,
                      fetch,
                      Date.now(),
                      catalog,
                    )
                  : listQuery(location.origin, message);
          pending = {
            key,
            result: result.finally(() => {
              pending = undefined;
            }),
          };
        }
        void pending.result.then(respond);
        return true;
      },
    );
  },
});
