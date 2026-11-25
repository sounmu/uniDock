import { authorizedFetch } from "../caption-server-settings";
import { CaptionServerError, errorFor, readJson, serverErrorCode } from "./server-http";

export { CaptionServerError as JobError } from "./server-http";
export type { CaptionServerErrorCode as JobErrorCode } from "./server-http";

export type JobState =
  | "awaiting_upload"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
const JOB_STATES: readonly JobState[] = [
  "awaiting_upload",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];

export interface JobProgress {
  stage: "uploading" | "waiting" | "transcribing";
  done?: number;
  total?: number;
}

export interface JobStatus {
  id: string;
  state: JobState;
  errorCode?: string;
  cancelRequested: boolean;
  progress?: JobProgress;
  transcriptId?: string;
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
  durationMs: number;
  segments: ServerSegment[];
}

export interface CaptionAccount {
  email: string;
  quota: { limit: number; used: number; reserved: number; resetsAt: string };
}

export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const MAX_SEGMENTS = 20000;
const MAX_OFFSET_RESYNCS = 3;
const MAX_CHUNKS_IN_FLIGHT = 2;
const TUS = "1.0.0";

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const count = (value: unknown): number | undefined => {
  const n = num(value);
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};
const opaqueId = (value: unknown): string => {
  const id = str(value);
  if (!/^[\w-]{1,128}$/.test(id)) throw new CaptionServerError("RESPONSE");
  return id;
};

async function ok(response: Response): Promise<Response> {
  if (!response.ok) throw await errorFor(response);
  return response;
}

const jobPath = (id: string) => `/v1/transcription-jobs/${encodeURIComponent(id)}`;

function parseProgress(value: unknown): JobProgress | undefined {
  const p = value as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return undefined;
  const stage = p.stage;
  if (stage !== "uploading" && stage !== "waiting" && stage !== "transcribing")
    return undefined;
  return { stage, done: count(p.done), total: count(p.total) };
}

export function parseJob(body: Record<string, unknown>): JobStatus {
  const state = body.state as JobState;
  if (!JOB_STATES.includes(state)) throw new CaptionServerError("RESPONSE");
  const transcriptId = body.transcript_id === undefined ? undefined : opaqueId(body.transcript_id);
  return {
    id: opaqueId(body.id),
    state,
    errorCode: str(body.error_code) || undefined,
    cancelRequested: body.cancel_requested === true,
    progress: parseProgress(body.progress),
    transcriptId,
  };
}

export async function createJob(
  idempotencyKey: string,
  hint: { durationHintS?: number } = {},
  signal?: AbortSignal,
): Promise<JobStatus> {
  const duration = hint.durationHintS && Math.round(hint.durationHintS);
  const response = await authorizedFetch(
    "/v1/transcription-jobs",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        audio_format: "audio/mp4",
        language: "ko",
        ...(duration && duration >= 1 && duration <= 14400
          ? { duration_hint_s: duration }
          : {}),
      }),
    },
    signal,
  );
  return parseJob(await readJson(await ok(response)));
}

export async function getJob(id: string, signal?: AbortSignal): Promise<JobStatus> {
  const response = await authorizedFetch(jobPath(id), { method: "GET" }, signal);
  return parseJob(await readJson(await ok(response)));
}

export async function cancelJob(id: string, signal?: AbortSignal): Promise<void> {
  await ok(await authorizedFetch(`${jobPath(id)}/cancel`, { method: "POST" }, signal));
}

function headerCount(response: Response, name: string): number | undefined {
  const value = response.headers.get(name);
  return value !== null && /^\d{1,12}$/.test(value) ? Number(value) : undefined;
}

async function uploadOffset(id: string, total: number, signal?: AbortSignal) {
  const response = await ok(
    await authorizedFetch(
      `${jobPath(id)}/audio`,
      { method: "HEAD", headers: { "Tus-Resumable": TUS } },
      signal,
    ),
  );
  const offset = headerCount(response, "Upload-Offset");
  const declared = headerCount(response, "Upload-Length");
  if (offset === undefined) throw new CaptionServerError("RESPONSE");
  // Bytes or a length recorded for different audio: the panel recovers by
  // cancelling this job and uploading into a fresh one.
  if (offset > total || (declared !== undefined && declared !== total))
    throw new CaptionServerError("UPLOAD_CONFLICT");
  return offset;
}

