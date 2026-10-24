import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizationCode,
  authorizationRequest,
  CAPTION_SESSION_EPOCH_KEY,
  CAPTION_SESSION_KEY,
  loadSession,
  revokeAndClear,
  signIn,
  signOut,
  signOutEverywhere,
} from "../src/caption-server-settings";
import { getJob } from "../src/captions/job-client";
import {
  fixture,
  googleRedirect,
  HANDOFF_CODE,
  ISSUER,
  json,
  mockServer,
  REDIRECT_URI,
  seedSession,
  stubCaptionChrome,
} from "./caption-server-helpers";

let store: Record<string, unknown>;
let sessionStore: Record<string, unknown>;
let launchWebAuthFlow: ReturnType<typeof stubCaptionChrome>["launchWebAuthFlow"];
beforeEach(() => {
  ({ store, sessionStore, launchWebAuthFlow } = stubCaptionChrome());
});
afterEach(() => vi.unstubAllGlobals());

const b64url = (bytes: ArrayBuffer) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

it("opens the broker login with an S256 handoff challenge", async () => {
  const request = await authorizationRequest();
  const url = new URL(request.url);
  expect(url.origin + url.pathname).toBe(`${__UNIDOCK_CAPTION_SERVER__}/v1/auth/google/start`);
  const params = url.searchParams;
  expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
  expect(params.get("handoff_challenge_method")).toBe("S256");
  // The extension is not a Google OAuth client: no client ID or Google URL.
  expect(params.has("client_id")).toBe(false);
  expect(request.verifier).toHaveLength(43);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.verifier));
  expect(params.get("handoff_challenge")).toBe(b64url(digest));
  expect(params.get("state")).toBe(request.state);
  expect((await authorizationRequest()).state).not.toBe(request.state);
});

it("accepts a handoff code only from our redirect URI with the matching state and broker issuer", () => {
  const H = HANDOFF_CODE;
  const iss = `&iss=${ISSUER}`;
  expect(authorizationCode(`${REDIRECT_URI}?code=${H}&state=s1${iss}`, REDIRECT_URI, "s1")).toBe(H);
  for (const url of [
    `https://evil.chromiumapp.org/?code=${H}&state=s1${iss}`,
    `${REDIRECT_URI}?code=${H}&state=other${iss}`,
    `${REDIRECT_URI}?state=s1${iss}`,
    `${REDIRECT_URI}?code=short&state=s1${iss}`,
    `${REDIRECT_URI}?error=server_error&state=s1${iss}`,
    // The response must name our broker as its issuer.
    `${REDIRECT_URI}?code=${H}&state=s1`,
    `${REDIRECT_URI}?code=${H}&state=s1&iss=https%3A%2F%2Faccounts.google.com`,
    "not a url",
  ])
    expect(() => authorizationCode(url, REDIRECT_URI, "s1")).toThrow("LOGIN_FAILED");
  expect(() =>
    authorizationCode(`${REDIRECT_URI}?error=access_denied&state=s1${iss}`, REDIRECT_URI, "s1"),
  ).toThrow("LOGIN_CANCELLED");
});

it("exchanges the code at the broker and stores only the broker session", async () => {
  launchWebAuthFlow.mockImplementation(async ({ url }) => googleRedirect(url));
  const calls = mockServer(() => json(fixture("session.json")));
  const session = await signIn();
  expect(calls[0]!.path).toBe("/v1/auth/handoff");
  const body = JSON.parse(calls[0]!.body as string) as Record<string, string>;
  expect(body.code).toBe(HANDOFF_CODE);
  expect(body.redirect_uri).toBe(REDIRECT_URI);
  expect(calls[0]!.headers.Authorization).toBeUndefined();
  expect(session.email).toBe("student@example.com");
  expect(store[CAPTION_SESSION_KEY]).toEqual(session);
  expect(JSON.stringify(store)).not.toContain(HANDOFF_CODE);
});

