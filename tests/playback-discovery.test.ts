import { expect, it, vi } from "vitest";
import { discoverPlayback } from "../src/api/playback-discovery";

const origin = "https://mylms.korea.ac.kr";
const salt = "a".repeat(64);

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}
const courseModules = (courseId: number) => [
  {
    id: 1,
    items_count: 1,
    items: [
      {
        id: courseId * 10,
        type: "ExternalTool",
        title: `Lecture ${courseId}`,
        url: "https://example.invalid",
      },
    ],
  },
];
function courseList(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: 100 + i,
    name: `Course ${i}`,
  }));
}
/** Serves identity and course listing immediately; course modules go through `modules`. */
function lms(
  count: number,
  modules: (
    courseId: number,
    signal: AbortSignal | null | undefined,
  ) => Promise<Response> | Response,
) {
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    requested.push(path);
    if (path === "/api/v1/users/self") return json({ id: 42 });
    if (path === "/api/v1/courses") return json(courseList(count));
    const match = path.match(/^\/api\/v1\/courses\/(\d+)\/modules$/);
    if (match) return modules(Number(match[1]), init?.signal);
    throw new Error("unexpected endpoint");
  };
  return { fetcher, requested };
}
/** A read that never answers and rejects only when its own signal aborts. */
function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true },
    );
  });
}

it("overlaps at most three course module reads and still lists candidates in course order", async () => {
  const gates = new Map<number, ReturnType<typeof deferred<Response>>>();
  let live = 0,
    peak = 0;
  const { fetcher, requested } = lms(5, async (courseId) => {
    live++;
    peak = Math.max(peak, live);
    const gate = deferred<Response>();
    gates.set(courseId, gate);
    const response = await gate.promise;
    live--;
    return response;
  });
  const discovery = discoverPlayback(origin, salt, fetcher);
  await vi.waitFor(() => expect(gates.size).toBe(3));
  expect([...gates.keys()]).toEqual([100, 101, 102]);
  // Later courses answer first; the fourth read starts only when a slot frees.
  gates.get(102)!.resolve(json(courseModules(102)));
  await vi.waitFor(() => expect(gates.has(103)).toBe(true));
  gates.get(101)!.resolve(json(courseModules(101)));
  await vi.waitFor(() => expect(gates.has(104)).toBe(true));
  for (const id of [104, 103, 100])
    gates.get(id)!.resolve(json(courseModules(id)));
  const result = await discovery;
  expect(peak).toBe(3);
  expect(result.status).toBe("success");
  if (result.status !== "success") throw new Error(result.code);
  expect(result.discovery.courses.map((course) => course.id)).toEqual([
    "100",
    "101",
    "102",
    "103",
    "104",
  ]);
  expect(result.discovery.candidates.map((candidate) => candidate.id)).toEqual([
    "100:1000",
    "101:1010",
    "102:1020",
    "103:1030",
    "104:1040",
  ]);
  // Same fresh GET set as before: identity, listing, one module read per
  // course, then the identity check that closes the discovery.
  expect(requested.filter((path) => path.endsWith("/modules"))).toHaveLength(5);
  expect(requested[0]).toBe("/api/v1/users/self");
  expect(requested.at(-1)).toBe("/api/v1/users/self");
  expect(requested).toHaveLength(8);
});

it("reports the lowest-index course failure and returns no partial discovery", async () => {
  const slow = deferred<Response>();
  const { fetcher } = lms(3, (courseId) => {
    if (courseId === 100) return slow.promise;
    if (courseId === 101) return new Response(null, { status: 500 });
    return json(courseModules(courseId));
  });
  const discovery = discoverPlayback(origin, salt, fetcher);
  // Course 101 fails first, but an earlier course still decides the error.
  await Promise.resolve();
  slow.resolve(new Response(null, { status: 403 }));
  expect(await discovery).toEqual({ status: "error", code: "FORBIDDEN" });
});

it("returns an earlier course failure promptly while a later course hangs", async () => {
  const signals = new Map<number, AbortSignal>();
  const { fetcher, requested } = lms(6, (courseId, signal) => {
    if (courseId === 100) return new Response(null, { status: 403 });
    signals.set(courseId, signal!);
    return hang(signal);
  });
  // Without the fix this stays pending until the 20s deadline and reports TIMEOUT.
  expect(await discoverPlayback(origin, salt, fetcher)).toEqual({
    status: "error",
    code: "FORBIDDEN",
  });
  // The hanging later reads are discarded, not left running.
  expect([...signals.keys()]).toEqual([101, 102]);
  for (const signal of signals.values()) expect(signal.aborted).toBe(true);
  expect(requested.filter((path) => path.endsWith("/modules"))).toEqual(
    [100, 101, 102].map((id) => `/api/v1/courses/${id}/modules`),
  );
  expect(
    requested.filter((path) => path === "/api/v1/users/self"),
  ).toHaveLength(1);
});

