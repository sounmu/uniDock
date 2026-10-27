import { afterEach, expect, it, vi } from "vitest";
import { mediaRangeReader } from "../src/captions/media-fetch";
import type { ByteRange } from "../src/captions/mp4-audio";

const url =
  "https://korea-cms-object.cdn.gov-ntruss.com/contents7/kruniv1001/0123456789abc/contents/media_files/screen.mp4";

function respond(
  status: number,
  body: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>,
) {
  return new Response(body, { status, headers });
}

afterEach(() => vi.unstubAllGlobals());

it("reads the total size and an exact 206 range with Range set", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(respond(206, new Uint8Array([1]), { "content-range": "bytes 0-0/1000" }))
    .mockResolvedValueOnce(
      respond(206, new Uint8Array([5, 6, 7]), { "content-range": "bytes 10-12/1000" }),
    );
  vi.stubGlobal("fetch", fetchMock);
  const reader = mediaRangeReader(url, new AbortController().signal);
  expect(await reader.totalSize()).toBe(1000);
  expect([...new Uint8Array(await reader.fetchRange(10, 12))]).toEqual([5, 6, 7]);
  expect(fetchMock.mock.calls[1]![1].headers).toEqual({ Range: "bytes=10-12" });
});

it("aborts a 200 that ignored Range before reading the body", async () => {
  let aborted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      init.signal!.addEventListener("abort", () => (aborted = true));
      return respond(200, new Uint8Array(64), {});
    }),
  );
  const reader = mediaRangeReader(url, new AbortController().signal);
  await expect(reader.fetchRange(0, 15)).rejects.toMatchObject({
    code: "UNSUPPORTED_MEDIA",
  });
  expect(aborted).toBe(true);
});

it("rejects a 206 whose Content-Range does not match the request", async () => {
  for (const range of ["bytes 0-99/1000", "bytes 10-12/2000", "bytes 10-12/*", ""]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(206, new Uint8Array(3), { "content-range": range })),
    );
    const reader = mediaRangeReader(url, new AbortController().signal);
    if (range.endsWith("/2000")) {
      vi.mocked(fetch).mockResolvedValueOnce(
        respond(206, new Uint8Array(1), { "content-range": "bytes 0-0/1000" }),
      );
      await reader.totalSize();
    }
    await expect(reader.fetchRange(10, 12)).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
    });
  }
});

it("rejects a body longer or shorter than the requested range", async () => {
  for (const size of [2, 4096]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        respond(206, new Uint8Array(size), { "content-range": "bytes 10-12/1000" }),
      ),
    );
    const reader = mediaRangeReader(url, new AbortController().signal);
    await expect(reader.fetchRange(10, 12)).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
    });
  }
});

it("rejects a 200 even when its Content-Range and length match the request", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      respond(200, new Uint8Array(3), { "content-range": "bytes 10-12/1000" }),
    ),
  );
  const reader = mediaRangeReader(url, new AbortController().signal);
  await expect(reader.fetchRange(10, 12)).rejects.toMatchObject({
    code: "UNSUPPORTED_MEDIA",
  });
});

it("rejects a 206 whose range starts elsewhere but ends where requested", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      respond(206, new Uint8Array(3), { "content-range": "bytes 9-12/1000" }),
    ),
  );
  const reader = mediaRangeReader(url, new AbortController().signal);
  await expect(reader.fetchRange(10, 12)).rejects.toMatchObject({
    code: "UNSUPPORTED_MEDIA",
  });
});

it("reports a CDN 403 as MEDIA_DENIED, not as a file without audio", async () => {
  for (const status of [401, 403]) {
    vi.stubGlobal("fetch", vi.fn(async () => respond(status, new Uint8Array(0), {})));
    const reader = mediaRangeReader(url, new AbortController().signal);
    await expect(reader.totalSize()).rejects.toMatchObject({ code: "MEDIA_DENIED" });
    await expect(reader.fetchRange(10, 12)).rejects.toMatchObject({ code: "MEDIA_DENIED" });
  }
});

it("reports a failed CDN request as MEDIA_NETWORK, or ABORTED once cancelled", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  const reader = mediaRangeReader(url, new AbortController().signal);
  await expect(reader.totalSize()).rejects.toMatchObject({ code: "MEDIA_NETWORK" });
  const controller = new AbortController();
  controller.abort();
  const cancelled = mediaRangeReader(url, controller.signal);
  await expect(cancelled.fetchRange(0, 7)).rejects.toMatchObject({ code: "ABORTED" });
});

