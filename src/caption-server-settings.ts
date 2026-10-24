import {
  CaptionServerError,
  errorFor,
  readJson,
  serverErrorCode,
  serverFetch,
} from "./captions/server-http";

// Only the broker session is stored; Google tokens never reach the extension's storage.
export const CAPTION_SESSION_KEY = "unidock.caption-session.v1";
// A random marker rewritten by every logout and data deletion. A sign-in or
// refresh that started before the marker changed must not store its result.
// It lives in memory-only session storage (shared by every extension context),
// so deleting all local data leaves nothing behind on disk.
export const CAPTION_SESSION_EPOCH_KEY = "unidock.caption-session-epoch.v1";

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const REFRESH_MARGIN_MS = 30_000;
const LOGOUT_TIMEOUT_MS = 3_000;

export interface CaptionSession {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  email: string;
}

export function captionServerOrigin(): string {
  return __UNIDOCK_CAPTION_SERVER__;
}

const token = (value: unknown): value is string =>
  typeof value === "string" && /^[\x21-\x7e]{16,4096}$/.test(value);
const time = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 40 &&
  Number.isFinite(Date.parse(value));
const email = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 320 && value.includes("@");

function parseSession(value: unknown): CaptionSession | null {
  const v = value as Partial<CaptionSession> | null | undefined;
  return v &&
    token(v.accessToken) &&
    time(v.accessExpiresAt) &&
    token(v.refreshToken) &&
    time(v.refreshExpiresAt) &&
    email(v.email)
    ? {
        accessToken: v.accessToken,
        accessExpiresAt: v.accessExpiresAt,
        refreshToken: v.refreshToken,
        refreshExpiresAt: v.refreshExpiresAt,
        email: v.email,
      }
    : null;
}

export function sessionFromResponse(body: Record<string, unknown>): CaptionSession {
  const user = body.user as { email?: unknown } | undefined;
  const session = parseSession({
    accessToken: body.access_token,
    accessExpiresAt: body.access_token_expires_at,
    refreshToken: body.refresh_token,
    refreshExpiresAt: body.refresh_token_expires_at,
    email: user?.email,
  });
  if (!session) throw new CaptionServerError("RESPONSE");
  return session;
}

export async function loadSession(): Promise<CaptionSession | null> {
  const values = await chrome.storage.local.get(CAPTION_SESSION_KEY);
  return parseSession(values[CAPTION_SESSION_KEY]);
}

async function saveSession(session: CaptionSession): Promise<void> {
  await chrome.storage.local.set({ [CAPTION_SESSION_KEY]: session });
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(CAPTION_SESSION_KEY);
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const random = (length: number) =>
  base64url(crypto.getRandomValues(new Uint8Array(length)));

export interface AuthorizationRequest {
  url: string;
  verifier: string;
  state: string;
  nonce: string;
  redirectUri: string;
}

export async function authorizationRequest(): Promise<AuthorizationRequest> {
  const verifier = random(32);
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const state = random(16);
  const nonce = random(16);
  const redirectUri = chrome.identity.getRedirectURL();
  const url = new URL(GOOGLE_AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: __UNIDOCK_GOOGLE_CLIENT_ID__,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    prompt: "select_account",
  }).toString();
  return { url: url.toString(), verifier, state, nonce, redirectUri };
}

export function authorizationCode(
  responseUrl: string,
  redirectUri: string,
  state: string,
): string {
  let url: URL;
  try {
    url = new URL(responseUrl);
  } catch {
    throw new CaptionServerError("LOGIN_FAILED");
  }
  const expected = new URL(redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname)
    throw new CaptionServerError("LOGIN_FAILED");
  const params = url.searchParams;
  if (params.get("state") !== state)
    throw new CaptionServerError("LOGIN_FAILED");
  if (params.get("error") === "access_denied")
    throw new CaptionServerError("LOGIN_CANCELLED");
  const code = params.get("code");
  if (params.has("error") || !code || code.length > 2048)
    throw new CaptionServerError("LOGIN_FAILED");
  return code;
}

const jsonInit = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function signIn(): Promise<CaptionSession> {
  const epoch = await readEpoch();
  const request = await authorizationRequest();
  let responseUrl: string | undefined;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: request.url,
      interactive: true,
    });
  } catch {
    throw new CaptionServerError("LOGIN_CANCELLED");
  }
  if (!responseUrl) throw new CaptionServerError("LOGIN_CANCELLED");
  const code = authorizationCode(responseUrl, request.redirectUri, request.state);
  const response = await serverFetch(
    "/v1/auth/google",
    jsonInit({
      code,
      code_verifier: request.verifier,
      redirect_uri: request.redirectUri,
      nonce: request.nonce,
    }),
  );
  if (!response.ok) {
    const error = await errorFor(response);
    throw error.code === "LOGIN_REQUIRED"
      ? new CaptionServerError("LOGIN_FAILED")
      : error;
  }
  const session = sessionFromResponse(await readJson(response));
  await withSessionLock(async () => {
    if ((await readEpoch()) !== epoch) {
      revokeQuietly(session.accessToken);
      throw new CaptionServerError("LOGIN_CANCELLED");
    }
    await saveSession(session);
  });
  return session;
}

