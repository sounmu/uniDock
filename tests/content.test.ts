import type { NavigationCatalog } from "../src/navigation-catalog";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => Response.json({ id: 42 })),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("reuses bounded account-scoped list results and bypasses them on explicit refresh", async () => {
  const addListener = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: () => "chrome-extension://fixture-extension/sidepanel.html",
      onMessage: { addListener },
    },
  });
  vi.stubGlobal("location", { href: origin + "/", origin });
  list.mockResolvedValue({
    status: "success",
    courses: [{ name: "캐시 과목" }],
  });
  (content as unknown as { main: () => void }).main();
  const listener = addListener.mock.calls[0]![0];
  const sender = {
    id: "fixture-extension",
    url: "chrome-extension://fixture-extension/sidepanel.html",
  };

  for (const message of [
    request,
    request,
    { version: 1, type: "QUERY_REFRESH", request },
  ]) {
    const result = response();
    expect(listener(message, sender, result.respond)).toBe(true);
    expect(await result.done).toEqual({
      status: "success",
      courses: [{ name: "캐시 과목" }],
    });
  }
  expect(list).toHaveBeenCalledTimes(2);
});

it("clears cached lists when the current LMS account changes", async () => {
  const addListener = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: () => "chrome-extension://fixture-extension/sidepanel.html",
      onMessage: { addListener },
    },
  });
  vi.stubGlobal("location", { href: origin + "/", origin });
  const identities = [1, 1, 2, 2];
  vi.mocked(fetch).mockImplementation(async () =>
    Response.json({ id: identities.shift() ?? 2 }),
  );
  list
    .mockResolvedValueOnce({ status: "success", courses: [{ name: "A" }] })
    .mockResolvedValueOnce({ status: "success", courses: [{ name: "B" }] });
  (content as unknown as { main: () => void }).main();
  const listener = addListener.mock.calls[0]![0];
  const sender = {
    id: "fixture-extension",
    url: "chrome-extension://fixture-extension/sidepanel.html",
  };
  const first = response();
  listener(request, sender, first.respond);
  expect(await first.done).toEqual({
    status: "success",
    courses: [{ name: "A" }],
  });
  const second = response();
  listener(request, sender, second.respond);
  expect(await second.done).toEqual({
    status: "success",
    courses: [{ name: "B" }],
  });
  expect(list).toHaveBeenCalledTimes(2);
});

it("does not commit a cached list whose API response arrives after pagehide", async () => {
  const addListener = vi.fn();
  let pagehide!: () => void;
  vi.stubGlobal(
    "addEventListener",
    vi.fn((type: string, listener: EventListener) => {
      if (type === "pagehide") pagehide = listener as () => void;
    }),
  );
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: () => "chrome-extension://fixture-extension/sidepanel.html",
      onMessage: { addListener },
    },
  });
  vi.stubGlobal("location", { href: origin + "/", origin });
  let release!: (value: unknown) => void;
  list
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ status: "success", courses: [{ name: "current" }] });
  (content as unknown as { main: () => void }).main();
  const listener = addListener.mock.calls[0]![0];
  const sender = {
    id: "fixture-extension",
    url: "chrome-extension://fixture-extension/sidepanel.html",
  };
  const stale = response();
  listener(request, sender, stale.respond);
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));

  pagehide();
  release({ status: "success", courses: [{ name: "stale" }] });
  expect(await stale.done).toEqual({ status: "error", code: "RELOAD_TAB" });

  for (let index = 0; index < 2; index++) {
    const current = response();
    listener(request, sender, current.respond);
    expect(await current.done).toEqual({
      status: "success",
      courses: [{ name: "current" }],
    });
  }
  expect(list).toHaveBeenCalledTimes(2);
});

