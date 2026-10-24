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
// The latest sign-in attempt. When two sign-ins overlap, only the one started
// last may store its session; an earlier one that finishes later is dropped.
const LOGIN_ATTEMPT_KEY = "unidock.caption-login-attempt.v1";

// The broker runs the Google login as its own web client (ADR-0012 in the
// server repository); the extension only opens this page and receives a
// one-use handoff code bound to its verifier.
const LOGIN_START = "/v1/auth/google/start";
const COMMIT_LOCK = "unidock-caption-commit";
const REFRESH_LOCK = "unidock-caption-refresh";
const REFRESH_MARGIN_MS = 30_000;
const LOGOUT_TIMEOUT_MS = 3_000;
const REFRESH_TIMEOUT_MS = 15_000;

export interface CaptionSession {
  /** Local generation id, new on every save; the identity commits compare. */
  id: string;
  /**
   * Lineage of one sign-in, kept across refreshes and new for every sign-in.
   * A request started under one login is never retried under another.
   */
  loginId: string;
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

const sessionId = (value: unknown): value is string =>
  typeof value === "string" && /^[\w-]{16,64}$/.test(value);

function parseSession(value: unknown): CaptionSession | null {
  const v = value as Partial<CaptionSession> | null | undefined;
  return v &&
    sessionId(v.id) &&
    sessionId(v.loginId) &&
    token(v.accessToken) &&
    time(v.accessExpiresAt) &&
    token(v.refreshToken) &&
    time(v.refreshExpiresAt) &&
    email(v.email)
    ? {
        id: v.id,
        loginId: v.loginId,
        accessToken: v.accessToken,
        accessExpiresAt: v.accessExpiresAt,
        refreshToken: v.refreshToken,
        refreshExpiresAt: v.refreshExpiresAt,
        email: v.email,
      }
    : null;
}

export function sessionFromResponse(
  body: Record<string, unknown>,
  loginId: string = random(16),
): CaptionSession {
  const user = body.user as { email?: unknown } | undefined;
  const session = parseSession({
    id: random(16),
    loginId,
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
  const redirectUri = chrome.identity.getRedirectURL();
  const url = new URL(LOGIN_START, captionServerOrigin());
  url.search = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    handoff_challenge: challenge,
    handoff_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), verifier, state, redirectUri };
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
  // RFC 9207 style: the response names its issuer, which must be our broker.
  if (params.get("state") !== state || params.get("iss") !== captionServerOrigin())
    throw new CaptionServerError("LOGIN_FAILED");
  if (params.get("error") === "access_denied")
    throw new CaptionServerError("LOGIN_CANCELLED");
  const code = params.get("code");
  if (params.has("error") || !code || !/^[\w-]{43,128}$/.test(code))
    throw new CaptionServerError("LOGIN_FAILED");
  return code;
}

const jsonInit = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function signIn(): Promise<CaptionSession> {
  // Requested before any other await, so attempts are ordered by the commit
  // lock's queue: the sign-in started last is the one that may store.
  const { epoch, loginAttempt } = await withLock(COMMIT_LOCK, async () => {
    const attempt = random(16);
    await chrome.storage.session.set({ [LOGIN_ATTEMPT_KEY]: attempt });
    return { epoch: await readEpoch(), loginAttempt: attempt };
  });
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
    "/v1/auth/handoff",
    jsonInit({
      code,
      code_verifier: request.verifier,
      redirect_uri: request.redirectUri,
    }),
  );
  if (!response.ok) {
    const error = await errorFor(response);
    throw error.code === "LOGIN_REQUIRED"
      ? new CaptionServerError("LOGIN_FAILED")
      : error;
  }
  const session = sessionFromResponse(await readJson(response));
  const { applied, previous } = await commit({ epoch, loginAttempt }, session);
  if (!applied) {
    revokeQuietly(session.accessToken);
    throw new CaptionServerError("LOGIN_CANCELLED");
  }
  // A new sign-in ends the session it replaces (ASVS 5.0 V7.2.4).
  if (previous) revokeQuietly(previous.accessToken);
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

function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)
    ?.locks;
  return locks ? locks.request(name, fn) : fn();
}

