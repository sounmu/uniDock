import { readJsonBounded } from "./body";
import { nextPage } from "./pagination";
import { allowedPage, readUrl } from "../security/policy";
import { rows } from "../domain-items";
import { projectCourseIndex } from "../domain";
import {
  object,
  type DiscoveryResult,
  type PlaybackDiscovery,
} from "../playback/bridge";
import {
  accessible,
  internalId,
  recordingCandidate,
  recordingLabel,
} from "../recordings";
import type { PlaybackCandidate } from "../playback/playlist";

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
      const projectedCourse = projectCourseIndex([course])[0];
      if (!projectedCourse) continue;
      const courseId = projectedCourse.id;
      courses.push({ id: courseId, name: projectedCourse.name });
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
