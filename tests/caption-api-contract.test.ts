import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { parse } from "yaml";
import { Ajv2020 } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import {
  createJob,
  getAccount,
  getSessionCount,
  getJob,
  getTranscript,
  getWorkerStatus,
  parseJob,
  uploadAudio,
  UPLOAD_CHUNK_BYTES,
} from "../src/captions/job-client";
import { captionJobKey } from "../src/captions/job-record";
import { SERVER_CODES } from "../src/captions/server-http";
import { sessionFromResponse, signIn, signOutEverywhere } from "../src/caption-server-settings";
import {
  fixture,
  googleRedirect,
  json,
  mockServer,
  seedSession,
  stubCaptionChrome,
  type Call,
} from "./caption-server-helpers";

// The vendored contract (documentation/api/README.md). Fixtures and the requests
// the client sends must both satisfy it, so drift on either side fails here.
type Spec = {
  paths: Record<string, Record<string, { parameters?: { name: string; schema: object }[] }>>;
  components: {
    schemas: Record<string, { enum?: string[] }>;
    parameters: Record<string, { name: string; schema: object }>;
  };
};
const spec = parse(
  readFileSync(path.resolve(__dirname, "../documentation/api/public.openapi.yaml"), "utf8"),
) as Spec;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "spec", components: spec.components });

function expectValid(schema: string, value: unknown) {
  const validate = ajv.getSchema(`spec#/components/schemas/${schema}`);
  if (!validate) throw new Error(`no schema ${schema}`);
  const valid = validate(value);
  expect(valid ? [] : validate.errors).toEqual([]);
}

function expectParam(schema: object, value: string | number) {
  const validate = ajv.compile(schema);
  const valid = validate(value);
  expect(valid ? [] : validate.errors).toEqual([]);
}

function operation(call: Call) {
  const entry = Object.entries(spec.paths).find(([template]) =>
    new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(call.path),
  );
  const op = entry?.[1][call.method.toLowerCase()];
  expect(op, `${call.method} ${call.path} is not in the spec`).toBeDefined();
  return op!;
}

const responses: [string, string][] = [
  ["job-awaiting-upload.json", "Job"],
  ["job-queued.json", "Job"],
  ["job-running.json", "Job"],
  ["job-succeeded.json", "Job"],
  ["job-failed.json", "Job"],
  ["transcript.json", "TranscriptDocument"],
  ["me.json", "Me"],
  ["service-status.json", "ServiceStatus"],
  ["session.json", "SessionResponse"],
  ["session-list.json", "SessionList"],
  ["error-quota-exceeded.json", "ErrorResponse"],
  ["error-token-expired.json", "ErrorResponse"],
  ["error-upload-offset-mismatch.json", "ErrorResponse"],
  ["error-active-job-exists.json", "ErrorResponse"],
];

describe("fixtures satisfy the spec", () => {
  it.each(responses)("%s is a valid %s", (name, schema) => {
    expectValid(schema, fixture(name));
  });
});