it("ignores an initial account rejection from before pagehide without poisoning the new cache owner", async () => {
  const addListener = vi.fn();
  let pagehide!: () => void;
  vi.stubGlobal(
    "addEventListener",
    vi.fn((type: string, listener: EventListener) => {
      if (type === "pagehide") pagehide = listener as () => void;
    }),
  );
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: () => "chrome-extension://fixture-extension/sidepanel.html",
      onMessage: { addListener },
    },
  });
  vi.stubGlobal("location", { href: origin + "/", origin });
  let rejectIdentity!: (reason?: unknown) => void;
  vi.mocked(fetch)
    .mockImplementationOnce(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectIdentity = reject;
        }),
    )
    .mockImplementation(async () => Response.json({ id: 84 }));
  list.mockResolvedValue({
    status: "success",
    courses: [{ name: "new owner" }],
  });
  (content as unknown as { main: () => void }).main();
  const listener = addListener.mock.calls[0]![0];
  const sender = {
    id: "fixture-extension",
    url: "chrome-extension://fixture-extension/sidepanel.html",
  };
  const send = async () => {
    const result = response();
    listener(request, sender, result.respond);
    return result.done;
  };
  const stale = send();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

  pagehide();
  rejectIdentity(new Error("stale identity"));
  expect(await stale).toEqual({ status: "error", code: "RELOAD_TAB" });
  for (let index = 0; index < 2; index++) {
    expect(await send()).toEqual({
      status: "success",
      courses: [{ name: "new owner" }],
    });
  }
  expect(list).toHaveBeenCalledTimes(1);
});

it("ignores a stale rejected post-probe and clears restored-page caches on every pagehide", async () => {
  const addListener = vi.fn();
  let pagehide!: () => void;
  const addEventListener = vi.fn((type: string, listener: EventListener) => {
    if (type === "pagehide") pagehide = listener as () => void;
  });
  vi.stubGlobal("addEventListener", addEventListener);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: () => "chrome-extension://fixture-extension/sidepanel.html",
      onMessage: { addListener },
    },
  });
  vi.stubGlobal("location", { href: origin + "/", origin });
  let rejectProbe!: (reason?: unknown) => void;
  let identities = 0;
  vi.mocked(fetch).mockImplementation(async () => {
    identities++;
    if (identities === 2)
      return new Promise<Response>((_resolve, reject) => {
        rejectProbe = reject;
      });
    return Response.json({ id: 42 });
  });
  list
    .mockResolvedValueOnce({ status: "success", courses: [{ name: "stale" }] })
    .mockResolvedValueOnce({ status: "success", courses: [{ name: "first" }] })
    .mockResolvedValueOnce({
      status: "success",
      courses: [{ name: "second" }],
    });
  (content as unknown as { main: () => void }).main();
  expect(addEventListener).toHaveBeenCalledWith("pagehide", pagehide);
  const listener = addListener.mock.calls[0]![0];
  const sender = {
    id: "fixture-extension",
    url: "chrome-extension://fixture-extension/sidepanel.html",
  };
  const send = async () => {
    const result = response();
    listener(request, sender, result.respond);
    return result.done;
  };
  const stale = send();
  await vi.waitFor(() => expect(identities).toBe(2));

  pagehide();
  rejectProbe(new Error("stale post-probe"));
  expect(await stale).toEqual({ status: "error", code: "RELOAD_TAB" });
  expect(await send()).toEqual({
    status: "success",
    courses: [{ name: "first" }],
  });
  expect(await send()).toEqual({
    status: "success",
    courses: [{ name: "first" }],
  });
  expect(list).toHaveBeenCalledTimes(2);

  pagehide();
  expect(await send()).toEqual({
    status: "success",
    courses: [{ name: "second" }],
  });
  expect(list).toHaveBeenCalledTimes(3);
});

it("rejects a successful post-probe from the prior lifecycle before it can claim cache ownership", async () => {
  const addListener = vi.fn();
  let pagehide!: () => void;
  vi.stubGlobal(
    "addEventListener",
    vi.fn((type: string, listener: EventListener) => {
      if (type === "pagehide") pagehide = listener as () => void;
    }),
  );
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: () => "chrome-extension://fixture-extension/sidepanel.html",
      onMessage: { addListener },
    },
  });
  vi.stubGlobal("location", { href: origin + "/", origin });
  let releaseProbe!: (value: Response) => void;
  let identities = 0;
  vi.mocked(fetch).mockImplementation(async () => {
    identities++;
    if (identities === 2)
      return new Promise<Response>((resolve) => {
        releaseProbe = resolve;
      });
    return Response.json({ id: 84 });
  });
  list
    .mockResolvedValueOnce({ status: "success", courses: [{ name: "stale" }] })
    .mockResolvedValue({
      status: "success",
      courses: [{ name: "new owner" }],
    });
  (content as unknown as { main: () => void }).main();
  const listener = addListener.mock.calls[0]![0];
  const sender = {
    id: "fixture-extension",
    url: "chrome-extension://fixture-extension/sidepanel.html",
  };
  const send = async () => {
    const result = response();
    listener(request, sender, result.respond);
    return result.done;
  };
  const stale = send();
  await vi.waitFor(() => expect(identities).toBe(2));

  pagehide();
  releaseProbe(Response.json({ id: 42 }));
  expect(await stale).toEqual({ status: "error", code: "RELOAD_TAB" });
  for (let index = 0; index < 2; index++) {
    expect(await send()).toEqual({
      status: "success",
      courses: [{ name: "new owner" }],
    });
  }
  expect(list).toHaveBeenCalledTimes(2);
});