it("forwards extraction cancellation without cancelling the parent reader", async () => {
  const parent = new AbortController();
  const extraction = new AbortController();
  const started = Promise.withResolvers<void>();
  let aborted = false;
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
      started.resolve();
    }),
  ));
  const reader = mediaRangeReader(url, parent.signal);
  const pending = reader.fetchRange(10, 12, extraction.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  await started.promise;
  extraction.abort();
  await rejected;
  expect(aborted).toBe(true);
  expect(parent.signal.aborted).toBe(false);
});

const pair = [{ start: 10, end: 13 }, { start: 20, end: 22 }];
const encode = (value: string) => new TextEncoder().encode(value);

function multipart(
  parts: readonly { range: string; body: Uint8Array<ArrayBuffer>; extra?: string }[],
  boundary = "audio-boundary",
  closing = `\r\n--${boundary}--\r\n`,
) {
  const chunks = parts.flatMap((part, index) => [
    encode(`${index ? "\r\n" : ""}--${boundary}\r\nContent-Type: audio/mp4\r\nContent-Range: ${part.range}\r\n${part.extra ?? ""}\r\n`),
    part.body,
  ]);
  chunks.push(encode(closing));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function preparedReader(
  response: Response,
  total = 1000,
) {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    respond(206, new Uint8Array([0]), { "content-range": `bytes 0-0/${total}` }),
  ).mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  const reader = mediaRangeReader(url, new AbortController().signal);
  await reader.totalSize();
  return { reader, fetchMock };
}

it.each(["audio-boundary", '"audio-boundary"'])(
  "preserves binary bytes and requested order for boundary %s",
  async (boundary) => {
    const bytes = multipart([
      { range: "bytes 20-21/1000", body: new Uint8Array([255, 0]) },
      { range: "bytes 10-12/1000", body: new Uint8Array([13, 10, 128]) },
    ]);
    let offset = 0;
    const response = new Response(new ReadableStream({
      pull(controller) {
        // Every delimiter and header can straddle transport chunks.
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(offset, ++offset));
      },
    }), { status: 206, headers: { "content-type": `multipart/byteranges; boundary=${boundary}` } });
    const { reader, fetchMock } = await preparedReader(response);
    const bodies = await reader.fetchRanges(pair);
    expect(bodies.map((body) => [...new Uint8Array(body)])).toEqual([[13, 10, 128], [255, 0]]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: { Range: "bytes=10-12,20-21" },
      credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
    });
  },
);

it("does not interpret boundary-like audio bytes as delimiters", async () => {
  const audio = encode("\0\r\n--audio-boundary\r\nContent-Range: bytes 1-2/1000\r\n\r\n");
  const ranges = [{ start: 0, end: audio.length }, { start: 200, end: 201 }];
  const { reader } = await preparedReader(respond(206, multipart([
    { range: `bytes 0-${audio.length - 1}/1000`, body: audio },
    { range: "bytes 200-200/1000", body: new Uint8Array([42]) },
  ]), { "content-type": "multipart/byteranges; boundary=audio-boundary" }));
  const bodies = await reader.fetchRanges(ranges);
  expect(new Uint8Array(bodies[0] ?? new ArrayBuffer(0))).toEqual(audio);
});