describe("the client reads every spec-shaped response", () => {
  let store: Record<string, unknown>;
  beforeEach(() => {
    ({ store } = stubCaptionChrome());
    seedSession(store);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("parses each job state", () => {
    for (const name of responses.map(([n]) => n).filter((n) => n.startsWith("job-")))
      expect(parseJob(fixture(name)).state).toBe(fixture(name).state);
    expect(parseJob(fixture("job-running.json")).progress).toEqual({
      stage: "transcribing",
      done: 600,
      total: 3938,
    });
  });

  it("knows exactly the spec's job states and maps only spec error codes", () => {
    const states = spec.components.schemas.JobState!.enum!;
    for (const state of states)
      expect(parseJob({ ...fixture("job-queued.json"), state }).state).toBe(state);
    const errorCodes = (
      spec.components.schemas.ErrorResponse as unknown as {
        properties: { error: { properties: { code: { enum: string[] } } } };
      }
    ).properties.error.properties.code.enum;
    expect(Object.keys(SERVER_CODES).filter((code) => !errorCodes.includes(code))).toEqual([]);
  });

  it("reads the transcript, account, worker status and session", async () => {
    mockServer((call) =>
      call.path.startsWith("/v1/transcripts/")
        ? json(fixture("transcript.json"))
        : call.path === "/v1/me"
          ? json(fixture("me.json"))
          : json(fixture("service-status.json")),
    );
    const transcript = await getTranscript("t");
    expect(transcript.segments).toHaveLength(2);
    expect(transcript.expiresAt).toBe("2027-04-24T03:05:00Z");
    expect((await getAccount()).quota).toEqual({
      limit: 7,
      used: 2,
      reserved: 0,
      resetsAt: "2026-10-26T15:00:00Z",
    });
    expect(await getWorkerStatus()).toBe("offline");
    expect(sessionFromResponse(fixture("session.json")).email).toBe("student@example.com");
  });
});

describe("the client sends spec-shaped requests", () => {
  let store: Record<string, unknown>;
  let launchWebAuthFlow: ReturnType<typeof stubCaptionChrome>["launchWebAuthFlow"];
  beforeEach(() => {
    ({ store, launchWebAuthFlow } = stubCaptionChrome());
    seedSession(store);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("creates a job with a valid body and the per-lecture key", async () => {
    const calls = mockServer(() => json(fixture("job-awaiting-upload.json"), 201));
    const key = await captionJobKey("0123456789abc");
    await createJob(key, { durationHintS: 3938.4 });
    const call = calls[0]!;
    operation(call);
    expectValid("CreateJobRequest", JSON.parse(call.body as string));
    expectParam(spec.components.parameters.IdempotencyKey!.schema, call.headers["Idempotency-Key"]!);
  });

  it("uploads with tus headers inside the spec limits", async () => {
    const total = UPLOAD_CHUNK_BYTES + 5;
    let offset = 0;
    const calls = mockServer(async (call) => {
      if (call.method === "HEAD")
        return new Response(null, {
          status: 200,
          headers: { "Upload-Offset": String(offset), "Tus-Resumable": "1.0.0", "Upload-Defer-Length": "1" },
        });
      offset += (call.body as Blob).size;
      return new Response(null, {
        status: 204,
        headers: { "Upload-Offset": String(offset), "Tus-Resumable": "1.0.0" },
      });
    });
    await uploadAudio("job", new Blob([new Uint8Array(total)], { type: "audio/mp4" }));
    const patches = calls.filter((call) => call.method === "PATCH");
    expect(patches).toHaveLength(2);
    for (const call of calls) {
      const op = operation(call);
      for (const param of op.parameters ?? []) {
        const resolved =
          "$ref" in param
            ? spec.components.parameters[String((param as { $ref: string }).$ref).split("/").pop()!]!
            : param;
        const value = call.headers[resolved.name];
        if (value !== undefined)
          expectParam(resolved.schema, /^\d+$/.test(value) ? Number(value) : value);
      }
    }
    for (const call of patches) {
      expect(call.headers["Content-Type"]).toBe("application/offset+octet-stream");
      expect((call.body as Blob).size).toBeLessThanOrEqual(8388608);
    }
  });

  it("signs in with a valid GoogleAuthRequest", async () => {
    launchWebAuthFlow.mockImplementation(async ({ url }) => googleRedirect(url));
    const calls = mockServer(() => json(fixture("session.json")));
    await signIn();
    operation(calls[0]!);
    expectValid("GoogleAuthRequest", JSON.parse(calls[0]!.body as string));
  });

  it("lists and ends device sessions through spec operations", async () => {
    const calls = mockServer((call) =>
      call.method === "GET" ? json(fixture("session-list.json")) : new Response(null, { status: 204 }),
    );
    expect(await getSessionCount()).toBe(2);
    await signOutEverywhere();
    for (const call of calls) operation(call);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/me/sessions",
      "DELETE /v1/me/sessions",
      "POST /v1/auth/logout",
    ]);
  });

  it("refreshes with a valid RefreshRequest", async () => {
    seedSession(store, { accessExpiresAt: "2000-01-01T00:00:00Z" });
    const calls = mockServer((call) =>
      call.path === "/v1/auth/refresh"
        ? json(fixture("session.json"))
        : json(fixture("job-queued.json")),
    );
    await getJob("job");
    const refresh = calls.find((call) => call.path === "/v1/auth/refresh")!;
    operation(refresh);
    expectValid("RefreshRequest", JSON.parse(refresh.body as string));
  });
});