it("clears cached projections after an uncached capability query loses access", async () => {
  const addListener = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: () => "chrome-extension://fixture-extension/sidepanel.html",
      onMessage: { addListener },
    },
  });
  vi.stubGlobal("location", { href: origin + "/", origin });
  list
    .mockResolvedValueOnce({ status: "success", courses: [{ name: "A" }] })
    .mockResolvedValueOnce({ status: "success", courses: [{ name: "B" }] });
  query.mockResolvedValueOnce({ status: "error", code: "FORBIDDEN" });
  (content as unknown as { main: () => void }).main();
  const listener = addListener.mock.calls[0]![0];
  const sender = {
    id: "fixture-extension",
    url: "chrome-extension://fixture-extension/sidepanel.html",
  };
  const send = async (message: unknown) => {
    const result = response();
    listener(message, sender, result.respond);
    return result.done;
  };
  expect(await send(request)).toEqual({
    status: "success",
    courses: [{ name: "A" }],
  });
  expect(
    await send({ version: 1, type: "RECORDINGS_LIST", course: "A" }),
  ).toEqual({ status: "error", code: "FORBIDDEN" });
  expect(await send(request)).toEqual({
    status: "success",
    courses: [{ name: "B" }],
  });
  expect(list).toHaveBeenCalledTimes(2);
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

it("keeps a captured same-account follower when the owner finishes before its probe", async () => {
  const addListener = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: () => "chrome-extension://fixture-extension/sidepanel.html",
      onMessage: { addListener },
    },
  });
  vi.stubGlobal("location", { href: origin + "/", origin });
  const followerProbe = Promise.withResolvers<Response>();
  let identities = 0;
  vi.mocked(fetch).mockImplementation(async () => {
    identities++;
    if (identities === 2) return followerProbe.promise;
    return Response.json({ id: 42 });
  });
  list.mockResolvedValue({
    status: "success",
    courses: [{ name: "shared" }],
  });
  (content as unknown as { main: () => void }).main();
  const listener = addListener.mock.calls[0]![0];
  const sender = {
    id: "fixture-extension",
    url: "chrome-extension://fixture-extension/sidepanel.html",
  };
  const owner = response();
  const follower = response();
  listener(request, sender, owner.respond);
  listener(request, sender, follower.respond);

  expect(await owner.done).toEqual({
    status: "success",
    courses: [{ name: "shared" }],
  });
  expect(list).toHaveBeenCalledTimes(1);
  followerProbe.resolve(Response.json({ id: 42 }));
  expect(await follower.done).toEqual({
    status: "success",
    courses: [{ name: "shared" }],
  });
  expect(list).toHaveBeenCalledTimes(1);
});

it("does not expose an account A refresh to an account B follower while A's final probe is delayed", async () => {
  const addListener = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: () => "chrome-extension://fixture-extension/sidepanel.html",
      onMessage: { addListener },
    },
  });
  vi.stubGlobal("location", { href: origin + "/", origin });
  const finalProbe = Promise.withResolvers<Response>();
  let identities = 0;
  vi.mocked(fetch).mockImplementation(async () => {
    identities++;
    if (identities === 1) return Response.json({ id: 1 });
    if (identities === 2) return finalProbe.promise;
    return Response.json({ id: 2 });
  });
  list.mockResolvedValue({
    status: "success",
    courses: [{ name: "Account A" }],
  });
  (content as unknown as { main: () => void }).main();
  const listener = addListener.mock.calls[0]![0];
  const sender = {
    id: "fixture-extension",
    url: "chrome-extension://fixture-extension/sidepanel.html",
  };
  const refresh = { version: 1, type: "QUERY_REFRESH", request };
  const owner = response();
  listener(refresh, sender, owner.respond);
  await vi.waitFor(() => expect(identities).toBe(2));
  const follower = response();
  listener(refresh, sender, follower.respond);

  expect(await follower.done).toEqual({
    status: "error",
    code: "LOGIN_REQUIRED",
  });
  finalProbe.resolve(Response.json({ id: 1 }));
  expect(await owner.done).toEqual({ status: "error", code: "RELOAD_TAB" });
  expect(list).toHaveBeenCalledTimes(1);
});

