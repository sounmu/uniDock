import { captionServerToken } from "../caption-server-settings";

export type JobErrorCode =
  | "NO_SERVER"
  | "NO_TOKEN"
  | "AUTH"
  | "TOO_LARGE"
  | "RATE_LIMITED"
  | "NETWORK"
  | "SERVER"
  | "RESPONSE"
  | "EXPIRED"
  | "ABORTED";

export class JobError extends Error {
  constructor(readonly code: JobErrorCode) {
    super(code);
  }
}

export interface JobStatus {
  state: string;
  errorCode?: string;
  progress?: number;
  transcriptId?: string;
  expiresAt: string;
}

export interface ServerSegment {
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface ServerTranscript {
  schemaVersion: number;
  language: string;
  engine: string;
  modelRevision: string;
  pipelineVersion: string;
  createdAt: string;
  expiresAt: string;
  segments: ServerSegment[];
}

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SEGMENTS = 100000;

function base(): string {
  if (!__UNIDOCK_CAPTION_SERVER__) throw new JobError("NO_SERVER");
  return __UNIDOCK_CAPTION_SERVER__;
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await captionServerToken();
  if (!token) throw new JobError("NO_TOKEN");
  return { Authorization: `Bearer ${token}` };
}

function mapStatus(status: number): JobErrorCode {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 404 || status === 410) return "EXPIRED";
  if (status === 413) return "TOO_LARGE";
  if (status === 429) return "RATE_LIMITED";
  return "SERVER";
}

async function send(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${base()}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(await authHeader()) },
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (error instanceof JobError) throw error;
    throw new JobError(signal?.aborted ? "ABORTED" : "NETWORK");
  }
  if (!response.ok) throw new JobError(mapStatus(response.status));
  return response;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_JSON_BYTES)
    throw new JobError("RESPONSE");
  const text = await response.text();
  if (text.length > MAX_JSON_BYTES) throw new JobError("RESPONSE");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new JobError("RESPONSE");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new JobError("RESPONSE");
  return value as Record<string, unknown>;
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export async function createJob(
  idempotencyKey: string,
  hint: { durationHintS?: number } = {},
  signal?: AbortSignal,
): Promise<string> {
  const response = await send(
    "/v1/transcription-jobs",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(
        hint.durationHintS ? { duration_hint_s: hint.durationHintS } : {},
      ),
    },
    signal,
  );
  const id = str((await readJson(response)).id);
  if (!/^[\w-]{1,128}$/.test(id)) throw new JobError("RESPONSE");
  return id;
}

export async function uploadAudio(
  id: string,
  audio: Blob,
  signal?: AbortSignal,
): Promise<void> {
  await send(
    `/v1/transcription-jobs/${encodeURIComponent(id)}/audio`,
    { method: "POST", headers: { "Content-Type": audio.type || "audio/mp4" }, body: audio },
    signal,
  );
}

export async function getJob(id: string, signal?: AbortSignal): Promise<JobStatus> {
  const body = await readJson(
    await send(`/v1/transcription-jobs/${encodeURIComponent(id)}`, { method: "GET" }, signal),
  );
  const state = str(body.state);
  if (!state) throw new JobError("RESPONSE");
  return {
    state,
    errorCode: str(body.error_code) || undefined,
    progress: num(body.progress),
    transcriptId: str(body.transcript_id) || undefined,
    expiresAt: str(body.expires_at),
  };
}

export async function cancelJob(id: string, signal?: AbortSignal): Promise<void> {
  await send(
    `/v1/transcription-jobs/${encodeURIComponent(id)}/cancel`,
    { method: "POST" },
    signal,
  );
}

export async function getTranscript(
  id: string,
  signal?: AbortSignal,
): Promise<ServerTranscript> {
  const body = await readJson(
    await send(`/v1/transcripts/${encodeURIComponent(id)}`, { method: "GET" }, signal),
  );
  const rawSegments = body.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length > MAX_SEGMENTS)
    throw new JobError("RESPONSE");
  const segments: ServerSegment[] = [];
  for (const row of rawSegments) {
    if (!row || typeof row !== "object") throw new JobError("RESPONSE");
    const r = row as Record<string, unknown>;
    const start = num(r.start_ms);
    const end = num(r.end_ms);
    const text = r.text;
    if (start === undefined || end === undefined || typeof text !== "string")
      throw new JobError("RESPONSE");
    segments.push({ start_ms: start, end_ms: end, text });
  }
  return {
    schemaVersion: num(body.schema_version) ?? 0,
    language: str(body.language),
    engine: str(body.engine),
    modelRevision: str(body.model_revision),
    pipelineVersion: str(body.pipeline_version),
    createdAt: str(body.created_at),
    expiresAt: str(body.expires_at),
    segments,
  };
}

export async function deleteTranscript(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  await send(`/v1/transcripts/${encodeURIComponent(id)}`, { method: "DELETE" }, signal);
}
