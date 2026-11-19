import { afterEach, expect, it, vi } from "vitest";
import { listQuery } from "../src/api/client";
import { ConditionalReads, validEntityTag } from "../src/api/conditional-reads";
import { NavigationCatalog } from "../src/navigation-catalog";
import {
  createCanvasFixture,
  fixtureCourse,
  fixtureOrigin as origin,
} from "./conditional-reads-fixture";

const now = Date.parse("2026-09-11T00:00:00Z");
const catalogs: NavigationCatalog[] = [];
afterEach(() => {
  catalogs.forEach((catalog) => catalog.clear());
  catalogs.length = 0;
});

async function list(
  type: "RECORDINGS_LIST" | "DOCUMENTS_LIST",
  fetcher: typeof fetch,
  reads?: ConditionalReads,
  at = now,
) {
  const catalog = new NavigationCatalog();
  catalogs.push(catalog);
  const scope = reads?.scope();
  const result = await listQuery(
    origin,
    { version: 1, type, course: "Course" },
    fetcher,
    at,
    catalog,
    fixtureCourse,
    undefined,
    scope,
  );
  if (result.status === "success") scope?.commit();
  return result;
}
const decorate =
  (
    fetcher: typeof fetch,
    when: (status: number) => boolean,
    headers: Record<string, string>,
  ): typeof fetch =>
  async (input, init) => {
    const response = await fetcher(input, init);
    if (!when(response.status)) return response;
    const merged = new Headers(response.headers);
    for (const [name, value] of Object.entries(headers))
      merged.set(name, value);
    return new Response(response.status === 304 ? null : response.body, {
      status: response.status,
      headers: merged,
    });
  };
const titles = (result: Awaited<ReturnType<typeof list>>) => {
  if (result.status !== "success") throw new Error(result.code);
  return "recordings" in result
    ? result.recordings.map((row) => row.title)
    : "documents" in result
      ? result.documents.map((row) => row.title)
      : [];
};

it("revalidates repeat reads with 304 and keeps fresh capabilities", async () => {
  const canvas = createCanvasFixture({ modules: 4, itemsPerModule: 4 });
  const reads = new ConditionalReads();
  const cold = await list("RECORDINGS_LIST", canvas.fetcher, reads);
  const coldStats = canvas.stats();
  canvas.reset();
  const warm = await list("RECORDINGS_LIST", canvas.fetcher, reads);
  const warmStats = canvas.stats();

  expect(titles(warm)).toEqual(titles(cold));
  expect(warmStats.calls).toBe(coldStats.calls);
  expect(warmStats.conditional).toBe(warmStats.calls);
  expect(warmStats.notModified).toBe(warmStats.calls);
  expect(warmStats.bodyBytes).toBe(0);
  expect(coldStats.bodyBytes).toBeGreaterThan(0);
  if (cold.status !== "success" || warm.status !== "success")
    throw new Error("list failed");
  if (!("recordings" in cold) || !("recordings" in warm))
    throw new Error("Missing list");
  expect(warm.recordings[0]!.launchHandle).not.toBe(
    cold.recordings[0]!.launchHandle,
  );
});

it("shares module reads between recordings and documents", async () => {
  const canvas = createCanvasFixture({ modules: 3, itemsPerModule: 4 });
  const reads = new ConditionalReads();
  await list("RECORDINGS_LIST", canvas.fetcher, reads);
  canvas.reset();
  const documents = await list("DOCUMENTS_LIST", canvas.fetcher, reads);
  expect(titles(documents).length).toBeGreaterThan(0);
  const modulePaths = canvas.requests.filter((request) =>
    /\/modules(\/\d+\/items)?$/.test(request.path),
  );
  expect(modulePaths.every((request) => request.status === 304)).toBe(true);
  expect(modulePaths.map((request) => request.bytes)).toEqual(
    modulePaths.map(() => 0),
  );
});

