import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  authorizationCode,
  authorizationRequest,
  CAPTION_SESSION_KEY,
  loadSession,
  signIn,
  signOut,
} from "../src/caption-server-settings";
import {
  fixture,
  json,
  mockServer,
  REDIRECT_URI,
  seedSession,
  stubCaptionChrome,
} from "./caption-server-helpers";

let store: Record<string, unknown>;
let launchWebAuthFlow: ReturnType<typeof stubCaptionChrome>["launchWebAuthFlow"];
beforeEach(() => {
  ({ store, launchWebAuthFlow } = stubCaptionChrome());
});
afterEach(() => vi.unstubAllGlobals());

const b64url = (bytes: ArrayBuffer) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

it("builds a Google code request with an S256 PKCE challenge", async () => {
  const request = await authorizationRequest();
  const params = new URL(request.url).searchParams;
  expect(request.url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
  expect(params.get("client_id")).toBe("test-client.apps.googleusercontent.com");
  expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
  expect(params.get("response_type")).toBe("code");
  expect(params.get("scope")).toBe("openid email");
  expect(params.get("code_challenge_method")).toBe("S256");
  expect(request.verifier).toHaveLength(43);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.verifier));
  expect(params.get("code_challenge")).toBe(b64url(digest));
  expect(params.get("state")).toBe(request.state);
  expect(params.get("nonce")).toBe(request.nonce);
  expect((await authorizationRequest()).state).not.toBe(request.state);
});

it("accepts a code only from our redirect URI with the matching state", () => {
  expect(authorizationCode(`${REDIRECT_URI}?code=4/abc&state=s1`, REDIRECT_URI, "s1")).toBe("4/abc");
  for (const url of [
    `https://evil.chromiumapp.org/?code=4/abc&state=s1`,
    `${REDIRECT_URI}?code=4/abc&state=other`,
    `${REDIRECT_URI}?state=s1`,
    `${REDIRECT_URI}?error=server_error&state=s1`,
    "not a url",
  ])
    expect(() => authorizationCode(url, REDIRECT_URI, "s1")).toThrow("LOGIN_FAILED");
  expect(() =>
    authorizationCode(`${REDIRECT_URI}?error=access_denied&state=s1`, REDIRECT_URI, "s1"),
  ).toThrow("LOGIN_CANCELLED");
});

it("exchanges the code at the broker and stores only the broker session", async () => {
  let sentState = "";
  launchWebAuthFlow.mockImplementation(async ({ url }) => {
    sentState = new URL(url).searchParams.get("state")!;
    return `${REDIRECT_URI}?code=4/abc&state=${sentState}`;
  });
  const calls = mockServer(() => json(fixture("session.json")));
  const session = await signIn();
  expect(calls[0]!.path).toBe("/v1/auth/google");
  const body = JSON.parse(calls[0]!.body as string) as Record<string, string>;
  expect(body.code).toBe("4/abc");
  expect(body.redirect_uri).toBe(REDIRECT_URI);
  expect(calls[0]!.headers.Authorization).toBeUndefined();
  expect(session.email).toBe("student@example.com");
  expect(store[CAPTION_SESSION_KEY]).toEqual(session);
  expect(JSON.stringify(store)).not.toContain("4/abc");
});

it("reports a closed login window and a refused account", async () => {
  launchWebAuthFlow.mockRejectedValue(new Error("The user did not approve access."));
  await expect(signIn()).rejects.toMatchObject({ code: "LOGIN_CANCELLED" });
  launchWebAuthFlow.mockImplementation(
    async ({ url }) => `${REDIRECT_URI}?code=4/abc&state=${new URL(url).searchParams.get("state")}`,
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