it("reports a closed login window and a refused account", async () => {
  launchWebAuthFlow.mockRejectedValue(new Error("The user did not approve access."));
  await expect(signIn()).rejects.toMatchObject({ code: "LOGIN_CANCELLED" });
  launchWebAuthFlow.mockImplementation(
    async ({ url }) => googleRedirect(url),
  );
  mockServer(() => json({ error: { code: "ACCOUNT_NOT_ALLOWED" } }, 403));
  await expect(signIn()).rejects.toMatchObject({ code: "ACCOUNT_NOT_ALLOWED" });
  mockServer(() => json({ error: { code: "OAUTH_FAILED" } }, 400));
  await expect(signIn()).rejects.toMatchObject({ code: "LOGIN_FAILED" });
  expect(store[CAPTION_SESSION_KEY]).toBeUndefined();
});

it("revokes the session at the broker and clears it even when offline", async () => {
  seedSession(store);
  const calls = mockServer(() => new Response(null, { status: 204 }));
  await signOut();
  expect(calls[0]!.path).toBe("/v1/auth/logout");
  expect(calls[0]!.headers.Authorization).toBe(`Bearer at_seed_${"s".repeat(40)}`);
  expect(store[CAPTION_SESSION_KEY]).toBeUndefined();

  seedSession(store);
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
  await signOut();
  expect(store[CAPTION_SESSION_KEY]).toBeUndefined();
});

it("ignores a malformed stored session", async () => {
  store[CAPTION_SESSION_KEY] = { accessToken: "short", email: "x" };
  expect(await loadSession()).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

it("drops a sign-in that the broker answers after logout", async () => {
  launchWebAuthFlow.mockImplementation(
    async ({ url }) => googleRedirect(url),
  );
  const exchange = deferred<Response>();
  const calls = mockServer((call) =>
    call.path === "/v1/auth/handoff" ? exchange.promise : new Response(null, { status: 204 }),
  );
  const pending = signIn();
  await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/auth/handoff")).toBe(true));
  await signOut();
  exchange.resolve(json(fixture("session.json")));
  await expect(pending).rejects.toMatchObject({ code: "LOGIN_CANCELLED" });
  expect(store[CAPTION_SESSION_KEY]).toBeUndefined();
  // The late session is revoked at the broker rather than silently kept.
  await vi.waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.path === "/v1/auth/logout" &&
          c.headers.Authorization === `Bearer ${fixture("session.json").access_token}`,
      ),
    ).toBe(true),
  );
});

it.each([
  ["with Web Locks", false],
  ["without Web Locks", true],
])("never keeps a refresh that races with deleting all data (%s)", async (_name, noLocks) => {
  if (noLocks) vi.stubGlobal("navigator", {});
  seedSession(store, { accessExpiresAt: "2000-01-01T00:00:00Z" });
  const refresh = deferred<Response>();
  const calls = mockServer((call) =>
    call.path === "/v1/auth/refresh"
      ? refresh.promise
      : call.path === "/v1/auth/logout"
        ? new Response(null, { status: 204 })
        : json(fixture("job-queued.json")),
  );
  const pending = getJob("j");
  await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/auth/refresh")).toBe(true));
  // With Web Locks the deletion waits for the refresh and then revokes it;
  // without them the late refresh sees the new epoch. Either way it is gone.
  const wiping = revokeAndClear(async () => {
    for (const key of Object.keys(store)) delete store[key];
  });
  refresh.resolve(json(fixture("session.json")));
  await Promise.allSettled([pending]);
  await wiping;
  expect(store).toEqual({});
  expect(typeof sessionStore[CAPTION_SESSION_EPOCH_KEY]).toBe("string");
  await vi.waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.path === "/v1/auth/logout" &&
          c.headers.Authorization === `Bearer ${fixture("session.json").access_token}`,
      ),
    ).toBe(true),
  );
});

it("writes a new epoch on every logout", async () => {
  seedSession(store);
  mockServer(() => new Response(null, { status: 204 }));
  await signOut();
  const first = sessionStore[CAPTION_SESSION_EPOCH_KEY];
  expect(typeof first).toBe("string");
  await signOut();
  expect(sessionStore[CAPTION_SESSION_EPOCH_KEY]).not.toBe(first);
  expect(store[CAPTION_SESSION_EPOCH_KEY]).toBeUndefined();
});