it("serves changed content instead of the stored page", async () => {
  const canvas = createCanvasFixture({ modules: 2, itemsPerModule: 2 });
  const reads = new ConditionalReads();
  await list("RECORDINGS_LIST", canvas.fetcher, reads);
  canvas.setItems(2, [
    {
      id: 2999,
      type: "ExternalTool",
      title: "새 강의",
      html_url: "https://lti.example.invalid/launch",
    },
  ]);
  const next = await list("RECORDINGS_LIST", canvas.fetcher, reads);
  expect(titles(next)).toContain("새 강의");
  expect(titles(next)).not.toContain("강의 2-1");
});

it("never serves stored pages once the LMS revokes access", async () => {
  const canvas = createCanvasFixture({ modules: 2, itemsPerModule: 2 });
  const reads = new ConditionalReads();
  await list("RECORDINGS_LIST", canvas.fetcher, reads);
  canvas.revoke();
  expect(await list("RECORDINGS_LIST", canvas.fetcher, reads)).toEqual({
    status: "error",
    code: "FORBIDDEN",
  });
});

it("re-evaluates time-based availability on stored pages", async () => {
  const canvas = createCanvasFixture({ modules: 1, itemsPerModule: 2 });
  canvas.setItems(1, [
    {
      id: 1001,
      type: "ExternalTool",
      title: "예약 강의",
      html_url: "https://lti.example.invalid/launch",
      unlock_at: "2026-09-12T00:00:00Z",
    },
  ]);
  const reads = new ConditionalReads();
  expect(titles(await list("RECORDINGS_LIST", canvas.fetcher, reads))).toEqual(
    [],
  );
  canvas.reset();
  const later = await list(
    "RECORDINGS_LIST",
    canvas.fetcher,
    reads,
    Date.parse("2026-09-13T00:00:00Z"),
  );
  expect(titles(later)).toEqual(["예약 강의"]);
  expect(canvas.stats().notModified).toBeGreaterThan(0);
});

it("sends unconditional reads after clear and drops in-flight scopes", async () => {
  const canvas = createCanvasFixture({ modules: 2, itemsPerModule: 2 });
  const reads = new ConditionalReads();
  await list("RECORDINGS_LIST", canvas.fetcher, reads);
  reads.clear();
  canvas.reset();
  await list("RECORDINGS_LIST", canvas.fetcher, reads);
  expect(canvas.stats().conditional).toBe(0);

  const stale = reads.scope();
  canvas.reset();
  await listQuery(
    origin,
    { version: 1, type: "RECORDINGS_LIST", course: "Course" },
    canvas.fetcher,
    now,
    new NavigationCatalog(),
    fixtureCourse,
    undefined,
    stale,
  );
  reads.clear();
  stale.commit();
  canvas.reset();
  await list("RECORDINGS_LIST", canvas.fetcher, reads);
  expect(canvas.stats().conditional).toBe(0);
});

it("stores nothing from a call whose identity check never committed", async () => {
  const canvas = createCanvasFixture({ modules: 2, itemsPerModule: 2 });
  const reads = new ConditionalReads();
  await listQuery(
    origin,
    { version: 1, type: "RECORDINGS_LIST", course: "Course" },
    canvas.fetcher,
    now,
    new NavigationCatalog(),
    fixtureCourse,
    undefined,
    reads.scope(),
  );
  canvas.reset();
  await list("RECORDINGS_LIST", canvas.fetcher, reads);
  expect(canvas.stats().conditional).toBe(0);
});

it.each<Record<string, string>>([
  { "Cache-Control": "private, no-store" },
  { Vary: "*" },
  { Vary: "Cookie" },
  { Vary: "Accept-Encoding, Authorization" },
])("does not store pages answered with %j", async (headers) => {
  const canvas = createCanvasFixture({ modules: 2, itemsPerModule: 2 });
  const fetcher = decorate(canvas.fetcher, (status) => status === 200, headers);
  const reads = new ConditionalReads();
  await list("RECORDINGS_LIST", fetcher, reads);
  canvas.reset();
  await list("RECORDINGS_LIST", fetcher, reads);
  expect(canvas.stats().conditional).toBe(0);
});

