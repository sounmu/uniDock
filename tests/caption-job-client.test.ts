import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createJob,
  getJob,
  JobError,
  uploadAudio,
  UPLOAD_CHUNK_BYTES,
} from "../src/captions/job-client";
import { CAPTION_SESSION_KEY } from "../src/caption-server-settings";
import { fixture, json, mockServer, seedSession, stubCaptionChrome } from "./caption-server-helpers";

let store: Record<string, unknown>;
beforeEach(() => {
  ({ store } = stubCaptionChrome());
  seedSession(store);
});
afterEach(() => vi.unstubAllGlobals());

const headResponse = (offset: number, length?: number) =>
  new Response(null, {
    status: 200,
    headers: {
      "Upload-Offset": String(offset),
      "Tus-Resumable": "1.0.0",
      ...(length ? { "Upload-Length": String(length) } : { "Upload-Defer-Length": "1" }),
    },
  });
const patched = (offset: number) =>
  new Response(null, { status: 204, headers: { "Upload-Offset": String(offset) } });

it("sends the session bearer and returns the job from create", async () => {
  const calls = mockServer(() => json(fixture("job-awaiting-upload.json"), 201));
  const job = await createJob("unidock-0123456789abcdef0123456789abcdef01234567");
  expect(job.state).toBe("awaiting_upload");
  expect(calls[0]!.headers.Authorization).toBe(`Bearer at_seed_${"s".repeat(40)}`);
  expect(calls[0]!.url).toBe("https://captions.test/v1/transcription-jobs");
});

it("asks for login without any request when there is no session", async () => {
  delete store[CAPTION_SESSION_KEY];
  const calls = mockServer(() => json({}));
  await expect(getJob("j")).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
  expect(calls).toHaveLength(0);
});

it("maps the spec's error codes, not just HTTP status", async () => {
  mockServer(() => json(fixture("error-quota-exceeded.json"), 429, { "Retry-After": "172800" }));
  await expect(createJob("unidock-key-0000000000")).rejects.toMatchObject({
    code: "QUOTA_EXCEEDED",
    retryAfterS: 172800,
  });
  mockServer(() => json({ error: { code: "RATE_LIMITED" } }, 429));
  await expect(getJob("j")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  mockServer(() => json(fixture("error-active-job-exists.json"), 409));
  await expect(createJob("unidock-key-0000000000")).rejects.toMatchObject({
    code: "ACTIVE_JOB_EXISTS",
  });
  mockServer(() => json({ error: { code: "NOT_FOUND" } }, 404));
  await expect(getJob("j")).rejects.toMatchObject({ code: "EXPIRED" });
  mockServer(() => new Response("bad gateway", { status: 502 }));
  await expect(getJob("j")).rejects.toMatchObject({ code: "SERVER" });
  mockServer(() => json({ state: "nonsense", id: "j" }));
  await expect(getJob("j")).rejects.toBeInstanceOf(JobError);
});

it("refreshes an expired access token once and retries the request", async () => {
  const calls = mockServer((call) => {
    if (call.path === "/v1/auth/refresh") return json(fixture("session.json"));
    return call.headers.Authorization === `Bearer at_seed_${"s".repeat(40)}`
      ? json(fixture("error-token-expired.json"), 401)
      : json(fixture("job-queued.json"));
  });
  expect((await getJob("j")).state).toBe("queued");
  expect(calls.map((call) => call.path)).toEqual([
    "/v1/transcription-jobs/j",
    "/v1/auth/refresh",
    "/v1/transcription-jobs/j",
  ]);
  expect((store[CAPTION_SESSION_KEY] as { accessToken: string }).accessToken).toBe(
    fixture("session.json").access_token,
  );
});

it("refreshes once for concurrent requests with an expired token", async () => {
  seedSession(store, { accessExpiresAt: "2000-01-01T00:00:00Z" });
  const calls = mockServer((call) =>
    call.path === "/v1/auth/refresh" ? json(fixture("session.json")) : json(fixture("job-queued.json")),
  );
  await Promise.all([getJob("a"), getJob("b"), getJob("c")]);
  expect(calls.filter((call) => call.path === "/v1/auth/refresh")).toHaveLength(1);
});

it("forgets a session the broker rejects", async () => {
  seedSession(store, { accessExpiresAt: "2000-01-01T00:00:00Z" });
  mockServer(() => json({ error: { code: "REFRESH_REUSED" } }, 401));
  await expect(getJob("j")).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
  expect(store[CAPTION_SESSION_KEY]).toBeUndefined();
});

it("resumes a tus upload from the server offset in 8 MiB chunks", async () => {
  const total = UPLOAD_CHUNK_BYTES * 2 + 3;
  const start = UPLOAD_CHUNK_BYTES;
  let offset = start;
  const progress: number[] = [];
  const calls = mockServer((call) => {
    if (call.method === "HEAD") return headResponse(offset, total);
    expect(call.headers["Upload-Offset"]).toBe(String(offset));
    offset += (call.body as Blob).size;
    return patched(offset);
  });
  await uploadAudio("j", new Blob([new Uint8Array(total)]), undefined, (bytes) =>
    progress.push(bytes),
  );
  expect(calls.map((call) => call.method)).toEqual(["HEAD", "PATCH", "PATCH"]);
  expect(calls.slice(1).every((call) => call.headers["Upload-Length"] === String(total))).toBe(true);
  expect(progress).toEqual([UPLOAD_CHUNK_BYTES * 2, total]);
});

it("re-reads the offset after a mismatch instead of restarting", async () => {
  let offset = 0;
  let mismatched = false;
  const calls = mockServer((call) => {
    if (call.method === "HEAD") return headResponse(offset);
    if (!mismatched) {
      mismatched = true;
      offset = 2;
      return json(fixture("error-upload-offset-mismatch.json"), 409);
    }
    offset += (call.body as Blob).size;
    return patched(offset);
  });
  await uploadAudio("j", new Blob([new Uint8Array(10)]));
  expect(calls.map((call) => `${call.method}:${call.headers["Upload-Offset"] ?? ""}`)).toEqual([
    "HEAD:",
    "PATCH:0",
    "HEAD:",
    "PATCH:2",
  ]);
});

it("refuses an upload whose declared length differs or whose offset goes backwards", async () => {
  mockServer(() => headResponse(0, 99));
  await expect(uploadAudio("j", new Blob([new Uint8Array(10)]))).rejects.toMatchObject({
    code: "UPLOAD_CONFLICT",
  });
  mockServer((call) => (call.method === "HEAD" ? headResponse(4) : patched(4)));
  await expect(uploadAudio("j", new Blob([new Uint8Array(10)]))).rejects.toMatchObject({
    code: "RESPONSE",
  });
  await expect(uploadAudio("j", new Blob([]))).rejects.toMatchObject({ code: "TOO_LARGE" });
});
