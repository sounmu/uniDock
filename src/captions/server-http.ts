export type CaptionServerErrorCode =
  | "NO_SERVER"
  | "LOGIN_REQUIRED"
  | "LOGIN_CANCELLED"
  | "LOGIN_FAILED"
  | "ACCOUNT_NOT_ALLOWED"
  | "QUOTA_EXCEEDED"
  | "ACTIVE_JOB_EXISTS"
  | "RATE_LIMITED"
  | "TOO_LARGE"
  | "EXPIRED"
  | "UPLOAD_CONFLICT"
  | "UPLOAD_CLOSED"
  | "UNAVAILABLE"
  | "NETWORK"
  | "SERVER"
  | "RESPONSE"
  | "ABORTED";

export class CaptionServerError extends Error {
  constructor(
    readonly code: CaptionServerErrorCode,
    readonly retryAfterS?: number,
  ) {
    super(code);
  }
}

const MAX_JSON_BYTES = 8 * 1024 * 1024;

export const SERVER_CODES: Readonly<Record<string, CaptionServerErrorCode>> = {
  UNAUTHENTICATED: "LOGIN_REQUIRED",
  TOKEN_EXPIRED: "LOGIN_REQUIRED",
  REFRESH_REUSED: "LOGIN_REQUIRED",
  OAUTH_FAILED: "LOGIN_FAILED",
  ACCOUNT_NOT_ALLOWED: "ACCOUNT_NOT_ALLOWED",
  ACCOUNT_DISABLED: "ACCOUNT_NOT_ALLOWED",
  NOT_FOUND: "EXPIRED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  ACTIVE_JOB_EXISTS: "ACTIVE_JOB_EXISTS",
  RATE_LIMITED: "RATE_LIMITED",
  PAYLOAD_TOO_LARGE: "TOO_LARGE",
  UPLOAD_LENGTH_MISMATCH: "UPLOAD_CONFLICT",
  UPLOAD_NOT_ACCEPTING: "UPLOAD_CLOSED",
  SERVICE_UNAVAILABLE: "UNAVAILABLE",
};

function statusCode(status: number): CaptionServerErrorCode {
  if (status === 401) return "LOGIN_REQUIRED";
  if (status === 403) return "ACCOUNT_NOT_ALLOWED";
  if (status === 404 || status === 410) return "EXPIRED";
  if (status === 413) return "TOO_LARGE";
  if (status === 429) return "RATE_LIMITED";
  if (status === 503) return "UNAVAILABLE";
  return "SERVER";
}

export function captionServerBase(): string {
  if (!__UNIDOCK_CAPTION_SERVER__) throw new CaptionServerError("NO_SERVER");
  return __UNIDOCK_CAPTION_SERVER__;
}

/** A request whose body upload reports the bytes sent so far. */
export interface UploadInit {
  method: string;
  headers: Record<string, string>;
  body: Blob;
  onUploadProgress: (sentBytes: number) => void;
}

export type ServerInit = RequestInit | UploadInit;

export async function serverFetch(
  path: string,
  init: ServerInit,
  signal?: AbortSignal,
): Promise<Response> {
  const url = `${captionServerBase()}${path}`;
  try {
    return await ("onUploadProgress" in init
      ? sendWithProgress(url, init, signal)
      : fetch(url, {
          ...init,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          signal,
        }));
  } catch {
    throw new CaptionServerError(signal?.aborted ? "ABORTED" : "NETWORK");
  }
}

const NULL_BODY_STATUSES = [204, 205, 304];

function xhrResponse(xhr: XMLHttpRequest): Response {
  const headers = new Headers();
  for (const line of xhr.getAllResponseHeaders().split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const body = NULL_BODY_STATUSES.includes(xhr.status) ? null : xhr.responseText;
  return new Response(body, { status: xhr.status, headers });
}

/**
 * fetch reports no upload progress, so an upload goes through XMLHttpRequest
 * (side panel only; never called where it does not exist). It matches the
 * options fetch gets above:
 * - credentials "omit": withCredentials stays false, and the broker is always
 *   another origin than the extension page, so no cookies are sent.
 * - redirect "error": XHR follows redirects itself; a response from any other
 *   URL is rejected like fetch rejects a redirect. connect-src in the
 *   extension CSP blocks a redirect off the broker origin before it is sent.
 * - referrerPolicy "no-referrer": XHR cannot set it. The default policy sends
 *   another origin at most the extension origin, which Origin already carries.
 * - cache "no-store": a PATCH is never read from or stored in the HTTP cache.
 * Failures reject like fetch (AbortError on abort, TypeError otherwise).
 */
function sendWithProgress(
  url: string,
  init: UploadInit,
  signal?: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    // responseURL is the parsed, serialized URL; compare like with like.
    const requested = new URL(url).href;
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const fail = (error: Error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    };
    xhr.open(init.method, url);
    for (const [name, value] of Object.entries(init.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.addEventListener("progress", (event) => init.onUploadProgress(event.loaded));
    xhr.addEventListener("load", () => {
      signal?.removeEventListener("abort", abort);
      if (xhr.responseURL !== requested) reject(new TypeError("redirected"));
      else {
        try {
          resolve(xhrResponse(xhr));
        } catch (error) {
          reject(error);
        }
      }
    });
    xhr.addEventListener("abort", () => fail(new DOMException("aborted", "AbortError")));
    xhr.addEventListener("error", () => fail(new TypeError("network")));
    xhr.addEventListener("timeout", () => fail(new TypeError("timeout")));
    signal?.addEventListener("abort", abort, { once: true });
    xhr.send(init.body);
  });
}

export async function readJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_JSON_BYTES)
    throw new CaptionServerError("RESPONSE");
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new CaptionServerError("NETWORK");
  }
  if (text.length > MAX_JSON_BYTES) throw new CaptionServerError("RESPONSE");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CaptionServerError("RESPONSE");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CaptionServerError("RESPONSE");
  return value as Record<string, unknown>;
}

export async function serverErrorCode(response: Response): Promise<string> {
  try {
    const error = (await readJson(response)).error as
      | { code?: unknown }
      | undefined;
    return typeof error?.code === "string" ? error.code : "";
  } catch {
    return "";
  }
}

export async function errorFor(response: Response): Promise<CaptionServerError> {
  const code = await serverErrorCode(response);
  const retry = Number(response.headers.get("retry-after"));
  return new CaptionServerError(
    SERVER_CODES[code] ?? statusCode(response.status),
    Number.isSafeInteger(retry) && retry >= 0 ? retry : undefined,
  );
}