it.each([
  ["logout", () => signOut()],
  [
    "deleting all data",
    () =>
      revokeAndClear(async () => {
        delete store[CAPTION_SESSION_KEY];
      }),
  ],
] as const)("%s does not wait for a refresh whose answer never comes", async (_name, end) => {
  seedSession(store, { accessExpiresAt: "2000-01-01T00:00:00Z" });
  const refresh = deferred<Response>();
  const calls = mockServer((call) =>
    call.path === "/v1/auth/refresh" ? refresh.promise : new Response(null, { status: 204 }),
  );
  const pending = getJob("j").catch((error: { code?: string }) => error.code);
  await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/auth/refresh")).toBe(true));
  // Must settle while the refresh is still unanswered (a wait would time out).
  await end();
  expect(store[CAPTION_SESSION_KEY]).toBeUndefined();
  refresh.resolve(json(fixture("session.json")));
  expect(await pending).toBe("LOGIN_REQUIRED");
  expect(store[CAPTION_SESSION_KEY]).toBeUndefined();
});

it("gives the refresh request a time limit", async () => {
  seedSession(store, { accessExpiresAt: "2000-01-01T00:00:00Z" });
  const calls = mockServer((call) =>
    call.path === "/v1/auth/refresh" ? json(fixture("session.json")) : json(fixture("job-queued.json")),
  );
  await getJob("j");
  expect(calls.find((c) => c.path === "/v1/auth/refresh")!.signal).toBeInstanceOf(AbortSignal);
});

describe("a late answer for an older session never touches a newer one", () => {
  async function newSessionAfterLogout(lateAnswer: Promise<Response>) {
    seedSession(store, { accessExpiresAt: "2000-01-01T00:00:00Z" });
    const calls = mockServer((call) =>
      call.path === "/v1/auth/refresh"
        ? lateAnswer
        : call.path === "/v1/auth/handoff"
          ? json(fixture("session.json"))
          : new Response(null, { status: 204 }),
    );
    const pending = getJob("j").catch((error: { code?: string }) => error.code);
    await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/auth/refresh")).toBe(true));
    await signOut();
    launchWebAuthFlow.mockImplementation(async ({ url }) => googleRedirect(url));
    const fresh = await signIn();
    return { calls, pending, fresh };
  }

  it("keeps the new session when the old refresh answers 401", async () => {
    const late = deferred<Response>();
    const { pending, fresh } = await newSessionAfterLogout(late.promise);
    late.resolve(json({ error: { code: "REFRESH_REUSED" } }, 401));
    await pending;
    expect((store[CAPTION_SESSION_KEY] as { id: string }).id).toBe(fresh.id);
  });

  it("keeps the new session when the old refresh succeeds late", async () => {
    const late = deferred<Response>();
    const { pending, fresh, calls } = await newSessionAfterLogout(late.promise);
    late.resolve(json({ ...fixture("session.json"), access_token: `late_${"z".repeat(40)}` }));
    await pending;
    expect((store[CAPTION_SESSION_KEY] as { id: string }).id).toBe(fresh.id);
    await vi.waitFor(() =>
      expect(
        calls.some((c) => c.path === "/v1/auth/logout" && c.headers.Authorization?.includes("late_")),
      ).toBe(true),
    );
  });

  it("keeps the new session when an old request answers 401", async () => {
    seedSession(store);
    const late = deferred<Response>();
    mockServer((call) =>
      call.path === "/v1/transcription-jobs/j"
        ? late.promise
        : call.path === "/v1/auth/handoff"
          ? json(fixture("session.json"))
          : new Response(null, { status: 204 }),
    );
    const pending = getJob("j").catch((error: { code?: string }) => error.code);
    await signOut();
    launchWebAuthFlow.mockImplementation(async ({ url }) => googleRedirect(url));
    const fresh = await signIn();
    late.resolve(json({ error: { code: "UNAUTHENTICATED" } }, 401));
    expect(await pending).toBe("LOGIN_REQUIRED");
    expect((store[CAPTION_SESSION_KEY] as { id: string }).id).toBe(fresh.id);
  });

  it("still clears its own session when the broker rejects it", async () => {
    seedSession(store);
    mockServer(() => json({ error: { code: "UNAUTHENTICATED" } }, 401));
    await expect(getJob("j")).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
    expect(store[CAPTION_SESSION_KEY]).toBeUndefined();
  });
});

