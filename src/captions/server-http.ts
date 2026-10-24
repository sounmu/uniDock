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
  UPLOAD_NOT_ACCEPTING: "UPLOAD_CONFLICT",
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

export async function serverFetch(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const base = captionServerBase();
  try {
    return await fetch(`${base}${path}`, {
      ...init,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal,
    });
  } catch {
    throw new CaptionServerError(signal?.aborted ? "ABORTED" : "NETWORK");
  }
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
