import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createJob,
  getJob,
  getTranscript,
  JobError,
  uploadAudio,
} from "../src/captions/job-client";

function mockFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responses[index++] ?? new Response("{}", { status: 200 });
    }),
  );
  return calls;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: "tok3nvalue1234" })),
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("creates a job and sends auth + idempotency headers", async () => {
  const calls = mockFetch([json({ id: "job_123" })]);
  const id = await createJob("unidock-0123456789abc", { durationHintS: 3600 });
  expect(id).toBe("job_123");
  const headers = calls[0]!.init.headers as Record<string, string>;
  expect(headers.Authorization).toBe("Bearer tok3nvalue1234");
  expect(headers["Idempotency-Key"]).toBe("unidock-0123456789abc");
  expect(calls[0]!.url).toBe(
    "https://captions.test/v1/transcription-jobs",
  );
});

it("maps status fields and error codes", async () => {
  mockFetch([
    json({
      state: "running",
      progress: 0.5,
      expires_at: "2027-01-01T00:00:00Z",
    }),
  ]);
  const status = await getJob("job_123");
  expect(status.state).toBe("running");
  expect(status.progress).toBe(0.5);

  mockFetch([json({}, 401)]);
  await expect(getJob("job_123")).rejects.toMatchObject({ code: "AUTH" });
  mockFetch([json({}, 413)]);
  await expect(getJob("job_123")).rejects.toMatchObject({ code: "TOO_LARGE" });
  mockFetch([json({}, 429)]);
  await expect(getJob("job_123")).rejects.toMatchObject({
    code: "RATE_LIMITED",
  });
  mockFetch([json({}, 404)]);
  await expect(getJob("job_123")).rejects.toMatchObject({ code: "EXPIRED" });
});

it("validates the transcript schema", async () => {
  mockFetch([
    json({
      schema_version: 1,
      language: "ko",
      engine: "whisper",
      model_revision: "large-v3-turbo",
      segments: [{ start_ms: 0, end_ms: 1000, text: "a" }],
    }),
  ]);
  const transcript = await getTranscript("t_1");
  expect(transcript.segments).toHaveLength(1);
  expect(transcript.engine).toBe("whisper");

  mockFetch([json({ segments: [{ start_ms: 0, text: "missing end" }] })]);
  await expect(getTranscript("t_1")).rejects.toBeInstanceOf(JobError);
  mockFetch([json({ segments: "not-an-array" })]);
  await expect(getTranscript("t_1")).rejects.toMatchObject({ code: "RESPONSE" });
});

it("uploads audio with its content type", async () => {
  const calls = mockFetch([new Response("{}", { status: 200 })]);
  await uploadAudio("job_123", new Blob([new Uint8Array(8)], { type: "audio/mp4" }));
  const headers = calls[0]!.init.headers as Record<string, string>;
  expect(headers["Content-Type"]).toBe("audio/mp4");
  expect(calls[0]!.url).toBe(
    "https://captions.test/v1/transcription-jobs/job_123/audio",
  );
});