async function readEpoch(): Promise<string | undefined> {
  const value = (await chrome.storage.session.get(CAPTION_SESSION_EPOCH_KEY))[
    CAPTION_SESSION_EPOCH_KEY
  ];
  return typeof value === "string" ? value : undefined;
}

function revokeQuietly(accessToken: string): void {
  void serverFetch(
    "/v1/auth/logout",
    withBearer({ method: "POST" }, accessToken),
    AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
  ).catch(() => undefined);
}

function withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)
    ?.locks;
  return locks ? locks.request("unidock-caption-session", fn) : fn();
}

let refreshing: Promise<CaptionSession | null> | null = null;

/**
 * Exchange the refresh token once. If another page already replaced the access
 * token we were using, its session is returned instead, so two pages never
 * spend the same refresh token (the broker would revoke the whole session).
 */
function refreshSession(stale: string): Promise<CaptionSession | null> {
  refreshing ??= withSessionLock(async () => {
    const epoch = await readEpoch();
    const current = await loadSession();
    if (!current) return null;
    if (current.accessToken !== stale) return current;
    if (Date.parse(current.refreshExpiresAt) <= Date.now()) {
      await clearSession();
      return null;
    }
    const response = await serverFetch(
      "/v1/auth/refresh",
      jsonInit({ refresh_token: current.refreshToken }),
    );
    if (response.status === 401) {
      await clearSession();
      return null;
    }
    if (!response.ok) throw await errorFor(response);
    const next = sessionFromResponse(await readJson(response));
    // The lock already orders this against logout; this also holds where
    // Web Locks are unavailable.
    if ((await readEpoch()) !== epoch || !(await loadSession())) {
      revokeQuietly(next.accessToken);
      return null;
    }
    await saveSession(next);
    return next;
  }).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function accessToken(): Promise<string> {
  const session = await loadSession();
  if (!session) throw new CaptionServerError("LOGIN_REQUIRED");
  if (Date.parse(session.accessExpiresAt) - REFRESH_MARGIN_MS > Date.now())
    return session.accessToken;
  const next = await refreshSession(session.accessToken);
  if (!next) throw new CaptionServerError("LOGIN_REQUIRED");
  return next.accessToken;
}

function withBearer(init: RequestInit, bearer: string): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${bearer}` },
  };
}

/**
 * A request with the broker session. An expired access token is refreshed and
 * the request retried once; a rejected session is cleared and reported as
 * LOGIN_REQUIRED. Any other response is returned for the caller to judge.
 */
export async function authorizedFetch(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const bearer = await accessToken();
  let response = await serverFetch(path, withBearer(init, bearer), signal);
  if (response.status === 401 && (await serverErrorCode(response)) === "TOKEN_EXPIRED") {
    const next = await refreshSession(bearer);
    if (!next) throw new CaptionServerError("LOGIN_REQUIRED");
    response = await serverFetch(path, withBearer(init, next.accessToken), signal);
  }
  if (response.status === 401) {
    await clearSession();
    throw new CaptionServerError("LOGIN_REQUIRED");
  }
  return response;
}

/**
 * Best-effort logout: revoke the broker session, then forget it locally. The
 * local session is removed even when the broker cannot be reached.
 */
export function signOut(): Promise<void> {
  return revokeAndClear(clearSession);
}

/**
 * Under the session lock: revoke the broker session (best effort), run `clear`,
 * then write a fresh epoch so no sign-in or refresh already in flight can store
 * its result afterwards. Data deletion passes its own `clear`.
 */
export function revokeAndClear(clear: () => Promise<void>): Promise<void> {
  return withSessionLock(async () => {
    try {
      const session = await loadSession();
      if (session && __UNIDOCK_CAPTION_SERVER__)
        await serverFetch(
          "/v1/auth/logout",
          withBearer({ method: "POST" }, session.accessToken),
          AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
        );
    } catch {
      // The local session is cleared below either way.
    }
    await clear();
    await chrome.storage.session.set({
      [CAPTION_SESSION_EPOCH_KEY]: random(16),
    });
  });
}