interface Snapshot {
  epoch: string | undefined;
  session: CaptionSession | null;
}

let trustedOnly: Promise<void> | null = null;

/**
 * Tokens are written only after storage.local is restricted to extension pages
 * and workers. The background sets this at startup without waiting, so the
 * first token write in any context waits for it here; if it fails, no token is
 * stored.
 */
function restrictStorage(): Promise<void> {
  trustedOnly ??= chrome.storage.local
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch(() => {
      trustedOnly = null;
      throw new CaptionServerError("UNAVAILABLE");
    });
  return trustedOnly;
}

async function readSnapshot(): Promise<Snapshot> {
  return { epoch: await readEpoch(), session: await loadSession() };
}

/**
 * The only writer of the stored session. Under the commit lock (held for
 * storage calls only, never across the network, never stolen) it applies
 * `next` (a session, or null to clear) only while the epoch and the stored
 * session id are still the ones the caller started from. Comparing inside the
 * lock is what makes it a compare-and-swap: a late answer for an older session
 * can neither overwrite nor delete a newer one.
 */
async function commit(
  expect: { epoch?: string | undefined; sessionId?: string | null; loginAttempt?: string },
  next: CaptionSession | null,
): Promise<{ applied: boolean; previous: CaptionSession | null }> {
  return withLock(COMMIT_LOCK, async () => {
    const { epoch, session } = await readSnapshot();
    const attempt =
      "loginAttempt" in expect
        ? (await chrome.storage.session.get(LOGIN_ATTEMPT_KEY))[LOGIN_ATTEMPT_KEY]
        : undefined;
    const stale =
      ("epoch" in expect && epoch !== expect.epoch) ||
      ("sessionId" in expect && (session?.id ?? null) !== expect.sessionId) ||
      ("loginAttempt" in expect && attempt !== expect.loginAttempt);
    if (stale) return { applied: false, previous: session };
    if (next) {
      await restrictStorage();
      await chrome.storage.local.set({ [CAPTION_SESSION_KEY]: next });
    }
    else await chrome.storage.local.remove(CAPTION_SESSION_KEY);
    return { applied: true, previous: session };
  });
}

/**
 * Exchange the refresh token of `stale` once. The refresh lock spans the
 * network call so two pages never spend the same refresh token (the broker
 * would revoke the whole session); the result is stored only through
 * `commit`. When another page already refreshed this login, its session is
 * returned; a different login never is. There is deliberately no in-memory
 * shared promise: callers queue on the lock and each re-checks the stored
 * session under it, so a request of one login can never join another's refresh.
 */
function refreshSession(stale: CaptionSession): Promise<CaptionSession | null> {
  return withLock(REFRESH_LOCK, async () => {
    const { epoch, session: current } = await withLock(COMMIT_LOCK, readSnapshot);
    // Another page already refreshed this login: use its result. A different
    // login (or none) means the caller's work belonged to an ended session.
    const sameLogin = (session: CaptionSession | null) =>
      session && session.loginId === stale.loginId ? session : null;
    if (!current || current.id !== stale.id) return sameLogin(current);
    const expect = { epoch, sessionId: current.id };
    const endWith = async (next: CaptionSession | null) =>
      (await commit(expect, next)).applied ? next : sameLogin(await loadSession());
    if (Date.parse(current.refreshExpiresAt) <= Date.now()) return endWith(null);
    let response: Response;
    try {
      response = await serverFetch(
        "/v1/auth/refresh",
        jsonInit({ refresh_token: current.refreshToken }),
        AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      );
    } catch {
      throw new CaptionServerError("NETWORK");
    }
    if (response.status === 401) return endWith(null);
    if (!response.ok) throw await errorFor(response);
    const next = sessionFromResponse(await readJson(response), current.loginId);
    const stored = await endWith(next);
    if (stored !== next) revokeQuietly(next.accessToken);
    return stored;
  });
}