it("stores pages that vary only on constant request headers", async () => {
  const canvas = createCanvasFixture({ modules: 2, itemsPerModule: 2 });
  const fetcher = decorate(canvas.fetcher, (status) => status === 200, {
    Vary: "Accept-Encoding, Origin",
    "Cache-Control": "max-age=0, private, must-revalidate",
  });
  const reads = new ConditionalReads();
  await list("RECORDINGS_LIST", fetcher, reads);
  canvas.reset();
  await list("RECORDINGS_LIST", fetcher, reads);
  expect(canvas.stats().notModified).toBe(canvas.stats().calls);
});

it.each<Record<string, string>>([
  { "Cache-Control": "no-store" },
  { Vary: "*" },
  { Vary: "Cookie" },
  { ETag: '"other"' },
  { ETag: "*" },
])(
  "refetches instead of reusing a page whose 304 carries %j",
  async (headers) => {
    const canvas = createCanvasFixture({ modules: 2, itemsPerModule: 2 });
    const reads = new ConditionalReads();
    const cold = await list("RECORDINGS_LIST", canvas.fetcher, reads);
    const coldStats = canvas.stats();
    canvas.reset();
    const fetcher = decorate(
      canvas.fetcher,
      (status) => status === 304,
      headers,
    );
    const warm = await list("RECORDINGS_LIST", fetcher, reads);
    const stats = canvas.stats();
    expect(titles(warm)).toEqual(titles(cold));
    expect(stats.calls).toBe(coldStats.calls * 2);
    expect(stats.bodyBytes).toBe(coldStats.bodyBytes);
  },
);

it("never revalidates the course index or non-capability lists", async () => {
  const canvas = createCanvasFixture({ modules: 1, itemsPerModule: 2 });
  const reads = new ConditionalReads();
  const run = async () => {
    const scope = reads.scope();
    await listQuery(
      origin,
      { version: 1, type: "RECORDINGS_LIST", course: "Course" },
      canvas.fetcher,
      now,
      new NavigationCatalog(),
      undefined,
      undefined,
      scope,
    );
    scope.commit();
  };
  await run();
  canvas.reset();
  await run();
  expect(canvas.stats().notModified).toBeGreaterThan(0);
  const index = canvas.requests.filter(
    (request) => request.path === "/api/v1/courses",
  );
  expect(index.length).toBe(1);
  expect(index[0]!.conditional).toBe(false);
});

it("refetches unconditionally when a 304 reports a next page", async () => {
  const module = (id: number) => ({ id, name: "w", items: [], items_count: 0 });
  const calls: (string | undefined)[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const etag = (init?.headers as Record<string, string>)["If-None-Match"];
    calls.push(etag);
    if (calls.length === 2)
      return new Response(null, {
        status: 304,
        headers: {
          Link: `<${origin}/api/v1/courses/${fixtureCourse}/modules?page=2>; rel="next"`,
        },
      });
    return Response.json([module(1)], { headers: { ETag: '"a"' } });
  }) as unknown as typeof fetch;
  const reads = new ConditionalReads();
  await list("RECORDINGS_LIST", fetcher, reads);
  const result = await list("RECORDINGS_LIST", fetcher, reads);
  expect(result.status).toBe("success");
  expect(calls).toEqual([undefined, '"a"', undefined]);
});

it("does not store full pages whose Link may change on a 304", async () => {
  const rows = Array.from({ length: 100 }, (_, id) => ({
    id: id + 1,
    name: "w",
    items: [],
    items_count: 0,
  }));
  const sent: (string | undefined)[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.push((init?.headers as Record<string, string>)["If-None-Match"]);
    return Response.json(rows, { headers: { ETag: '"full"' } });
  }) as unknown as typeof fetch;
  const reads = new ConditionalReads();
  await list("RECORDINGS_LIST", fetcher, reads);
  await list("RECORDINGS_LIST", fetcher, reads);
  expect(sent.every((etag) => etag === undefined)).toBe(true);
});

