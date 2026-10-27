import { AudioExtractError, type RangeFetch } from "./audio-extract";
import type { ByteRange } from "./mp4-audio";
import { multipartBoundary, multipartLimit, parseMultipartRanges } from "./multipart-ranges";

const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;

function parseContentRange(
  value: string | null,
): { start: number; end: number; total: number } | null {
  const match = value ? CONTENT_RANGE.exec(value.trim()) : null;
  if (!match) return null;
  const [start, end, total] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  if (!Number.isSafeInteger(total) || start > end || end >= total) return null;
  return { start, end, total };
}

async function readBounded(
  response: Response,
  expected: number,
  local: AbortController,
): Promise<ArrayBuffer> {
  const out = new Uint8Array(expected);
  let filled = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new AudioExtractError("UNSUPPORTED_MEDIA");
  const cancel = () => {
    void reader.cancel().catch(() => local.abort());
  };
  local.signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (local.signal.aborted) throw new AudioExtractError("ABORTED");
      const { done, value } = await reader.read();
      if (local.signal.aborted) throw new AudioExtractError("ABORTED");
      if (done) break;
      if (filled + value.byteLength > expected) {
        local.abort();
        throw new AudioExtractError("UNSUPPORTED_MEDIA");
      }
      out.set(value, filled);
      filled += value.byteLength;
    }
    return filled === expected ? out.buffer : out.buffer.slice(0, filled);
  } finally {
    local.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/**
 * Range-only reader for the one media URL. Unsupported full-body responses are
 * cancelled unread; both single and multipart 206 responses have bounded reads.
 */
export function mediaRangeReader(mediaUrl: string, signal: AbortSignal) {
  let knownTotal: number | null = null;
  let multipartEnabled = true;

  async function withResponse<T>(
    range: string,
    requestSignal: AbortSignal | undefined,
    consume: (response: Response, local: AbortController) => Promise<T>,
  ): Promise<T> {
    if (signal.aborted || requestSignal?.aborted)
      throw new AudioExtractError("ABORTED");
    const local = new AbortController();
    const forward = () => local.abort();
    signal.addEventListener("abort", forward, { once: true });
    requestSignal?.addEventListener("abort", forward, { once: true });
    try {
      let response: Response;
      try {
        response = await fetch(mediaUrl, {
          headers: { Range: `bytes=${range}` },
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: local.signal,
        });
      } catch {
        throw new AudioExtractError(local.signal.aborted ? "ABORTED" : "MEDIA_NETWORK");
      }
      if (local.signal.aborted) {
        await response.body?.cancel();
        throw new AudioExtractError("ABORTED");
      }
      // The CDN answers 403 when the player Referer is missing; that is an
      // access problem, not a file without audio.
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        local.abort();
        throw new AudioExtractError("MEDIA_DENIED");
      }
      return await consume(response, local);
    } catch (error) {
      if (error instanceof AudioExtractError) throw error;
      throw new AudioExtractError(local.signal.aborted ? "ABORTED" : "MEDIA_NETWORK");
    } finally {
      signal.removeEventListener("abort", forward);
      requestSignal?.removeEventListener("abort", forward);
    }
  }

  async function request(start: number, endInclusive: number, requestSignal?: AbortSignal) {
    return withResponse(`${start}-${endInclusive}`, requestSignal, async (response, local) => {
      const range = parseContentRange(response.headers.get("content-range"));
      const length = response.headers.get("content-length");
      const expected = endInclusive - start + 1;
      if (
        response.status !== 206 ||
        !range ||
        range.start !== start ||
        range.end !== endInclusive ||
        (knownTotal !== null && range.total !== knownTotal) ||
        (length !== null && Number(length) !== expected)
      ) {
        await response.body?.cancel();
        local.abort();
        throw new AudioExtractError("UNSUPPORTED_MEDIA");
      }
      const body = await readBounded(response, expected, local);
      if (body.byteLength !== expected) throw new AudioExtractError("UNSUPPORTED_MEDIA");
      return { body, total: range.total };
    });
  }

  const fetchRange: RangeFetch = async (start, endInclusive, requestSignal) =>
    (await request(start, endInclusive, requestSignal)).body;

  async function totalSize(): Promise<number> {
    const { total } = await request(0, 0);
    knownTotal = total;
    return total;
  }

  async function fetchRanges(
    ranges: readonly ByteRange[],
    requestSignal?: AbortSignal,
  ): Promise<ArrayBuffer[]> {
    if (signal.aborted || requestSignal?.aborted) throw new AudioExtractError("ABORTED");
    if (knownTotal === null) throw new AudioExtractError("UNSUPPORTED_MEDIA");
    if (ranges.length > 64) throw new AudioExtractError("TOO_LARGE");
    const requested = ranges.map(({ start, end }) => ({ start, end }));
    let payload = 0;
    const sorted = [...requested].sort((a, b) => a.start - b.start);
    for (const [index, range] of sorted.entries()) {
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
          range.start < 0 || range.end <= range.start || range.end > knownTotal ||
          (index > 0 && range.start < (sorted[index - 1]?.end ?? 0)))
        throw new AudioExtractError("UNSUPPORTED_MEDIA");
      payload += range.end - range.start;
    }
    if (payload > 1024 * 1024) throw new AudioExtractError("TOO_LARGE");
    if (requested.length === 0) return [];
    if (requested.length === 1) {
      const [range] = requested;
      if (range) return [await fetchRange(range.start, range.end - 1, requestSignal)];
    }
    const total = knownTotal;
    if (multipartEnabled) {
      const bodies = await withResponse(
        requested.map((r) => `${r.start}-${r.end - 1}`).join(","),
        requestSignal,
        async (response, local) => {
          const contentType = response.headers.get("content-type") ?? "";
          const isMultipart = /^multipart\/byteranges(?:\s*;|\s*$)/i.test(contentType);
          if ([200, 416, 501].includes(response.status) ||
              (response.status === 206 && !isMultipart)) {
            await response.body?.cancel();
            local.abort();
            multipartEnabled = false;
            return null;
          }
          try {
            if (response.status !== 206) throw new AudioExtractError("UNSUPPORTED_MEDIA");
            const boundary = multipartBoundary(contentType);
            const limit = multipartLimit(payload, requested.length, boundary);
            const length = response.headers.get("content-length");
            if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
              throw new AudioExtractError("UNSUPPORTED_MEDIA");
            const body = await readBounded(response, limit, local);
            if (length !== null && Number(length) !== body.byteLength)
              throw new AudioExtractError("UNSUPPORTED_MEDIA");
            return parseMultipartRanges(new Uint8Array(body), boundary, requested, total);
          } catch (error) {
            const failure = error instanceof AudioExtractError ? error :
              new AudioExtractError(local.signal.aborted ? "ABORTED" : "MEDIA_NETWORK");
            if (!response.body?.locked) await response.body?.cancel();
            local.abort();
            throw failure;
          }
        },
      );
      if (bodies) return bodies;
    }
    const bodies: ArrayBuffer[] = [];
    const fallback = new AbortController();
    const cancelFallback = () => fallback.abort();
    if (requestSignal?.aborted) fallback.abort();
    requestSignal?.addEventListener("abort", cancelFallback, { once: true });
    try {
      for (let index = 0; index < requested.length; index += 4) {
        bodies.push(...await Promise.all(requested.slice(index, index + 4).map(
          (range) => fetchRange(range.start, range.end - 1, fallback.signal),
        )));
      }
      return bodies;
    } finally {
      fallback.abort();
      requestSignal?.removeEventListener("abort", cancelFallback);
    }
  }

  return { fetchRange, totalSize, fetchRanges };
}