it("keeps a lower unresolved course running when a later one fails first, then lets it win", async () => {
  const signals = new Map<number, AbortSignal>();
  const first = deferred<Response>();
  const { fetcher } = lms(4, (courseId, signal) => {
    signals.set(courseId, signal!);
    if (courseId === 100) return first.promise;
    if (courseId === 101) return new Response(null, { status: 500 });
    return hang(signal);
  });
  const discovery = discoverPlayback(origin, salt, fetcher);
  // Course 101's failure is not yet the answer: 100 is unresolved. Only the
  // higher-index hanging read is discarded.
  await vi.waitFor(() => expect(signals.get(102)!.aborted).toBe(true));
  expect(signals.get(100)!.aborted).toBe(false);
  expect(signals.get(101)!.aborted).toBe(false);
  first.resolve(new Response(null, { status: 403 }));
  expect(await discovery).toEqual({ status: "error", code: "FORBIDDEN" });
});

it("falls back to the later failure once every lower course has succeeded", async () => {
  const first = deferred<Response>();
  const signals = new Map<number, AbortSignal>();
  const { fetcher } = lms(4, (courseId, signal) => {
    signals.set(courseId, signal!);
    if (courseId === 100) return first.promise;
    if (courseId === 101) return new Response(null, { status: 401 });
    return hang(signal);
  });
  const discovery = discoverPlayback(origin, salt, fetcher);
  await vi.waitFor(() => expect(signals.get(102)!.aborted).toBe(true));
  first.resolve(json(courseModules(100)));
  expect(await discovery).toEqual({ status: "error", code: "LOGIN_REQUIRED" });
});

it("starts no course after a failed one", async () => {
  const { fetcher, requested } = lms(8, (courseId) =>
    courseId === 100
      ? new Response(null, { status: 401 })
      : json(courseModules(courseId)),
  );
  expect(await discoverPlayback(origin, salt, fetcher)).toEqual({
    status: "error",
    code: "LOGIN_REQUIRED",
  });
  const modules = requested.filter((path) => path.endsWith("/modules"));
  // Courses already running may finish; the rest are never requested.
  expect(modules.length).toBeLessThanOrEqual(3);
  expect(modules).not.toContain("/api/v1/courses/107/modules");
  expect(
    requested.filter((path) => path === "/api/v1/users/self"),
  ).toHaveLength(1);
});

it("keeps the 100-GET discovery budget shared across overlapped courses", async () => {
  const { fetcher, requested } = lms(101, (courseId) =>
    json(courseModules(courseId)),
  );
  expect(await discoverPlayback(origin, salt, fetcher)).toEqual({
    status: "error",
    code: "LIMIT",
  });
  expect(requested).toHaveLength(100);
  expect(requested).not.toContain("/api/v1/courses/200/modules");
});

it("stops reading further courses once the aggregate candidate cap is exceeded", async () => {
  const lectures = (courseId: number) =>
    Array.from({ length: 4 }, (_, module) => ({
      id: module + 1,
      items_count: 1000,
      items: Array.from({ length: 1000 }, (_, i) => ({
        id: courseId * 10000 + module * 1000 + i,
        type: "ExternalTool",
        title: "Lecture",
        url: "https://example.invalid",
      })),
    }));
  const gates = new Map<number, ReturnType<typeof deferred<Response>>>();
  const { fetcher, requested } = lms(12, (courseId) => {
    if (courseId > 104) return json(lectures(courseId));
    const gate = deferred<Response>();
    gates.set(courseId, gate);
    return gate.promise;
  });
  const discovery = discoverPlayback(origin, salt, fetcher);
  await vi.waitFor(() => expect(gates.size).toBe(3));
  gates.get(101)!.resolve(json(lectures(101)));
  await vi.waitFor(() => expect(gates.has(103)).toBe(true));
  gates.get(102)!.resolve(json(lectures(102)));
  await vi.waitFor(() => expect(gates.has(104)).toBe(true));
  // Two buffered courses hold 8,000; the third pushes past 10,000.
  for (const id of [100, 103, 104]) gates.get(id)!.resolve(json(lectures(id)));
  expect(await discovery).toEqual({ status: "error", code: "LIMIT" });
  expect(requested.filter((path) => path.endsWith("/modules"))).toEqual(
    [100, 101, 102, 103, 104].map((id) => `/api/v1/courses/${id}/modules`),
  );
});

it("still rejects an account change observed after the overlapped reads", async () => {
  let identities = 0;
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    requested.push(path);
    if (path === "/api/v1/users/self") return json({ id: ++identities });
    if (path === "/api/v1/courses") return json(courseList(4));
    return json(courseModules(Number(path.split("/")[4])));
  };
  expect(await discoverPlayback(origin, salt, fetcher)).toEqual({
    status: "error",
    code: "ACCOUNT_CHANGED",
  });
  expect(requested.at(-1)).toBe("/api/v1/users/self");
  expect(requested.filter((path) => path.endsWith("/modules"))).toHaveLength(4);
});
