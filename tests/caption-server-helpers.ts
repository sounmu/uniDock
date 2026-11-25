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

/** A streamed request body that the test reads; each read is a pull by fetch. */
export interface HeldBody {
  /** Read one more slice; its upload progress has been reported when this resolves. */
  pull(): Promise<void>;
  /** Read the rest and return the whole body. */
  drain(): Promise<Blob>;
}

export interface Call {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  /** A streamed body is drained into a Blob first, unless the server holds streams. */
  body: RequestInit["body"];
  /** Sent as a ReadableStream body. */
  streamed: boolean;
  /** The stream, when the server holds streams for the test to read. */
  held?: HeldBody;
  redirect: RequestInit["redirect"];
  signal: AbortSignal | null | undefined;
}

type Handler = (call: Call) => Response | Promise<Response>;

function holdBody(stream: ReadableStream<Uint8Array<ArrayBuffer>>): HeldBody {
  const reader = stream.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let done = false;
  const pull = async () => {
    if (done) return;
    const next = await reader.read();
    if (next.done) done = true;
    else parts.push(next.value);
  };
  return {
    pull,
    async drain() {
      while (!done) await pull();
      return new Blob(parts);
    },
  };
}

/**
 * Stubs fetch with `handler`. Requests reach the handler in the order they
 * were sent. A ReadableStream body is read to the end before the handler runs,
 * or, with `holdStreams`, left for the test to read through `call.held`.
 */
export function mockServer(handler: Handler, { holdStreams = false } = {}) {
  const calls: Call[] = [];
  let arrived = Promise.resolve();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const stream = init.body instanceof ReadableStream ? holdBody(init.body) : undefined;
      const call: Call = {
        url,
        path: new URL(url).pathname,
        method: init.method ?? "GET",
        headers: { ...(init.headers as Record<string, string>) },
        body: init.body,
        streamed: stream !== undefined,
        held: holdStreams ? stream : undefined,
        redirect: init.redirect,
        signal: init.signal,
      };
      const turn = arrived.then(async () => {
        if (stream && !holdStreams) call.body = await stream.drain();
        calls.push(call);
      });
      arrived = turn;
      await turn;
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