it("ends the replaced session at the broker when signing in again", async () => {
  seedSession(store);
  launchWebAuthFlow.mockImplementation(async ({ url }) => googleRedirect(url));
  const calls = mockServer((call) =>
    call.path === "/v1/auth/handoff" ? json(fixture("session.json")) : new Response(null, { status: 204 }),
  );
  await signIn();
  await vi.waitFor(() =>
    expect(
      calls.some(
        (c) => c.path === "/v1/auth/logout" && c.headers.Authorization === `Bearer at_seed_${"s".repeat(40)}`,
      ),
    ).toBe(true),
  );
});

it("stores only the sign-in started last when two overlap", async () => {
  const flows: ((value: string) => void)[] = [];
  const urls: string[] = [];
  launchWebAuthFlow.mockImplementation(
    ({ url }) =>
      new Promise<string>((resolve) => {
        urls.push(url);
        flows.push(resolve);
      }),
  );
  mockServer((call) =>
    call.path === "/v1/auth/handoff"
      ? json({ ...fixture("session.json"), access_token: `at_${JSON.parse(call.body as string).code.replace(/(s|f)+$/, "")}_${"q".repeat(30)}` })
      : new Response(null, { status: 204 }),
  );
  const first = signIn().catch((error: { code?: string }) => error.code);
  await vi.waitFor(() => expect(flows).toHaveLength(1));
  const second = signIn();
  await vi.waitFor(() => expect(flows).toHaveLength(2));
  flows[1]!(googleRedirect(urls[1]!, "second".padEnd(43, "s")));
  await second;
  flows[0]!(googleRedirect(urls[0]!, "first".padEnd(43, "f")));
  expect(await first).toBe("LOGIN_CANCELLED");
  expect((store[CAPTION_SESSION_KEY] as { accessToken: string }).accessToken).toContain("at_second_");
});

