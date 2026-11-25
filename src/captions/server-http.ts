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

/**
 * An upload that reports how many body bytes fetch has taken so far. The Blob
 * is the body of record: every attempt (a token retry included) builds its
 * own stream from it, since a consumed stream cannot be sent again.
 */
export interface UploadInit {
  method: string;
  headers: Record<string, string>;
  body: Blob;
  onUploadProgress: (sentBytes: number) => void;
}

export type ServerInit = RequestInit | UploadInit;

/** A stream body needs `duplex`, which the DOM typings do not declare yet. */
interface StreamingRequestInit extends RequestInit {
  duplex: "half";
}

const FETCH_OPTIONS = {
  credentials: "omit",
  redirect: "error",
  referrerPolicy: "no-referrer",
  cache: "no-store",
} as const satisfies RequestInit;

const UPLOAD_SLICE_BYTES = 64 * 1024;

/**
 * Chrome streams a request body only over HTTP/2 or later; over HTTP/1.1 it
 * rejects the fetch with a TypeError before sending it. After the first such
 * rejection, uploads from this document send plain Blob bodies.
 */
let streamingUploads = true;

const failure = (signal: AbortSignal | null | undefined) =>
  new CaptionServerError(signal?.aborted ? "ABORTED" : "NETWORK");

/** Reads the Blob one slice at a time as fetch pulls it, reporting the running total. */
function progressBody(
  blob: Blob,
  onProgress: (sentBytes: number) => void,
): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (sent >= blob.size) {
          controller.close();
          return;
        }
        const slice = new Uint8Array(
          await blob.slice(sent, sent + UPLOAD_SLICE_BYTES).arrayBuffer(),
        );
        sent += slice.byteLength;
        controller.enqueue(slice);
        onProgress(sent);
      },
    },
    { highWaterMark: 0 },
  );
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw failure(init.signal);
  }
}

export async function serverFetch(
  path: string,
  init: ServerInit,
  signal?: AbortSignal,
): Promise<Response> {
  const url = `${captionServerBase()}${path}`;
  if (!("onUploadProgress" in init)) return send(url, { ...init, ...FETCH_OPTIONS, signal });
  const { onUploadProgress, ...upload } = init;
  if (streamingUploads) {
    const streamed: StreamingRequestInit = {
      ...upload,
      ...FETCH_OPTIONS,
      signal,
      body: progressBody(upload.body, onUploadProgress),
      duplex: "half",
    };
    try {
      return await fetch(url, streamed);
    } catch (error) {
      if (signal?.aborted || !(error instanceof TypeError)) throw failure(signal);
      // Resending once with the Blob is safe. The broker reads the whole body
      // before its transaction, so an attempt rejected before the body was
      // sent stored nothing; if the broker did commit and only the answer was
      // lost, the resend meets an offset mismatch and uploadAudio resyncs.
      streamingUploads = false;
    }
  }
  return send(url, { ...upload, ...FETCH_OPTIONS, signal });
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