interface Chunk {
  end: number;
  length: number;
  /** Body bytes sent so far by the current attempt. */
  sent: number;
  /** Sent while the chunk before it was still unanswered. */
  ahead: boolean;
  settled: boolean;
  response: Promise<Response>;
}

/** One round of an upload: where chunks go and who hears of sent bytes. */
interface ChunkTarget {
  id: string;
  audio: Blob;
  signal: AbortSignal;
  onSent: () => void;
}

function sendChunk(target: ChunkTarget, start: number, ahead: boolean): Chunk {
  const total = target.audio.size;
  const end = Math.min(start + UPLOAD_CHUNK_BYTES, total);
  const chunk: Chunk = {
    end,
    length: end - start,
    sent: 0,
    ahead,
    settled: false,
    response: authorizedFetch(
      `${jobPath(target.id)}/audio`,
      {
        method: "PATCH",
        headers: {
          "Tus-Resumable": TUS,
          "Content-Type": "application/offset+octet-stream",
          "Upload-Offset": String(start),
          "Upload-Length": String(total),
        },
        body: target.audio.slice(start, end),
        // A retried attempt (refreshed token) starts again from zero.
        onUploadProgress: (sent) => {
          chunk.sent = Math.min(sent, chunk.length);
          target.onSent();
        },
      },
      target.signal,
    ),
  };
  // Awaited in order, possibly after it already failed; an early rejection is
  // not an unhandled one.
  const settle = () => {
    chunk.settled = true;
  };
  chunk.response.then(settle, settle);
  return chunk;
}

const offsetMismatch = async (response: Response) =>
  response.status === 409 &&
  (await serverErrorCode(response.clone())) === "UPLOAD_OFFSET_MISMATCH";

/**
 * tus core upload: resume from the server's offset, send 8 MiB chunks, and
 * declare the total size on every PATCH (the first one sets it). Two chunks
 * stay in flight: each accepted answer sends the next chunk right away. A
 * broker that answers such an ahead chunk with an offset mismatch gets one
 * chunk at a time for the rest of the upload. A mismatch on the oldest chunk re-reads the
 * offset a few times instead of restarting. Whatever is cancelled mid-flight
 * is never assumed stored: the upload resumes from a HEAD offset.
 *
 * `onProgress` gets the committed offset plus the bytes sent of the chunks in
 * flight that continue it without a gap. It never goes down (a resync or a
 * retried chunk keeps the highest value) and ends at the total.
 */
export async function uploadAudio(
  id: string,
  audio: Blob,
  signal?: AbortSignal,
  onProgress?: (uploadedBytes: number) => void,
): Promise<void> {
  const total = audio.size;
  if (total < 1 || total > MAX_AUDIO_BYTES) throw new CaptionServerError("TOO_LARGE");
  let offset = await uploadOffset(id, total, signal);
  let resyncs = 0;
  let window = MAX_CHUNKS_IN_FLIGHT;
  let reported = 0;
  const report = (bytes: number) => {
    if (bytes <= reported) return;
    reported = bytes;
    onProgress?.(bytes);
  };
  while (offset < total) {
    const inFlight = new AbortController();
    const cancel = () => inFlight.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) inFlight.abort();
    const chunks: Chunk[] = [];
    const target: ChunkTarget = {
      id,
      audio,
      signal: inFlight.signal,
      onSent: () => {
        let bytes = offset;
        for (const chunk of chunks) {
          bytes += chunk.sent;
          if (chunk.sent < chunk.length) break;
        }
        report(bytes);
      },
    };
    let sent = offset;
    const fill = () => {
      while (chunks.length < window && sent < total) {
        const chunk = sendChunk(target, sent, chunks.length > 0);
        chunks.push(chunk);
        sent = chunk.end;
      }
    };
    let resync = false;
    try {
      fill();
      for (let chunk = chunks[0]; chunk; chunk = chunks[0]) {
        const response = await chunk.response;
        if (await offsetMismatch(response)) {
          // The chunk before this one was committed, so the broker refused
          // only the overlap: it does not wait for an ahead chunk.
          if (chunk.ahead) {
            window = 1;
            resync = true;
            break;
          }
          if (resyncs < MAX_OFFSET_RESYNCS) {
            resyncs++;
            resync = true;
            break;
          }
        }
        await ok(response);
        const next = headerCount(response, "Upload-Offset");
        if (next === undefined || next <= offset || next > total)
          throw new CaptionServerError("RESPONSE");
        offset = next;
        chunks.shift();
        report(offset);
        // A short commit leaves any chunk still in flight at the wrong offset.
        if (next !== chunk.end) {
          resync = chunks.length > 0;
          break;
        }
        // An answer already in is read first: a refused ahead chunk must not
        // be followed by another.
        if (!chunks[0]?.settled) fill();
      }
    } finally {
      inFlight.abort();
      signal?.removeEventListener("abort", cancel);
      await Promise.allSettled(chunks.map((chunk) => chunk.response));
    }
    if (resync) offset = await uploadOffset(id, total, signal);
  }
}

