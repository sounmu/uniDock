import type { NavigationCatalog } from "../src/navigation-catalog";
import { afterEach, expect, it, vi } from "vitest";
import { parseResult, request, type Request } from "../src/protocol";
const list = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
vi.mock("../src/api/client", () => ({ listCourses: list, listQuery: query }));
vi.mock("wxt/utils/define-content-script", () => ({
  defineContentScript: (options: unknown) => options,
}));
import content, { discoverPlayback } from "../entrypoints/lms.content";

const origin = "https://mylms.korea.ac.kr";
const salt = "a".repeat(64);
const api = `${origin}/api/v1`;

function json(value: unknown, headers?: HeadersInit): Response {
  return Response.json(value, { headers });
}

function response(count = 1) {
  let deliver!: (value: unknown) => void;
  const done = new Promise<unknown>((resolve) => {
    deliver = resolve;
  });
  const respond = vi.fn((value: unknown) => {
    if (respond.mock.calls.length === count) deliver(value);
  });
  return { respond, done };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("rejects forged senders and unsupported actions; coalesces authorized requests", async () => {
  const addListener = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: () => "chrome-extension://fixture-extension/sidepanel.html",
      onMessage: { addListener },
    },
  });
  vi.stubGlobal("location", {
    href: "https://mylms.korea.ac.kr/",
    origin: "https://mylms.korea.ac.kr",
  });
  (content as unknown as { main: () => void }).main();
  const listener = addListener.mock.calls[0]![0];
  const sender = {
    id: "fixture-extension",
    url: "chrome-extension://fixture-extension/sidepanel.html",
  };
  expect(listener(request, { ...sender, id: "foreign" }, vi.fn())).toBe(false);
  expect(
    listener(
      request,
      { ...sender, url: "https://mylms.korea.ac.kr/" },
      vi.fn(),
    ),
  ).toBe(false);
  expect(listener({ ...request, type: "UPLOAD" }, sender, vi.fn())).toBe(false);
  expect(list).not.toHaveBeenCalled();
  list.mockResolvedValue({ status: "success", courses: [] });
  const { respond, done } = response(2);
  expect(listener(request, sender, respond)).toBe(true);
  expect(listener(request, sender, respond)).toBe(true);
  await done;
  expect(respond).toHaveBeenCalledTimes(2);
  expect(list).toHaveBeenCalledTimes(1);
});

it.each<Request>([
  { version: 1, type: "ASSIGNMENTS_LIST", course: "국제법" },
  { version: 1, type: "DEADLINES_LIST", course: "국제법" },
  { version: 1, type: "UPCOMING_LIST", start_date: "2026-09-01" },
  { version: 1, type: "TODO_LIST" },
])(
  "routes supported read request %j and rejects overlapping different requests",
  async (request) => {
    const addListener = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: {
        id: "fixture-extension",
        getURL: () => "chrome-extension://fixture-extension/sidepanel.html",
        onMessage: { addListener },
      },
    });
    vi.stubGlobal("location", {
      href: "https://mylms.korea.ac.kr/",
      origin: "https://mylms.korea.ac.kr",
    });
    (content as unknown as { main: () => void }).main();
    const listener = addListener.mock.calls[0]![0];
    const sender = {
      id: "fixture-extension",
      url: "chrome-extension://fixture-extension/sidepanel.html",
    };
    query.mockResolvedValue({ status: "error", code: "LOGIN_REQUIRED" });
    const { respond, done } = response();
    const busy = vi.fn();
    expect(listener(request, sender, respond)).toBe(true);
    listener({ version: 1, type: "COURSES_LIST" }, sender, busy);
    expect(busy).toHaveBeenCalledWith({ status: "error", code: "BUSY" });
    expect(await done).toEqual({ status: "error", code: "LOGIN_REQUIRED" });
    expect(query).toHaveBeenCalledWith("https://mylms.korea.ac.kr", request);
  },
);
it("opens only a known catalog handle and never accepts a raw URL from the panel", async () => {
  const addListener = vi.fn(),
    sendMessage = vi
      .fn()
      .mockResolvedValue({ status: "success", opened: true });
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: () => "chrome-extension://fixture-extension/sidepanel.html",
      onMessage: { addListener },
      sendMessage,
    },
  });
  vi.stubGlobal("location", {
    href: "https://mylms.korea.ac.kr/",
    origin: "https://mylms.korea.ac.kr",
  });
  (content as unknown as { main: () => void }).main();
  const listener = addListener.mock.calls[0]![0];
  const sender = {
    id: "fixture-extension",
    url: "chrome-extension://fixture-extension/sidepanel.html",
  };
  const invalid = vi.fn();
  expect(
    listener(
      {
        version: 1,
        type: "RECORDING_OPEN",
        handle: crypto.randomUUID(),
        url: "https://evil.invalid/",
      },
      sender,
      invalid,
    ),
  ).toBe(false);
  expect(sendMessage).not.toHaveBeenCalled();
  let store: NavigationCatalog | undefined;
  query.mockImplementation(async (_origin, _request, _fetch, _now, catalog) => {
    store = catalog;
    return {
      status: "success",
      recordings: catalog.replace("https://mylms.korea.ac.kr", [
        {
          module: "주차",
          title: "강의",
          courseId: "101",
          itemId: "501",
          moduleAccess: {},
          itemAccess: {},
        },
      ]),
    };
  });
  const listed = response();
  listener(
    { version: 1, type: "RECORDINGS_LIST", course: "과목" },
    sender,
    listed.respond,
  );
  const result = parseResult(await listed.done);
  if (result.status !== "success" || !("recordings" in result))
    throw new Error("missing recordings");
  const handle = result.recordings[0]?.launchHandle;
  const opened = response();
  listener(
    { version: 1, type: "RECORDING_OPEN", handle },
    sender,
    opened.respond,
  );
  expect(await opened.done).toEqual({ status: "success", opened: true });
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    type: "OPEN_LMS_TARGET",
    url: "https://mylms.korea.ac.kr/courses/101/modules/items/501",
  });
  store?.clear();
});

