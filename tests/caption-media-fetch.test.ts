import { afterEach, expect, it, vi } from "vitest";
import { mediaRangeReader } from "../src/captions/media-fetch";

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