export async function getTranscript(
  id: string,
  signal?: AbortSignal,
): Promise<ServerTranscript> {
  const response = await authorizedFetch(
    `/v1/transcripts/${encodeURIComponent(id)}`,
    { method: "GET" },
    signal,
  );
  const body = await readJson(await ok(response));
  if (body.schema_version !== 1) throw new CaptionServerError("RESPONSE");
  const rawSegments = body.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length > MAX_SEGMENTS)
    throw new CaptionServerError("RESPONSE");
  const segments: ServerSegment[] = [];
  for (const row of rawSegments) {
    if (!row || typeof row !== "object") throw new CaptionServerError("RESPONSE");
    const r = row as Record<string, unknown>;
    const start = num(r.start_ms);
    const end = num(r.end_ms);
    const text = r.text;
    if (start === undefined || end === undefined || typeof text !== "string")
      throw new CaptionServerError("RESPONSE");
    segments.push({ start_ms: start, end_ms: end, text });
  }
  return {
    schemaVersion: body.schema_version,
    language: str(body.language),
    engine: str(body.engine),
    modelRevision: str(body.model_revision),
    pipelineVersion: str(body.pipeline_version),
    createdAt: str(body.created_at),
    expiresAt: str(body.expires_at),
    durationMs: num(body.duration_ms) ?? 0,
    segments,
  };
}

export async function deleteTranscript(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  await ok(
    await authorizedFetch(
      `/v1/transcripts/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      signal,
    ),
  );
}

export async function getAccount(signal?: AbortSignal): Promise<CaptionAccount> {
  const body = await readJson(
    await ok(await authorizedFetch("/v1/me", { method: "GET" }, signal)),
  );
  const quota = body.quota as Record<string, unknown> | undefined;
  const limit = count(quota?.limit);
  const used = count(quota?.used);
  const reserved = count(quota?.reserved);
  const resetsAt = str(quota?.resets_at);
  if (
    limit === undefined ||
    used === undefined ||
    reserved === undefined ||
    !Number.isFinite(Date.parse(resetsAt))
  )
    throw new CaptionServerError("RESPONSE");
  return { email: str(body.email), quota: { limit, used, reserved, resetsAt } };
}

export async function getSessionCount(signal?: AbortSignal): Promise<number> {
  const body = await readJson(
    await ok(await authorizedFetch("/v1/me/sessions", { method: "GET" }, signal)),
  );
  if (!Array.isArray(body.items)) throw new CaptionServerError("RESPONSE");
  return body.items.length;
}

export async function getWorkerStatus(
  signal?: AbortSignal,
): Promise<"online" | "offline"> {
  const body = await readJson(
    await ok(await authorizedFetch("/v1/service-status", { method: "GET" }, signal)),
  );
  if (body.worker !== "online" && body.worker !== "offline")
    throw new CaptionServerError("RESPONSE");
  return body.worker;
}