it("never treats Canvas assignment deadlines or module completion as video attendance metadata", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    expect(init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
    });
    const body = url.endsWith("/users/self")
      ? { id: 987654321 }
      : url.includes("/modules?")
        ? [
            {
              id: 11,
              items_count: 1,
              items: [
                {
                  id: 501,
                  type: "ExternalTool",
                  title: "Lecture",
                  html_url: "https://kucom.korea.ac.kr/em/signed?token=secret",
                  content_details: {
                    due_at: "2026-09-26T00:00:00Z",
                    duration: 600,
                  },
                  due_at: "2026-09-26T00:00:00Z",
                  duration: 600,
                  completion_requirement: { completed: true },
                  completed_at: "2026-09-25T00:00:00Z",
                },
              ],
            },
          ]
        : [{ id: 101, name: "Course" }];
    return Response.json(body);
  };
  const result = await discoverPlayback(
    "https://mylms.korea.ac.kr",
    "a".repeat(64),
    fetcher,
  );
  expect(result.status).toBe("success");
  if (result.status !== "success") throw new Error(result.code);
  expect(result.discovery.candidates).toEqual([
    {
      id: "101:501",
      courseId: "101",
      title: "Lecture",
      deadline: null,
      durationMinutes: null,
      completion: "unknown",
    },
  ]);
  expect(result.discovery.accountKey).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain("987654321");
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(JSON.stringify(result)).not.toContain("signed");
  expect(JSON.stringify(result)).not.toContain("2026-09-26");
  expect(
    calls.every((url) => url.startsWith("https://mylms.korea.ac.kr/api/v1/")),
  ).toBe(true);
});

it("rejects an account change across one discovery and never returns partial candidates", async () => {
  let identities = 0;
  const fetcher: typeof fetch = async (input) =>
    Response.json(
      String(input).endsWith("/users/self") ? { id: ++identities } : [],
    );
  expect(
    await discoverPlayback(
      "https://mylms.korea.ac.kr",
      "a".repeat(64),
      fetcher,
    ),
  ).toEqual({ status: "error", code: "ACCOUNT_CHANGED" });
});

