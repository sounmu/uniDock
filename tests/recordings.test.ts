import { afterEach, expect, it, vi } from "vitest";
import {
  accessible,
  recordingCandidate,
  recordingLabel,
} from "../src/recordings";
import { NavigationCatalog } from "../src/navigation-catalog";
import { listQuery } from "../src/api/client";
import { isRequest, parseResult } from "../src/protocol";
import { navigationUrl } from "../src/security/navigation";
import { openLmsTab } from "../src/open-tab";
import { readUrl } from "../src/security/policy";
const origin = "https://mylms.korea.ac.kr";
const now = Date.parse("2026-09-11T00:00:00Z");
const catalogs: NavigationCatalog[] = [];
const catalog = () => {
  const value = new NavigationCatalog();
  catalogs.push(value);
  return value;
};
const item = (id: number, title = "1차시") => ({
  id,
  type: "ExternalTool",
  title,
  html_url: "https://lti.example.invalid/launch?token=fixture-secret",
});
const json = (body: unknown, link?: string) =>
  new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      ...(link ? { Link: link } : {}),
    },
  });
afterEach(() => {
  catalogs.forEach((value) => value.clear());
  catalogs.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it.each([
  { published: false },
  { locked_for_user: true },
  { state: "locked" },
  { unlock_at: "2099-01-01T00:00:00Z" },
  { lock_at: "2000-01-01T00:00:00Z" },
  { content_details: { locked_for_user: true } },
  { content_details: { unlock_at: "2099-01-01T00:00:00Z" } },
  { unlock_at: "unparseable" },
  { content_details: "invalid" },
])("excludes unavailable metadata %j", (metadata) =>
  expect(accessible(metadata, now)).toBe(false),
);
it("respects exact time boundaries and missing availability", () => {
  expect(accessible({}, now)).toBe(true);
  expect(accessible({ unlock_at: "2026-09-11T00:00:00Z" }, now)).toBe(true);
  expect(accessible({ lock_at: "2026-09-11T00:00:00Z" }, now)).toBe(false);
});
it.each(["[강의 교안] 1주차", "강 의 자 료", "자료"])(
  "excludes handouts %s",
  (title) => expect(recordingCandidate(item(1, title), now)).toBe(false),
);
it("excludes other item types", () =>
  expect(recordingCandidate({ ...item(1), type: "ExternalUrl" }, now)).toBe(
    false,
  ));
it("discovers module and item pages, replaces truncated inline items, skips locked modules", async () => {
  const store = catalog();
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/courses")
      return json([{ id: 101, name: "과목" }]);
    if (url.pathname.endsWith("/modules") && !url.searchParams.has("page"))
      return json(
        [
          {
            id: 10,
            name: "1주차",
            items_count: 2,
            items: [item(501, "잘린 중복")],
          },
        ],
        `<${origin}/api/v1/courses/101/modules?page=2>; rel="next"`,
      );
    if (url.pathname.endsWith("/modules"))
      return json([
        { id: 20, name: "잠김 모듈", state: "locked", items_count: 9 },
      ]);
    if (
      url.pathname.endsWith("/modules/10/items") &&
      !url.searchParams.has("page")
    )
      return json(
        [item(501)],
        `<${origin}/api/v1/courses/101/modules/10/items?page=2>; rel="next"`,
      );
    return json([
      item(502, "2차시"),
      item(503, "교안"),
      { ...item(504), published: false },
    ]);
  });
  const query = {
    version: 1,
    type: "RECORDINGS_LIST",
    course: "과목",
  } as const;
  const result = await listQuery(origin, query, fetcher, now, store);
  expect(result.status).toBe("success");
  if (result.status !== "success" || !("recordings" in result))
    throw new Error("Missing list");
  expect(result.recordings.map((row) => row.title)).toEqual(["1차시", "2차시"]);
  expect(parseResult(result, query)).toEqual(result);
  expect(JSON.stringify(result)).not.toMatch(
    /fixture-secret|html_url|lti\.example|course_id|\/courses\//,
  );
  expect(store.take(result.recordings[0]!.launchHandle, origin)).toBe(
    `${origin}/courses/101/modules/items/501`,
  );
  expect(store.take(result.recordings[1]!.lmsHandle, origin)).toBe(
    `${origin}/courses/101/modules`,
  );
  expect(fetcher).toHaveBeenCalledTimes(5);
  for (const [, options] of fetcher.mock.calls)
    expect(options?.method).toBe("GET");
});
it("uses LMS-only fallback without an item ID", async () => {
  const store = catalog();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json([{ id: 101, name: "과목" }]))
    .mockResolvedValueOnce(
      json([
        {
          name: "모듈",
          items: [
            {
              type: "ExternalTool",
              title: "강의",
              html_url: "https://lti.example.invalid/secret",
            },
          ],
        },
      ]),
    );
  const result = await listQuery(
    origin,
    { version: 1, type: "RECORDINGS_LIST", course: "과목" },
    fetcher,
    now,
    store,
  );
  if (result.status !== "success" || !("recordings" in result))
    throw new Error("Missing list");
  expect(result.recordings[0]?.launchHandle).toBe("");
});
it.each(["course", "module", "item", "content"])(
  "preserves dates and lesson numbers matching the %s ID through the public response",
  async (collision) => {
    const store = catalog();
    const title = "[26.09.03] 2. Image Formation";
    const moduleName = "2026년 2주차";
    const courseId = collision === "course" ? 2 : 2026;
    const itemId = collision === "item" ? 2 : 903;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json([{ id: courseId, name: "과목" }]))
      .mockResolvedValueOnce(
        json([
          {
            id: collision === "module" ? 2 : 26,
            name: moduleName,
            items: [
              {
                ...item(itemId, title),
                content_id: collision === "content" ? 2 : 3,
              },
            ],
          },
        ]),
      );
    const query = {
      version: 1,
      type: "RECORDINGS_LIST",
      course: "과목",
    } as const;
    const result = parseResult(
      await listQuery(origin, query, fetcher, now, store),
      query,
    );
    if (result.status !== "success" || !("recordings" in result))
      throw new Error("Missing list");
    expect(result.recordings).toEqual([
      {
        module: moduleName,
        title,
        type: "ExternalTool",
        lmsHandle: expect.any(String),
        launchHandle: expect.any(String),
      },
    ]);
    expect(store.take(result.recordings[0]!.launchHandle, origin)).toBe(
      `${origin}/courses/${courseId}/modules/items/${itemId}`,
    );
  },
);
it.each([
  "https://example.invalid/launch?token=secret",
  "a@example.invalid",
  "token=secret",
  "course_id=2",
  "12345678",
])("still masks sensitive recording label text: %s", (value) => {
  expect(recordingLabel(`강의 ${value}`)).toBe("강의 [REDACTED]");
});
it("expires, replaces and consumes handles without deriving them from IDs", () => {
  const store = catalog();
  const target = {
    module: "week",
    title: "lecture",
    courseId: "101",
    itemId: "501",
    moduleAccess: {},
    itemAccess: {},
  };
  const [one] = store.replace(origin, [target], now);
  expect(store.take(one!.launchHandle, origin, now)).toContain("/items/501");
  expect(store.take(one!.launchHandle, origin, now)).toBeNull();
  expect(store.take(one!.lmsHandle, origin, now + 300000)).toBeNull();
  const [two] = store.replace(origin, [target], now);
  store.replace(origin, [], now);
  expect(store.take(two!.launchHandle, origin, now)).toBeNull();
});
it("rechecks known lock time at open", () => {
  const store = catalog();
  const [recording] = store.replace(
    origin,
    [
      {
        module: "week",
        title: "lecture",
        courseId: "101",
        itemId: "501",
        moduleAccess: {},
        itemAccess: { lock_at: "2026-09-11T00:00:01Z" },
      },
    ],
    now,
  );
  expect(store.take(recording!.launchHandle, origin, now + 1000)).toBeNull();
});
it.each([
  "https://evil.invalid/courses/101/modules",
  "https://canvas.korea.ac.kr/courses/101/modules",
  `${origin}/courses/101/modules?token=secret`,
  `${origin}/courses/101/modules/items/501#secret`,
  `${origin}/api/v1/courses/101`,
  `${origin}/courses/101/external_tools/5`,
  "javascript:alert(1)",
])("blocks unsafe navigation %s", (value) =>
  expect(navigationUrl(value, origin)).toBeNull(),
);
it("allows only module includes and same module pagination", () => {
  expect(
    readUrl(
      "/api/v1/courses/101/modules?include[]=items&include[]=content_details",
      origin,
      "/api/v1/courses/101/modules",
    ),
  ).toBeTruthy();
  expect(() =>
    readUrl(
      "/api/v1/courses/101/modules?include[]=submission",
      origin,
      "/api/v1/courses/101/modules",
    ),
  ).toThrow();
  expect(() =>
    readUrl(
      "/api/v1/courses/101/modules/20/items?page=2",
      origin,
      "/api/v1/courses/101/modules/10/items",
    ),
  ).toThrow();
});
it("validates open protocol and removes extraneous payloads", () => {
  const handle = crypto.randomUUID();
  expect(isRequest({ version: 1, type: "RECORDING_OPEN", handle })).toBe(true);
  expect(
    isRequest({ version: 1, type: "RECORDING_OPEN", handle, url: origin }),
  ).toBe(false);
  expect(isRequest({ version: 1, type: "RECORDING_OPEN", handle: "101" })).toBe(
    false,
  );
  expect(
    parseResult(
      { status: "success", opened: true },
      { version: 1, type: "RECORDING_OPEN", handle },
    ),
  ).toEqual({ status: "success", opened: true });
  expect(
    parseResult(
      { status: "success", opened: true },
      { version: 1, type: "COURSES_LIST" },
    ).status,
  ).toBe("error");
});
it("opens exactly one canonical foreground tab and suppresses browser details", async () => {
  const create = vi.fn().mockResolvedValue({ id: 8, url: "private" });
  vi.stubGlobal("chrome", {
    runtime: { id: "extension" },
    tabs: { get: vi.fn().mockResolvedValue({ url: origin + "/" }), create },
  });
  const sender = {
    id: "extension",
    frameId: 0,
    url: origin + "/",
    tab: { id: 7 },
  } as chrome.runtime.MessageSender;
  const message = {
    version: 1,
    type: "OPEN_LMS_TARGET",
    url: origin + "/courses/101/modules/items/501",
  };
  expect(await openLmsTab(message, sender)).toEqual({
    status: "success",
    opened: true,
  });
  expect(create).toHaveBeenCalledExactlyOnceWith({
    url: message.url,
    active: true,
  });
  expect(await openLmsTab(message, { ...sender, id: "foreign" })).toEqual({
    status: "error",
    code: "POLICY",
  });
  expect(await openLmsTab(message, { ...sender, frameId: 1 })).toEqual({
    status: "error",
    code: "POLICY",
  });
  expect(
    await openLmsTab({ ...message, url: "https://evil.invalid/" }, sender),
  ).toEqual({ status: "error", code: "POLICY" });
  expect(create).toHaveBeenCalledTimes(1);
});

