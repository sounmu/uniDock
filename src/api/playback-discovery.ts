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

const COURSE_CONCURRENCY = 3;
const MAX_COURSES = 100;
const MAX_CANDIDATES = 10000;

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
  async function read(
    url: string,
    signal: AbortSignal = controller.signal,
  ): Promise<Response> {
    if (++pages > 100) throw new Error("LIMIT");
    const response = await fetcher(url, {
      method: "GET",
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
      signal,
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
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    let url: string | null = readUrl(`${path}?${query}`, origin, path).href;
    const result: Record<string, unknown>[] = [],
      seen = new Set<string>();
    while (url) {
      if (seen.has(url)) throw new Error("LIMIT");
      seen.add(url);
      const response = await read(readUrl(url, origin, path).href, signal);
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
    const indexed: { id: string; name: string }[] = [];
    for (const course of await collect(
      "/api/v1/courses",
      "per_page=100&enrollment_state=active",
    )) {
      const projectedCourse = projectCourseIndex([course])[0];
      if (projectedCourse) indexed.push(projectedCourse);
    }
    // Each course is still read fresh with the same GETs. Up to
    // COURSE_CONCURRENCY courses overlap; results are merged in course order and
    // the lowest-index failure wins, so listing order and error precedence match a sequential walk.
    // Every course reads under its own signal, linked to the overall deadline.
    // A failure at index F aborts only the reads after F, which can no longer
    // decide the result; lower unresolved courses keep running until they settle.
    // `buffered` is the one candidate budget shared by every overlapped course:
    // it is charged before a candidate is kept, so the MAX_CANDIDATES cap bounds
    // memory while courses are still being read, not only after they are merged.
    let buffered = 0;
    async function courseCandidates(
      courseId: string,
      signal: AbortSignal,
    ): Promise<PlaybackCandidate[]> {
      const found: PlaybackCandidate[] = [];
      const modulesPath = `/api/v1/courses/${courseId}/modules`;
      for (const module of await collect(
        modulesPath,
        "per_page=100&include[]=items&include[]=content_details",
        signal,
      )) {
        if (buffered > MAX_CANDIDATES) throw new Error("LIMIT");
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
            signal,
          );
        }
        for (const item of rows(items)) {
          if (!recordingCandidate(item, now)) continue;
          const itemId = internalId(item.id);
          if (!itemId) continue;
          if (++buffered > MAX_CANDIDATES) throw new Error("LIMIT");
          // Canvas completion and due-date fields do not prove KUCOM attendance or credit.
          found.push({
            id: `${courseId}:${itemId}`,
            courseId,
            title: recordingLabel(item.title),
          });
        }
      }
      return found;
    }
    // The course after MAX_COURSES is the LIMIT failure; it is never fetched.
    const fetchable = Math.min(indexed.length, MAX_COURSES);
    type CourseOutcome = { found: PlaybackCandidate[] } | { error: unknown };
    const settle: ((outcome: CourseOutcome) => void)[] = [];
    const outcomes = Array.from(
      { length: fetchable },
      (_, index) =>
        new Promise<CourseOutcome>((resolve) => {
          settle[index] = resolve;
        }),
    );
    const courseAborts: AbortController[] = [];
    let nextCourse = 0,
      firstFailure = Infinity;
    async function worker() {
      while (nextCourse < fetchable) {
        const index = nextCourse++;
        // A sequential walk would have stopped before reading this course.
        if (index > firstFailure || buffered > MAX_CANDIDATES) return;
        const own = new AbortController();
        courseAborts[index] = own;
        controller.signal.addEventListener("abort", () => own.abort(), {
          once: true,
        });
        try {
          settle[index]!({
            found: await courseCandidates(indexed[index]!.id, own.signal),
          });
        } catch (error) {
          settle[index]!({ error });
          if (index < firstFailure) {
            firstFailure = index;
            courseAborts.forEach((later, laterIndex) => {
              if (laterIndex > index) later.abort();
            });
          }
        }
      }
    }
    // Workers are not awaited: the merge below returns as soon as the course
    // that decides the result has settled. `finally` aborts whatever is left.
    for (let i = 0; i < Math.min(COURSE_CONCURRENCY, fetchable); i++) void worker();
    for (const [index, course] of indexed.entries()) {
      courses.push({ id: course.id, name: course.name });
      if (courses.length > MAX_COURSES) throw new Error("LIMIT");
      const result = await outcomes[index]!;
      if ("error" in result) throw result.error;
      candidates.push(...result.found);
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