it.each([
  [
    "redirect",
    () => new Response(null, { status: 302, headers: { location: "/login" } }),
    "LOGIN_REQUIRED",
  ],
  [
    "opaque redirect",
    () => ({ type: "opaqueredirect" }) as Response,
    "LOGIN_REQUIRED",
  ],
  [
    "HTML login",
    () => new Response("login", { headers: { "content-type": "text/html" } }),
    "LOGIN_REQUIRED",
  ],
  ["unauthorized", () => new Response(null, { status: 401 }), "LOGIN_REQUIRED"],
  ["forbidden", () => new Response(null, { status: 403 }), "FORBIDDEN"],
  ["server error", () => new Response(null, { status: 500 }), "NETWORK"],
  [
    "non-JSON",
    () => new Response("ok", { headers: { "content-type": "text/plain" } }),
    "INVALID_RESPONSE",
  ],
  [
    "oversized JSON",
    () => json({ id: 1 }, { "content-length": "2000001" }),
    "LIMIT",
  ],
  ["missing identity", () => json({}), "LOGIN_REQUIRED"],
] as const)(
  "rejects %s from the identity GET without issuing another request",
  async (_name, reply, code) => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init).toMatchObject({
          method: "GET",
          credentials: "same-origin",
          redirect: "manual",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          headers: { Accept: "application/json" },
        });
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return reply();
      },
    );
    expect(await discoverPlayback(origin, salt, fetcher)).toEqual({
      status: "error",
      code,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${api}/users/self`);
  },
);

it("rejects a repeated page rather than looping or following unapproved pagination", async () => {
  const courses = `${api}/courses?per_page=100&enrollment_state=active`;
  const next = `${courses}&page=2`;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/users/self")) return json({ id: 1 });
    return json([], { link: `<${next}>; rel="next"` });
  };
  expect(await discoverPlayback(origin, salt, fetcher)).toEqual({
    status: "error",
    code: "LIMIT",
  });
  expect(calls).toEqual([`${api}/users/self`, courses, next]);

  const unsafe: typeof fetch = async (input) =>
    String(input).endsWith("/users/self")
      ? json({ id: 1 })
      : json([], {
          link: `<https://evil.invalid/api/v1/courses?page=2>; rel="next"`,
        });
  expect(await discoverPlayback(origin, salt, unsafe)).toEqual({
    status: "error",
    code: "POLICY",
  });
});

it("caps discovery GETs at 100 pages even when pagination keeps advancing", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async (input, init) => {
    requests++;
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    if (String(input).endsWith("/users/self")) return json({ id: 1 });
    const page = new URL(String(input)).searchParams.get("page");
    const next = Number(page ?? 1) + 1;
    return json([], {
      link: `<${api}/courses?per_page=100&enrollment_state=active&page=${next}>; rel="next"`,
    });
  };
  expect(await discoverPlayback(origin, salt, fetcher)).toEqual({
    status: "error",
    code: "LIMIT",
  });
  expect(requests).toBe(100);
});

it("hydrates incomplete accessible modules, excluding locked modules and items", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    expect(init).toMatchObject({
      method: "GET",
      redirect: "manual",
      credentials: "same-origin",
    });
    if (url.endsWith("/users/self")) return json({ id: 42 });
    if (url.includes("/modules/11/items?"))
      return json([
        {
          id: 501,
          type: "ExternalTool",
          title: "Playable",
          html_url: "https://kucom.korea.ac.kr/signed?token=private",
          content_details: { due_at: "2026-09-26T00:00:00Z", duration: 60 },
          completion_requirement: { completed: true },
        },
        {
          id: 502,
          type: "ExternalTool",
          title: "Locked",
          url: "https://example.org",
          locked_for_user: true,
        },
        { id: 503, type: "File", title: "File", url: "https://example.org" },
      ]);
    if (url.includes("/modules?"))
      return json([
        { id: 10, published: false, items_count: 1 },
        {
          id: 11,
          items_count: 3,
          items: [
            {
              id: 999,
              type: "ExternalTool",
              title: "Stale",
              url: "https://example.org",
            },
          ],
        },
        { id: 12, locked_for_user: true, items_count: 2 },
      ]);
    return json([{ id: 101, name: "Course" }]);
  };
  const result = await discoverPlayback(origin, salt, fetcher);
  expect(result.status).toBe("success");
  if (result.status !== "success") throw new Error(result.code);
  expect(result.discovery.candidates).toEqual([
    {
      id: "101:501",
      courseId: "101",
      title: "Playable",
      deadline: null,
      durationMinutes: null,
      completion: "unknown",
    },
  ]);
  expect(calls).toEqual([
    `${api}/users/self`,
    `${api}/courses?per_page=100&enrollment_state=active`,
    `${api}/courses/101/modules?per_page=100&include[]=items&include[]=content_details`,
    `${api}/courses/101/modules/11/items?per_page=100&include[]=content_details`,
    `${api}/users/self`,
  ]);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(JSON.stringify(result)).not.toContain("Stale");
});