it("fences a cached success from its owner and same-account follower when another follower changes account", async () => {
  const addListener = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: () => "chrome-extension://fixture-extension/sidepanel.html",
      onMessage: { addListener },
    },
  });
  vi.stubGlobal("location", { href: origin + "/", origin });
  const ownerProbe = Promise.withResolvers<Response>();
  let identities = 0;
  vi.mocked(fetch).mockImplementation(async () => {
    identities++;
    if (identities <= 2) return Response.json({ id: 1 });
    if (identities === 3) return ownerProbe.promise;
    if (identities === 4) return Response.json({ id: 1 });
    return Response.json({ id: 2 });
  });
  list.mockResolvedValue({
    status: "success",
    courses: [{ name: "Account A cached" }],
  });
  (content as unknown as { main: () => void }).main();
  const listener = addListener.mock.calls[0]![0];
  const sender = {
    id: "fixture-extension",
    url: "chrome-extension://fixture-extension/sidepanel.html",
  };
  const send = () => {
    const result = response();
    listener(request, sender, result.respond);
    return result.done;
  };

  expect(await send()).toEqual({
    status: "success",
    courses: [{ name: "Account A cached" }],
  });
  const owner = send();
  const accountAFollower = send();
  const accountBFollower = send();
  await vi.waitFor(() => expect(identities).toBe(5));

  ownerProbe.resolve(Response.json({ id: 1 }));
  expect(await accountBFollower).toEqual({
    status: "error",
    code: "LOGIN_REQUIRED",
  });
  expect(await owner).toEqual({ status: "error", code: "RELOAD_TAB" });
  expect(await accountAFollower).toEqual({
    status: "error",
    code: "RELOAD_TAB",
  });
  expect(list).toHaveBeenCalledTimes(1);
});

it.each([
  ["401", "LOGIN_REQUIRED"],
  ["timeout", "NETWORK"],
] as const)(
  "invalidates the shared operation when a follower identity probe returns %s",
  async (name, code) => {
    const addListener = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: {
        id: "fixture-extension",
        getURL: () => "chrome-extension://fixture-extension/sidepanel.html",
        onMessage: { addListener },
      },
    });
    vi.stubGlobal("location", { href: origin + "/", origin });
    const releaseList = Promise.withResolvers<unknown>();
    let identities = 0;
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      identities++;
      if (identities === 2) {
        if (name === "401") return new Response(null, { status: 401 });
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("", "AbortError"));
          });
        });
      }
      return Response.json({ id: 1 });
    });
    list.mockImplementationOnce(() => releaseList.promise);
    (content as unknown as { main: () => void }).main();
    const listener = addListener.mock.calls[0]![0];
    const sender = {
      id: "fixture-extension",
      url: "chrome-extension://fixture-extension/sidepanel.html",
    };
    const owner = response();
    const follower = response();
    listener(request, sender, owner.respond);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    if (name === "timeout") vi.useFakeTimers();
    listener(request, sender, follower.respond);
    if (name === "timeout") await vi.advanceTimersByTimeAsync(1_000);

    expect(await follower.done).toEqual({ status: "error", code });
    releaseList.resolve({
      status: "success",
      courses: [{ name: "must not escape" }],
    });
    expect(await owner.done).toEqual({ status: "error", code: "RELOAD_TAB" });
    vi.useRealTimers();
  },
);