it("accepts the CDN's leading CRLF without accepting arbitrary preamble", async () => {
  const body = multipart([
    { range: "bytes 10-12/1000", body: new Uint8Array([1, 2, 3]) },
    { range: "bytes 20-21/1000", body: new Uint8Array([4, 5]) },
  ]);
  for (const prefix of ["\r\n", "junk\r\n"]) {
    const bytes = new Uint8Array(prefix.length + body.length);
    bytes.set(encode(prefix));
    bytes.set(body, prefix.length);
    const { reader } = await preparedReader(respond(206, bytes, {
      "content-type": "multipart/byteranges; boundary=audio-boundary",
    }));
    if (prefix === "\r\n")
      expect((await reader.fetchRanges(pair)).map((b) => [...new Uint8Array(b)]))
        .toEqual([[1, 2, 3], [4, 5]]);
    else
      await expect(reader.fetchRanges(pair)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
  }
});

it("requires known size and delegates a single range to the existing request", async () => {
  const unknown = mediaRangeReader(url, new AbortController().signal);
  await expect(unknown.fetchRanges(pair)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
  const { reader, fetchMock } = await preparedReader(
    respond(206, new Uint8Array([1, 2, 3]), { "content-range": "bytes 10-12/1000" }),
  );
  expect(await reader.fetchRanges([])).toEqual([]);
  expect(new Uint8Array((await reader.fetchRanges([pair[0]!]))[0]!)).toEqual(new Uint8Array([1, 2, 3]));
  expect(fetchMock.mock.calls[1]?.[1].headers).toEqual({ Range: "bytes=10-12" });
});

it.each([
  { name: "too many ranges", ranges: Array.from({ length: 65 }, (_, i) => ({ start: i * 2, end: i * 2 + 1 })), code: "TOO_LARGE" },
  { name: "too much payload", ranges: [{ start: 0, end: 1024 * 1024 + 1 }], code: "TOO_LARGE" },
  { name: "overlap", ranges: [{ start: 1, end: 4 }, { start: 3, end: 5 }], code: "UNSUPPORTED_MEDIA" },
  { name: "duplicate", ranges: [pair[0]!, pair[0]!], code: "UNSUPPORTED_MEDIA" },
  { name: "empty range", ranges: [{ start: 1, end: 1 }], code: "UNSUPPORTED_MEDIA" },
  { name: "negative offset", ranges: [{ start: -1, end: 1 }], code: "UNSUPPORTED_MEDIA" },
  { name: "unsafe offset", ranges: [{ start: 0, end: Infinity }], code: "UNSUPPORTED_MEDIA" },
  { name: "fractional offset", ranges: [{ start: 0.5, end: 1 }], code: "UNSUPPORTED_MEDIA" },
  { name: "past total", ranges: [{ start: 2000000, end: 2000001 }], code: "UNSUPPORTED_MEDIA" },
])("rejects $name before fetching", async ({ ranges, code }) => {
  const { reader, fetchMock } = await preparedReader(new Response(), 2000000);
  await expect(reader.fetchRanges(ranges)).rejects.toMatchObject({ code });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([
  { name: "duplicate part", parts: ["bytes 10-12/1000", "bytes 10-12/1000"] },
  { name: "unrequested part", parts: ["bytes 11-13/1000", "bytes 20-21/1000"] },
  { name: "overlapping part", parts: ["bytes 10-12/1000", "bytes 12-13/1000"] },
  { name: "wrong total", parts: ["bytes 10-12/1001", "bytes 20-21/1000"] },
  { name: "missing part", parts: ["bytes 10-12/1000"] },
  { name: "short body", parts: ["bytes 10-13/1000", "bytes 20-21/1000"] },
  { name: "long body", parts: ["bytes 10-11/1000", "bytes 20-21/1000"] },
])("rejects malformed multipart $name without fallback", async ({ parts }) => {
  const bytes = multipart(parts.map((range, index) => ({
    range, body: new Uint8Array(index ? [4, 5] : [1, 2, 3]),
  })));
  const { reader, fetchMock } = await preparedReader(respond(206, bytes, {
    "content-type": "multipart/byteranges; boundary=audio-boundary",
  }));
  await expect(reader.fetchRanges(pair)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([
  { name: "trailing garbage", closing: "\r\n--audio-boundary--\r\njunk", extra: "" },
  { name: "oversized headers", extra: `X-Fill: ${"a".repeat(4096)}\r\n` },
  { name: "duplicate Content-Range", extra: "Content-Range: bytes 10-12/1000\r\n" },
  { name: "bare LF headers", extra: "X-Test: a\nX-Other: b\r\n" },
  { name: "folded headers", extra: " continued\r\n" },
  { name: "wrong delimiter", closing: "\r\n--wrong--\r\n", extra: "" },
])("rejects $name without fallback", async ({ closing, extra }) => {
  const bytes = multipart([
    { range: "bytes 10-12/1000", body: new Uint8Array([1, 2, 3]), extra },
    { range: "bytes 20-21/1000", body: new Uint8Array([4, 5]) },
  ], "audio-boundary", closing);
  const { reader, fetchMock } = await preparedReader(respond(206, bytes, {
    "content-type": "multipart/byteranges; boundary=audio-boundary",
  }));
  await expect(reader.fetchRanges(pair)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each(['""', `"${"a".repeat(71)}"`, '"bad\\boundary"', '"trailing "', 'x; boundary=y', '"bad\r\nheader"'])(
  "rejects a malicious boundary parameter %j",
  async (boundary) => {
    // Response headers forbid CRLF at construction; supply the untrusted field directly.
    const response = respond(206, new Uint8Array(), {});
    vi.spyOn(response.headers, "get").mockImplementation((name) =>
      name === "content-type" ? `multipart/byteranges; boundary=${boundary}` : null,
    );
    const { reader, fetchMock } = await preparedReader(response);
    await expect(reader.fetchRanges(pair)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  },
);

it("bounds a multipart stream without Content-Length and cancels overflow", async () => {
  let pulled = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(4096));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), {
    status: 206, headers: { "content-type": "multipart/byteranges; boundary=x" },
  });
  const { reader, fetchMock } = await preparedReader(response);
  await expect(reader.fetchRanges(pair)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
  expect(cancelled).toBe(true);
  expect(pulled).toBeLessThanOrEqual(3);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([200, 416, 501, 206])(
  "cancels unsupported multi status %s unread and disables multipart",
  async (status) => {
    let pulled = false;
    let cancelled = false;
    const response = new Response(new ReadableStream({
      pull() { pulled = true; },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { status });
    const { reader, fetchMock } = await preparedReader(response);
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const range = new Headers(init.headers).get("Range")?.match(/^bytes=(\d+)-(\d+)$/);
      if (!range) throw new Error("unexpected multipart retry");
      const start = Number(range[1]);
      const end = Number(range[2]);
      return respond(206, new Uint8Array(end - start + 1).fill(start), {
        "content-range": `bytes ${start}-${end}/1000`,
      });
    });
    for (let i = 0; i < 2; i++) {
      const bodies = await reader.fetchRanges(pair);
      expect(bodies.map((b) => [...new Uint8Array(b)])).toEqual([[10, 10, 10], [20, 20]]);
    }
    expect(cancelled).toBe(true);
    expect(pulled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  },
);

it("limits fallback concurrency to four while preserving order", async () => {
  const { reader, fetchMock } = await preparedReader(new Response(null, { status: 501 }));
  const gates = Array.from({ length: 6 }, () => Promise.withResolvers<Response>());
  const firstStarted = Promise.withResolvers<void>();
  const lastStarted = Promise.withResolvers<void>();
  let started = 0;
  let active = 0;
  let peak = 0;
  fetchMock.mockImplementation(() => {
    const gate = gates[started++];
    if (!gate) throw new Error("unexpected request");
    active++;
    peak = Math.max(peak, active);
    if (started === 4) firstStarted.resolve();
    if (started === 6) lastStarted.resolve();
    return gate.promise.finally(() => active--);
  });
  const ranges: ByteRange[] = gates.map((_, i) => ({ start: i * 10, end: i * 10 + 1 }));
  const pending = reader.fetchRanges(ranges);
  const resolve = (index: number) => gates[index]?.resolve(respond(
    206, new Uint8Array([index]), { "content-range": `bytes ${index * 10}-${index * 10}/1000` },
  ));
  await firstStarted.promise;
  expect(started).toBe(4);
  for (const index of [3, 1, 2, 0]) resolve(index);
  await lastStarted.promise;
  resolve(5);
  resolve(4);
  expect((await pending).map((b) => [...new Uint8Array(b)])).toEqual([[0], [1], [2], [3], [4], [5]]);
  expect(peak).toBe(4);
});

it.each([401, 403, 500])("does not fall back for status %s", async (status) => {
  const { reader, fetchMock } = await preparedReader(new Response(null, { status }));
  await expect(reader.fetchRanges(pair)).rejects.toMatchObject({
    code: status === 500 ? "UNSUPPORTED_MEDIA" : "MEDIA_DENIED",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("does not fall back after a network failure", async () => {
  const { reader, fetchMock } = await preparedReader(new Response());
  fetchMock.mockReset().mockRejectedValue(new TypeError("Failed to fetch"));
  await expect(reader.fetchRanges(pair)).rejects.toMatchObject({ code: "MEDIA_NETWORK" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("aborts fallback siblings immediately when one range fails", async () => {
  const { reader, fetchMock } = await preparedReader(new Response(null, { status: 501 }));
  const started = Promise.withResolvers<void>();
  const failure = Promise.withResolvers<Response>();
  let calls = 0;
  let aborted = 0;
  fetchMock.mockImplementation((_url: string, init: RequestInit) => {
    calls++;
    if (calls === 4) started.resolve();
    if (calls === 1) return failure.promise;
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted++;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  });
  const result = reader.fetchRanges(
    Array.from({ length: 6 }, (_, i) => ({ start: i * 10, end: i * 10 + 1 })),
  );
  const rejected = expect(result).rejects.toMatchObject({ code: "MEDIA_DENIED" });
  await started.promise;
  failure.resolve(new Response(null, { status: 403 }));
  await rejected;
  expect(calls).toBe(4);
  expect(aborted).toBe(3);
});

it("accepts exactly 64 ranges and one MiB of total payload", async () => {
  const ranges = Array.from({ length: 64 }, (_, index) => ({
    start: index * 20000, end: index * 20000 + 16384,
  }));
  const bytes = multipart(ranges.toReversed().map((range, index) => ({
    range: `bytes ${range.start}-${range.end - 1}/2000000`,
    body: new Uint8Array(16384).fill(63 - index),
  })));
  const { reader } = await preparedReader(respond(206, bytes, {
    "content-type": "multipart/byteranges; boundary=audio-boundary",
    "content-length": String(bytes.length),
  }), 2000000);
  const bodies = await reader.fetchRanges(ranges);
  // Summarize each 16 KiB part instead of deep-comparing 1 MiB element by
  // element, which is slow under coverage instrumentation. Each part is filled
  // with a distinct byte and sent in reverse, so order and content still count.
  const summary = bodies.map((body) => {
    const bytes = new Uint8Array(body);
    const first = bytes[0] ?? -1;
    return [bytes.length, bytes.every((value) => value === first) ? first : -1];
  });
  expect(summary).toEqual(ranges.map((_, index) => [16384, index]));
});

it.each([2, 4])("rejects an exact Content-Range with %s payload bytes instead of three", async (size) => {
  const { reader, fetchMock } = await preparedReader(respond(206, multipart([
    { range: "bytes 10-12/1000", body: new Uint8Array(size) },
    { range: "bytes 20-21/1000", body: new Uint8Array(2) },
  ]), { "content-type": "multipart/byteranges; boundary=audio-boundary" }));
  await expect(reader.fetchRanges(pair)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each(["99999999", "invalid", "0"])("rejects invalid multipart Content-Length %s", async (length) => {
  const { reader, fetchMock } = await preparedReader(respond(206, multipart([
    { range: "bytes 10-12/1000", body: new Uint8Array(3) },
    { range: "bytes 20-21/1000", body: new Uint8Array(2) },
  ]), { "content-type": "multipart/byteranges; boundary=audio-boundary", "content-length": length }));
  await expect(reader.fetchRanges(pair)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("does not disable multipart after a malformed response", async () => {
  const { reader, fetchMock } = await preparedReader(respond(206, new Uint8Array(), {
    "content-type": "multipart/byteranges; boundary=x",
  }));
  await expect(reader.fetchRanges(pair)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
  fetchMock.mockResolvedValueOnce(respond(206, multipart([
    { range: "bytes 10-12/1000", body: new Uint8Array(3) },
    { range: "bytes 20-21/1000", body: new Uint8Array(2) },
  ]), { "content-type": "multipart/byteranges; boundary=audio-boundary" }));
  expect(await reader.fetchRanges(pair)).toHaveLength(2);
  expect(fetchMock.mock.calls[2]?.[1].headers).toEqual({ Range: "bytes=10-12,20-21" });
});

it("propagates cancellation in fallback without starting another batch", async () => {
  const { reader, fetchMock } = await preparedReader(new Response(null, { status: 501 }));
  const request = new AbortController();
  const started = Promise.withResolvers<void>();
  let singles = 0;
  fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    if (++singles === 4) started.resolve();
  }));
  const ranges = Array.from({ length: 8 }, (_, index) => ({ start: index * 10, end: index * 10 + 1 }));
  const pending = reader.fetchRanges(ranges, request.signal);
  const rejection = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  await started.promise;
  request.abort();
  await rejection;
  expect(singles).toBe(4);
});

it.each(["parent", "request"])("propagates %s cancellation during multipart streaming", async (source) => {
  const parent = new AbortController();
  const request = new AbortController();
  const reading = Promise.withResolvers<void>();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() { reading.resolve(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const fetchMock = vi.fn().mockResolvedValueOnce(respond(
    206, new Uint8Array([0]), { "content-range": "bytes 0-0/1000" },
  )).mockResolvedValueOnce(new Response(stream, {
    status: 206, headers: { "content-type": "multipart/byteranges; boundary=x" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  const reader = mediaRangeReader(url, parent.signal);
  await reader.totalSize();
  const pending = reader.fetchRanges(pair, request.signal);
  const rejection = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  await reading.promise;
  (source === "parent" ? parent : request).abort();
  await rejection;
  expect(cancelled).toBe(true);
  expect(parent.signal.aborted).toBe(source === "parent");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