it("matches the original Python recording fixture public projection", async () => {
  const fixture = (await import("./fixtures/python-contract.json")).default;
  const store = catalog();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json(fixture.raw.courses))
    .mockResolvedValueOnce(json(fixture.raw.recordings));
  const result = await listQuery(
    origin,
    { version: 1, type: "RECORDINGS_LIST", course: "국제법" },
    fetcher,
    now,
    store,
  );
  if (result.status !== "success" || !("recordings" in result))
    throw new Error("Missing list");
  expect(
    result.recordings.map(({ module, title, type }) => ({
      module,
      title,
      type,
      playable: true,
    })),
  ).toEqual(fixture.expected.recordings);
});

const recordingQuery = {
  version: 1,
  type: "RECORDINGS_LIST",
  course: "과목",
} as const;
function delayedResponse(
  body: unknown,
  delay: number,
  signal?: AbortSignal | null,
  link?: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("ABORTED"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(json(body, link));
    }, delay);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
it("fetches at most three modules concurrently and preserves module and page order", async () => {
  vi.useFakeTimers();
  const store = catalog();
  let active = 0,
    peak = 0,
    finished = false;
  const started: number[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/courses")
      return json([{ id: 101, name: "과목" }]);
    if (url.pathname.endsWith("/modules"))
      return json(
        [1, 2, 3, 4].map((id) => ({ id, name: `주차 ${id}`, items_count: 2 })),
      );
    const id = Number(/\/modules\/(\d+)\//.exec(url.pathname)![1]);
    started.push(id);
    peak = Math.max(peak, ++active);
    const page = url.searchParams.has("page");
    const delay =
      id === 1 ? (page ? 30 : 100) : id === 2 ? 10 : id === 3 ? 20 : 5;
    try {
      return await delayedResponse(
        [item(id * 100 + (page ? 2 : 1), `강의 ${id}-${page ? 2 : 1}`)],
        delay,
        options?.signal,
        id === 1 && !page
          ? `<${origin}${url.pathname}?page=2>; rel="next"`
          : undefined,
      );
    } finally {
      active--;
    }
  });
  const pending = listQuery(origin, recordingQuery, fetcher, now, store).then(
    (result) => {
      finished = true;
      return result;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(started).toEqual([1, 2, 3]);
  await vi.advanceTimersByTimeAsync(10);
  expect(started).toEqual([1, 2, 3, 4]);
  await vi.advanceTimersByTimeAsync(119);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const result = await pending;
  expect(peak).toBe(3);
  expect(active).toBe(0);
  if (result.status !== "success" || !("recordings" in result))
    throw new Error("Missing list");
  expect(result.recordings.map((row) => row.title)).toEqual([
    "강의 1-1",
    "강의 1-2",
    "강의 2-1",
    "강의 3-1",
    "강의 4-1",
  ]);
});
it("aborts sibling requests on a module error without publishing partial results", async () => {
  vi.useFakeTimers();
  const store = catalog();
  const replace = vi.spyOn(store, "replace");
  const aborted: number[] = [];
  const started: number[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/courses")
      return json([{ id: 101, name: "과목" }]);
    if (url.pathname.endsWith("/modules"))
      return json([1, 2, 3, 4].map((id) => ({ id, items_count: 1 })));
    const id = Number(/\/modules\/(\d+)\//.exec(url.pathname)![1]);
    started.push(id);
    if (id === 1) {
      await delayedResponse([], 10, options?.signal);
      return new Response(null, { status: 403 });
    }
    return new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => {
          aborted.push(id);
          reject(new Error("ABORTED"));
        },
        { once: true },
      );
    });
  });
  const pending = listQuery(origin, recordingQuery, fetcher, now, store);
  await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toEqual({ status: "error", code: "FORBIDDEN" });
  expect(started).toEqual([1, 2, 3]);
  expect(aborted.sort()).toEqual([2, 3]);
  expect(replace).not.toHaveBeenCalled();
});
it("shares the 100-page budget across all concurrent modules", async () => {
  const store = catalog();
  const replace = vi.spyOn(store, "replace");
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/courses")
      return json([{ id: 101, name: "과목" }]);
    if (url.pathname.endsWith("/modules"))
      return json(
        Array.from({ length: 99 }, (_, i) => ({ id: i + 1, items_count: 1 })),
      );
    return json([item(501)]);
  });
  expect(await listQuery(origin, recordingQuery, fetcher, now, store)).toEqual({
    status: "error",
    code: "LIMIT",
  });
  expect(fetcher).toHaveBeenCalledTimes(100);
  expect(replace).not.toHaveBeenCalled();
});
it("includes course lookup time in the shared 20-second timeout", async () => {
  vi.useFakeTimers();
  const store = catalog();
  let aborted = 0;
  const fetcher = vi.fn<typeof fetch>(async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/courses")
      return delayedResponse(
        [{ id: 101, name: "과목" }],
        18000,
        options?.signal,
      );
    if (url.pathname.endsWith("/modules"))
      return json([1, 2, 3].map((id) => ({ id, items_count: 1 })));
    options?.signal?.addEventListener(
      "abort",
      () => {
        aborted++;
      },
      { once: true },
    );
    return delayedResponse([item(501)], 3000, options?.signal);
  });
  const pending = listQuery(origin, recordingQuery, fetcher, now, store);
  await vi.advanceTimersByTimeAsync(20000);
  expect(await pending).toEqual({ status: "error", code: "TIMEOUT" });
  expect(aborted).toBe(3);
});
it("enforces the aggregate recording limit across modules", async () => {
  const store = catalog();
  const replace = vi.spyOn(store, "replace");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json([{ id: 101, name: "과목" }]))
    .mockResolvedValueOnce(
      json(
        [1, 2, 3].map((id) => ({
          id,
          items: Array.from({ length: 4000 }, (_, i) => item(i + 1)),
        })),
      ),
    );
  expect(await listQuery(origin, recordingQuery, fetcher, now, store)).toEqual({
    status: "error",
    code: "LIMIT",
  });
  expect(replace).not.toHaveBeenCalled();
});