it("ignores a follower probe that settles after pagehide without clearing the restored scope", async () => {
  const addListener = vi.fn();
  let pagehide!: () => void;
  vi.stubGlobal(
    "addEventListener",
    vi.fn((type: string, listener: EventListener) => {
      if (type === "pagehide") pagehide = listener as () => void;
    }),
  );
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getURL: () => "chrome-extension://fixture-extension/sidepanel.html",
      onMessage: { addListener },
    },
  });
  vi.stubGlobal("location", { href: origin + "/", origin });
  const followerProbe = Promise.withResolvers<Response>();
  const releaseList = Promise.withResolvers<unknown>();
  let identities = 0;
  vi.mocked(fetch).mockImplementation(async () => {
    identities++;
    if (identities === 2) return followerProbe.promise;
    return Response.json({ id: 42 });
  });
  list
    .mockImplementationOnce(() => releaseList.promise)
    .mockResolvedValueOnce({
      status: "success",
      courses: [{ name: "restored" }],
    });
  (content as unknown as { main: () => void }).main();
  const listener = addListener.mock.calls[0]![0];
  const sender = {
    id: "fixture-extension",
    url: "chrome-extension://fixture-extension/sidepanel.html",
  };
  const owner = response();
  const follower = response();
  listener(request, sender, owner.respond);
  await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
  listener(request, sender, follower.respond);
  await vi.waitFor(() => expect(identities).toBe(2));

  pagehide();
  followerProbe.resolve(Response.json({ id: 42 }));
  expect(await follower.done).toEqual({ status: "error", code: "RELOAD_TAB" });
  releaseList.resolve({ status: "success", courses: [{ name: "stale" }] });
  expect(await owner.done).toEqual({ status: "error", code: "RELOAD_TAB" });

  const restored = response();
  listener(request, sender, restored.respond);
  expect(await restored.done).toEqual({
    status: "success",
    courses: [{ name: "restored" }],
  });
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

it("routes document handles through the background LMS boundary and consumes them once", async () => {
  const addListener = vi.fn();
  const sendMessage = vi
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
  vi.stubGlobal("location", { href: origin + "/", origin });
  (content as unknown as { main: () => void }).main();
  const listener = addListener.mock.calls[0]![0];
  const sender = {
    id: "fixture-extension",
    url: "chrome-extension://fixture-extension/sidepanel.html",
  };
  query.mockImplementation(
    async (_origin, _request, _fetch, _now, catalog: NavigationCatalog) => ({
      status: "success",
      documents: catalog.replaceDocuments(origin, [
        {
          module: "Week",
          title: "file.pdf",
          courseId: "101",
          itemId: "501",
          fileId: "777",
          moduleAccess: {},
          itemAccess: {},
        },
      ]),
    }),
  );
  const listed = response();
  listener(
    { version: 1, type: "DOCUMENTS_LIST", course: "Course" },
    sender,
    listed.respond,
  );
  const result = parseResult(await listed.done);
  if (result.status !== "success" || !("documents" in result))
    throw new Error("missing documents");
  const message = {
    version: 1,
    type: "DOCUMENT_OPEN",
    handle: result.documents[0]!.lmsHandle,
  };
  const opened = response();
  listener(message, sender, opened.respond);
  expect(await opened.done).toEqual({ status: "success", opened: true });
  expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    type: "OPEN_LMS_TARGET",
    url: origin + "/courses/101/modules/items/501",
  });
  const replay = response();
  listener(message, sender, replay.respond);
  expect(await replay.done).toEqual({
    status: "error",
    code: "STALE_SELECTION",
  });
  expect(sendMessage).toHaveBeenCalledTimes(1);
  // Given: opening did not invalidate the separate download capability.
  sendMessage.mockResolvedValue({ status: "success", downloaded: true });
  const download = {
    version: 1,
    type: "DOCUMENT_DOWNLOAD",
    handle: result.documents[0]!.downloadHandle,
    course: "Course",
  };
  // When
  const started = response();
  listener(download, sender, started.respond);
  // Then
  expect(await started.done).toEqual({ status: "success", downloaded: true });
  expect(sendMessage).toHaveBeenLastCalledWith({
    version: 1,
    type: "DOWNLOAD_LMS_FILE",
    url: `${origin}/courses/101/files/777/download?download_frd=1`,
    filename: "uniDock/Course/Week/file.pdf",
  });
  const second = response();
  listener(download, sender, second.respond);
  expect(await second.done).toEqual({
    status: "error",
    code: "STALE_SELECTION",
  });
  expect(sendMessage).toHaveBeenCalledTimes(2);
});

it("omits Canvas duration, due dates and module completion from playback discovery", async () => {
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