it("charges the retry after an unusable 304 to the 100-request budget", async () => {
  const canvas = createCanvasFixture({ modules: 60, itemsPerModule: 1 });
  const reads = new ConditionalReads();
  const cold = await list("RECORDINGS_LIST", canvas.fetcher, reads);
  expect(cold.status).toBe("success");
  expect(canvas.stats().calls).toBe(61);
  canvas.reset();
  const unusable = decorate(canvas.fetcher, (status) => status === 304, {
    "Cache-Control": "no-store",
  });
  expect(await list("RECORDINGS_LIST", unusable, reads)).toEqual({
    status: "error",
    code: "LIMIT",
  });
  expect(canvas.stats().calls).toBe(100);
});

it.each(['"abc"', 'W/"abc"', '""', '"a,b"', '"a/b+c=="'])(
  "accepts the single entity tag %s",
  (tag) => expect(validEntityTag(tag)).toBe(true),
);

it.each([
  "*",
  '"a", "b"',
  '"a","b"',
  "abc",
  '"a',
  'a"',
  "W/abc",
  'w/"abc"',
  '"a b"',
  '"a"b"',
  '"a"\n',
  "",
  `"${"x".repeat(513)}"`,
])("rejects the entity tag %j", (tag) =>
  expect(validEntityTag(tag)).toBe(false),
);

it.each(["*", '"a", "b"', "abc", '"unterminated'])(
  "never stores or sends the invalid ETag %j",
  async (etag) => {
    const canvas = createCanvasFixture({ modules: 2, itemsPerModule: 2 });
    const sent: (string | undefined)[] = [];
    const spy: typeof fetch = (input, init) => {
      sent.push((init?.headers as Record<string, string>)["If-None-Match"]);
      return canvas.fetcher(input, init);
    };
    const fetcher = decorate(spy, (status) => status === 200, { ETag: etag });
    const reads = new ConditionalReads();
    await list("RECORDINGS_LIST", fetcher, reads);
    await list("RECORDINGS_LIST", fetcher, reads);
    expect(sent.every((value) => value === undefined)).toBe(true);
  },
);

it("sends a stored weak entity tag verbatim", async () => {
  const canvas = createCanvasFixture({ modules: 1, itemsPerModule: 2 });
  const sent: (string | undefined)[] = [];
  const spy: typeof fetch = (input, init) => {
    sent.push((init?.headers as Record<string, string>)["If-None-Match"]);
    return canvas.fetcher(input, init);
  };
  const fetcher = decorate(spy, (status) => status === 200, {
    ETag: 'W/"v1"',
  });
  const reads = new ConditionalReads();
  await list("RECORDINGS_LIST", fetcher, reads);
  await list("RECORDINGS_LIST", fetcher, reads);
  expect(sent.filter((value) => value !== undefined)).toEqual(
    sent.filter((value) => value === 'W/"v1"'),
  );
  expect(sent).toContain('W/"v1"');
});

it("stages pages until commit and drops them after clear", () => {
  const reads = new ConditionalReads();
  const scope = reads.scope();
  scope.set("u", { etag: '"e"', raw: [], bytes: 10 });
  expect(reads.scope().get("u")).toBeUndefined();
  scope.commit();
  expect(reads.scope().get("u")).toBeDefined();
  const staged = reads.scope();
  staged.set("v", { etag: '"e"', raw: [], bytes: 10 });
  reads.clear();
  staged.commit();
  expect(reads.scope().get("u")).toBeUndefined();
  expect(reads.scope().get("v")).toBeUndefined();
});

it("bounds stored pages by count and bytes", () => {
  const reads = new ConditionalReads();
  const store = (url: string, bytes: number) => {
    const scope = reads.scope();
    scope.set(url, { etag: '"e"', raw: [], bytes });
    scope.commit();
  };
  const has = (url: string) => reads.scope().get(url) !== undefined;
  for (let index = 0; index < 100; index++) store(`u${index}`, 10);
  expect(has("u0")).toBe(false);
  expect(has("u99")).toBe(true);
  store("big", 9_000_000);
  expect(has("big")).toBe(false);
  store("u99", 5_000_000);
  store("u98", 5_000_000);
  expect(has("u99")).toBe(false);
  expect(has("u98")).toBe(true);
  reads.scope().delete("u98");
  expect(has("u98")).toBe(false);
});
