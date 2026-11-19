import { expect, it, vi } from "vitest";
import { discoverPlayback } from "../entrypoints/lms.content";

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
  modules: (courseId: number) => Promise<Response> | Response,
) {
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    requested.push(path);
    if (path === "/api/v1/users/self") return json({ id: 42 });
    if (path === "/api/v1/courses") return json(courseList(count));
    const match = path.match(/^\/api\/v1\/courses\/(\d+)\/modules$/);
    if (match) return modules(Number(match[1]));
    throw new Error("unexpected endpoint");
  };
  return { fetcher, requested };
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
