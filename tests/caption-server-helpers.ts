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
  /** Only for a request sent through XMLHttpRequest: report body bytes sent. */
  progress?: (loaded: number) => void;
}

type Handler = (call: Call) => Response | Promise<Response>;

/**
 * An XMLHttpRequest that hands each request to the same handler as the fetch
 * stub. Upload progress fires only when the test calls `call.progress`; the
 * answer arrives as a load event with the handler's status, headers and body.
 */
function fakeXhr(handler: Handler, calls: Call[]) {
  return class FakeXhr extends EventTarget {
    readonly upload = new EventTarget();
    status = 0;
    responseText = "";
    responseURL = "";
    private method = "GET";
    private url = "";
    private headers: Record<string, string> = {};
    private responseHeaders = "";
    private readonly controller = new AbortController();

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }

    getAllResponseHeaders() {
      return this.responseHeaders;
    }

    abort() {
      this.controller.abort();
    }

    send(body: Blob) {
      const { signal } = this.controller;
      const call: Call = {
        url: this.url,
        path: new URL(this.url).pathname,
        method: this.method,
        headers: { ...this.headers },
        body,
        signal,
        progress: (loaded) =>
          this.upload.dispatchEvent(Object.assign(new Event("progress"), { loaded })),
      };
      calls.push(call);
      signal.addEventListener("abort", () => this.dispatchEvent(new Event("abort")), {
        once: true,
      });
      void (async () => {
        let response: Response;
        try {
          response = await handler(call);
        } catch {
          if (!signal.aborted) this.dispatchEvent(new Event("error"));
          return;
        }
        if (signal.aborted) return;
        this.status = response.status;
        this.responseURL = this.url;
        this.responseText = await response.text();
        this.responseHeaders = [...response.headers]
          .map(([name, value]) => `${name}: ${value}`)
          .join("\r\n");
        this.dispatchEvent(new Event("load"));
      })();
    }
  };
}

export function mockServer(handler: Handler) {
  const calls: Call[] = [];
  vi.stubGlobal("XMLHttpRequest", fakeXhr(handler, calls));
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
