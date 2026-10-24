import { readFileSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { CAPTION_SESSION_KEY } from "../src/caption-server-settings";

export const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
export const REDIRECT_URI = `https://${EXTENSION_ID}.chromiumapp.org/`;
/** The broker's issuer value in the handoff redirect (its origin). */
export const ISSUER = encodeURIComponent(__UNIDOCK_CAPTION_SERVER__);
export const HANDOFF_CODE = "h".repeat(43);
/** The redirect the broker sends back for the login start URL `url`. */
export const googleRedirect = (url: string, code = HANDOFF_CODE) =>
  `${REDIRECT_URI}?code=${code}&state=${new URL(url).searchParams.get("state")}&iss=${ISSUER}`;

export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.resolve(__dirname, "fixtures/caption-api", name), "utf8"),
  ) as Record<string, unknown>;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export interface Call {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: RequestInit["body"];
  signal: AbortSignal | null | undefined;
}

export function mockServer(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: Call = {
        url,
        path: new URL(url).pathname,
        method: init.method ?? "GET",
        headers: { ...(init.headers as Record<string, string>) },
        body: init.body,
        signal: init.signal,
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

export function stubCaptionChrome(
  store: Record<string, unknown> = {},
  sessionStore: Record<string, unknown> = {},
) {
  const launchWebAuthFlow = vi.fn<(details: { url: string }) => Promise<string | undefined>>();
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(store, values);
        }),
        remove: vi.fn(async (key: string | string[]) => {
          for (const k of [key].flat()) delete store[k];
        }),
        setAccessLevel: vi.fn(async () => undefined),
      },
    },
    identity: {
      getRedirectURL: () => REDIRECT_URI,
      launchWebAuthFlow,
    },
  });
  (chrome.storage as unknown as { session: unknown }).session = {
    get: vi.fn(async (key: string) => ({ [key]: sessionStore[key] })),
    set: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(sessionStore, values);
    }),
  };
  return { store, sessionStore, launchWebAuthFlow };
}

export function seedSession(
  store: Record<string, unknown>,
  overrides: Partial<Record<string, string>> = {},
) {
  store[CAPTION_SESSION_KEY] = {
    id: "seed-session-0001",
    loginId: "seed-login-000001",
    accessToken: `at_seed_${"s".repeat(40)}`,
    accessExpiresAt: "2099-01-01T00:00:00Z",
    refreshToken: `rt_${"b".repeat(40)}`,
    refreshExpiresAt: "2099-02-01T00:00:00Z",
    email: "student@example.com",
    ...overrides,
  };
}