it.each([{ id: 11, items_count: -1, items: [] }, { items_count: 1 }])(
  "rejects invalid or unhydratable module metadata without partial results: %j",
  async (badModule) => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/users/self")) return json({ id: 1 });
      if (url.includes("/modules?"))
        return json([
          {
            id: 10,
            items_count: 1,
            items: [
              {
                id: 501,
                type: "ExternalTool",
                title: "Good",
                url: "https://example.org",
              },
            ],
          },
          badModule,
        ]);
      return json([{ id: 101, name: "Course" }]);
    };
    expect(await discoverPlayback(origin, salt, fetcher)).toEqual({
      status: "error",
      code: "INVALID_RESPONSE",
    });
  },
);

it("rejects a changed account after hydration rather than exposing partial discoveries", async () => {
  let identities = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/users/self")) return json({ id: ++identities });
    if (url.includes("/modules?"))
      return json([
        {
          id: 11,
          items_count: 1,
          items: [
            {
              id: 501,
              type: "ExternalTool",
              title: "Lecture",
              url: "https://example.org",
            },
          ],
        },
      ]);
    return json([{ id: 101, name: "Course" }]);
  };
  expect(await discoverPlayback(origin, salt, fetcher)).toEqual({
    status: "error",
    code: "ACCOUNT_CHANGED",
  });
  expect(identities).toBe(2);
});

it("invalidates discovery when the LMS page changes while its GETs are pending", async () => {
  const addListener = vi.fn();
  const location = { href: `${origin}/courses/101`, origin };
  vi.stubGlobal("location", location);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: (path: string) => `chrome-extension://fixture-extension/${path}`,
      onMessage: { addListener },
    },
  });
  let release!: (value: Response) => void;
  const secondIdentity = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const pendingIdentity = new Promise<void>((resolve) => {
    requested = resolve;
  });
  let identities = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({ method: "GET", redirect: "manual" });
      if (String(input).endsWith("/users/self")) {
        identities++;
        if (identities === 2) {
          requested();
          return secondIdentity;
        }
        return json({ id: 1 });
      }
      return json([]);
    }),
  );
  (content as unknown as { main: () => void }).main();
  const listener = addListener.mock.calls[0]![0];
  const { respond, done } = response();
  expect(
    listener(
      { version: 1, type: "PLAYBACK_DISCOVER", salt },
      { id: "fixture-extension" },
      respond,
    ),
  ).toBe(true);
  await pendingIdentity;
  location.href = `${origin}/courses/102`;
  release(json({ id: 1 }));
  expect(await done).toEqual({ status: "error", code: "RELOAD_TAB" });
  expect(respond).toHaveBeenCalledTimes(1);
});

it("rejects forged background discovery, raw endpoint input and panel account queries", () => {
  const addListener = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: (path: string) => `chrome-extension://fixture-extension/${path}`,
      onMessage: { addListener },
    },
  });
  vi.stubGlobal("location", {
    href: "https://mylms.korea.ac.kr/",
    origin: "https://mylms.korea.ac.kr",
  });
  (content as unknown as { main: () => void }).main();
  const listener = addListener.mock.calls[0]?.[0];
  const message = {
    version: 1,
    type: "PLAYBACK_DISCOVER",
    salt: "a".repeat(64),
  };
  expect(
    listener(
      message,
      {
        id: "fixture-extension",
        tab: { id: 1 },
        url: "https://mylms.korea.ac.kr/",
      },
      vi.fn(),
    ),
  ).toBe(false);
  expect(
    listener(
      message,
      {
        id: "fixture-extension",
        url: "chrome-extension://fixture-extension/sidepanel.html",
      },
      vi.fn(),
    ),
  ).toBe(false);
  expect(
    listener(
      { ...message, url: "https://evil.invalid" },
      { id: "fixture-extension" },
      vi.fn(),
    ),
  ).toBe(false);
});