async function usableSession(loginId?: string): Promise<CaptionSession> {
  const session = await loadSession();
  if (!session || (loginId !== undefined && session.loginId !== loginId))
    throw new CaptionServerError("LOGIN_REQUIRED");
  if (Date.parse(session.accessExpiresAt) - REFRESH_MARGIN_MS > Date.now())
    return session;
  const next = await refreshSession(session);
  if (!next) throw new CaptionServerError("LOGIN_REQUIRED");
  return next;
}

function withBearer(init: RequestInit, bearer: string): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${bearer}` },
  };
}

/**
 * A request with the broker session. An expired access token is refreshed and
 * the request retried once. A rejected session is cleared, but only if it is
 * still the stored one, and reported as LOGIN_REQUIRED. Any other response is
 * returned for the caller to judge.
 */
export async function authorizedFetch(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
  /** Send only under this login; another login means LOGIN_REQUIRED. */
  loginId?: string,
): Promise<Response> {
  let used = await usableSession(loginId);
  let response = await serverFetch(path, withBearer(init, used.accessToken), signal);
  if (response.status === 401 && (await serverErrorCode(response)) === "TOKEN_EXPIRED") {
    const next = await refreshSession(used);
    if (!next) throw new CaptionServerError("LOGIN_REQUIRED");
    used = next;
    response = await serverFetch(path, withBearer(init, used.accessToken), signal);
  }
  if (response.status === 401) {
    await commit({ sessionId: used.id }, null);
    throw new CaptionServerError("LOGIN_REQUIRED");
  }
  return response;
}

/**
 * End every session of this account at the broker (other devices included),
 * then forget the local one. Resolves only when the broker confirmed it. When
 * the broker rejects this session (401), other devices were NOT logged out:
 * the local session is forgotten and LOGIN_REQUIRED is thrown so the caller
 * can ask the user to sign in again first.
 */
export async function signOutEverywhere(): Promise<void> {
  const started = await loadSession();
  if (!started) throw new CaptionServerError("LOGIN_REQUIRED");
  let rejected = false;
  try {
    const response = await authorizedFetch(
      "/v1/me/sessions",
      { method: "DELETE" },
      undefined,
      started.loginId,
    );
    if (!response.ok) throw await errorFor(response);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "LOGIN_REQUIRED") throw error;
    rejected = true;
  }
  // Forget the local session only if it is still the login this started from;
  // a sign-in completed meanwhile stays.
  await withLock(COMMIT_LOCK, async () => {
    if ((await loadSession())?.loginId === started.loginId)
      await chrome.storage.local.remove(CAPTION_SESSION_KEY);
  });
  if (rejected) throw new CaptionServerError("LOGIN_REQUIRED");
}

/** Best-effort logout: forget the session locally, then revoke it at the broker. */
export function signOut(): Promise<void> {
  return revokeAndClear(() => chrome.storage.local.remove(CAPTION_SESSION_KEY));
}

/**
 * In one commit-lock section: write a fresh epoch (so any sign-in or refresh
 * already in flight fails its commit), then run `clear`. The broker session
 * is revoked afterwards, outside the lock and best effort (3 s), so neither a
 * hung refresh nor a slow broker holds up logout or data deletion. Data
 * deletion passes its own `clear`.
 */
export async function revokeAndClear(clear: () => Promise<void>): Promise<void> {
  const previous = await withLock(COMMIT_LOCK, async () => {
    const session = await loadSession();
    await chrome.storage.session.set({ [CAPTION_SESSION_EPOCH_KEY]: random(16) });
    await clear();
    return session;
  });
  if (!previous || !__UNIDOCK_CAPTION_SERVER__) return;
  try {
    await serverFetch(
      "/v1/auth/logout",
      withBearer({ method: "POST" }, previous.accessToken),
      AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
    );
  } catch {
    // The local session is already gone; revocation is best effort.
  }
}