it("restricts storage to trusted contexts before writing tokens, and refuses when it cannot", async () => {
  // A fresh module: the restriction is established once per extension context.
  vi.resetModules();
  const { signIn } = await import("../src/caption-server-settings");
  launchWebAuthFlow.mockImplementation(async ({ url }) => googleRedirect(url));
  mockServer(() => json(fixture("session.json")));
  const setAccessLevel = vi.mocked(chrome.storage.local.setAccessLevel);
  const set = vi.mocked(chrome.storage.local.set);
  setAccessLevel.mockRejectedValueOnce(new Error("Context cannot set the storage access level"));
  await expect(signIn()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(store[CAPTION_SESSION_KEY]).toBeUndefined();
  await signIn();
  expect(setAccessLevel).toHaveBeenLastCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  expect(setAccessLevel.mock.invocationCallOrder.at(-1)!).toBeLessThan(set.mock.invocationCallOrder.at(-1)!);
});

it("never retries an old request under a different login", async () => {
  seedSession(store);
  const late = deferred<Response>();
  const calls = mockServer((call) =>
    call.path === "/v1/transcription-jobs"
      ? late.promise
      : call.path === "/v1/auth/handoff"
        ? json(fixture("session.json"))
        : new Response(null, { status: 204 }),
  );
  const { createJob } = await import("../src/captions/job-client");
  const pending = createJob("unidock-key-for-login-A").catch((error: { code?: string }) => error.code);
  await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/transcription-jobs")).toBe(true));
  await signOut();
  launchWebAuthFlow.mockImplementation(async ({ url }) => googleRedirect(url));
  await signIn();
  late.resolve(json(fixture("error-token-expired.json"), 401));
  expect(await pending).toBe("LOGIN_REQUIRED");
  expect(calls.filter((c) => c.path === "/v1/transcription-jobs")).toHaveLength(1);
});

it("orders overlapping sign-ins by when they started, even if the first start is slow", async () => {
  const slowFirstRead = deferred<void>();
  const realGet = chrome.storage.session.get;
  let reads = 0;
  vi.mocked(chrome.storage.session).get = vi.fn(async (key: string) => {
    if (reads++ === 0) await slowFirstRead.promise;
    return realGet(key);
  }) as never;
  const flows: { url: string; resolve: (value: string) => void }[] = [];
  launchWebAuthFlow.mockImplementation(
    ({ url }) => new Promise<string>((resolve) => flows.push({ url, resolve })),
  );
  let exchange = 0;
  mockServer((call) =>
    call.path === "/v1/auth/handoff"
      ? json({ ...fixture("session.json"), access_token: `at_exchange_${++exchange}_${"q".repeat(30)}` })
      : new Response(null, { status: 204 }),
  );
  const first = signIn().catch((error: { code?: string }) => error.code);
  const second = signIn().catch((error: { code?: string }) => error.code);
  // Let the second sign-in get as far as it can while the first one's start is
  // stuck: either it is queued behind the first on the commit lock, or (if the
  // start were unordered) it already reached the Google window.
  await vi.waitFor(async () => {
    const queued = (await navigator.locks.query()).pending?.some(
      (lock) => lock.name === "unidock-caption-commit",
    );
    expect(queued || flows.length === 1).toBe(true);
  });
  slowFirstRead.resolve();
  await vi.waitFor(() => expect(flows).toHaveLength(2));
  // Finish the window that opened last first, as in the reported trace.
  flows[1]!.resolve(googleRedirect(flows[1]!.url));
  flows[0]!.resolve(googleRedirect(flows[0]!.url));
  expect(await first).toBe("LOGIN_CANCELLED");
  const winner = (await second) as { accessToken: string };
  expect((store[CAPTION_SESSION_KEY] as { accessToken: string }).accessToken).toBe(winner.accessToken);
});

it("logging out everywhere never clears a login completed meanwhile", async () => {
  seedSession(store);
  const ended = deferred<Response>();
  const calls = mockServer((call) =>
    call.method === "DELETE" && call.path === "/v1/me/sessions"
      ? ended.promise
      : call.path === "/v1/auth/handoff"
        ? json(fixture("session.json"))
        : new Response(null, { status: 204 }),
  );
  const pending = signOutEverywhere();
  await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  launchWebAuthFlow.mockImplementation(async ({ url }) => googleRedirect(url));
  const fresh = await signIn();
  ended.resolve(new Response(null, { status: 204 }));
  await pending;
  expect((store[CAPTION_SESSION_KEY] as { id: string }).id).toBe(fresh.id);
  expect(
    calls.some((c) => c.headers.Authorization === `Bearer ${fresh.accessToken}` && c.path === "/v1/auth/logout"),
  ).toBe(false);
});

it("an old request never joins a refresh of a later login", async () => {
  seedSession(store);
  const oldPost = deferred<Response>();
  const refresh = deferred<Response>();
  const calls = mockServer((call) =>
    call.path === "/v1/transcription-jobs" && call.method === "POST"
      ? oldPost.promise
      : call.path === "/v1/auth/handoff"
        ? json(fixture("session.json"))
        : call.path === "/v1/auth/refresh"
          ? refresh.promise
          : call.path === "/v1/transcription-jobs/j"
            ? json(fixture("job-queued.json"))
            : new Response(null, { status: 204 }),
  );
  const { createJob } = await import("../src/captions/job-client");
  const old = createJob("unidock-key-for-login-A").catch((error: { code?: string }) => error.code);
  await vi.waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/transcription-jobs")).toBe(true));
  await signOut();
  launchWebAuthFlow.mockImplementation(async ({ url }) => googleRedirect(url));
  await signIn();
  // B's access token expires and B starts a refresh that has not answered yet.
  (store[CAPTION_SESSION_KEY] as { accessExpiresAt: string }).accessExpiresAt = "2000-01-01T00:00:00Z";
  const later = getJob("j");
  await vi.waitFor(() => expect(calls.some((c) => c.path === "/v1/auth/refresh")).toBe(true));
  oldPost.resolve(json(fixture("error-token-expired.json"), 401));
  // Answer B's refresh only once A's retry is queued on the refresh lock.
  await vi.waitFor(async () => {
    const { pending = [] } = await navigator.locks.query();
    expect(pending.some((lock) => lock.name === "unidock-caption-refresh")).toBe(true);
  });
  refresh.resolve(json({ ...fixture("session.json"), access_token: `at_b2_${"r".repeat(40)}` }));
  await later;
  expect(await old).toBe("LOGIN_REQUIRED");
  expect(calls.filter((c) => c.method === "POST" && c.path === "/v1/transcription-jobs")).toHaveLength(1);
});
