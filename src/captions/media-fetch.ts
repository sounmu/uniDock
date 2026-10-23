import { AudioExtractError, type RangeFetch } from "./audio-extract";

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

async function readExactly(
  response: Response,
  expected: number,
  local: AbortController,
): Promise<ArrayBuffer> {
  const out = new Uint8Array(expected);
  let filled = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new AudioExtractError("UNSUPPORTED_MEDIA");
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (filled + value.byteLength > expected) {
      local.abort();
      throw new AudioExtractError("UNSUPPORTED_MEDIA");
    }
    out.set(value, filled);
    filled += value.byteLength;
  }
  if (filled !== expected) throw new AudioExtractError("UNSUPPORTED_MEDIA");
  return out.buffer;
}

/**
 * Range-only reader for the one media URL. Anything other than a 206 whose
 * Content-Range matches the requested bytes is aborted before the body is read,
 * so a server that ignores Range can never stream the whole video into memory.
 */
export function mediaRangeReader(mediaUrl: string, signal: AbortSignal) {
  let knownTotal: number | null = null;

  async function request(start: number, endInclusive: number) {
    const local = new AbortController();
    const forward = () => local.abort();
    signal.addEventListener("abort", forward, { once: true });
    try {
      let response: Response;
      try {
        response = await fetch(mediaUrl, {
          headers: { Range: `bytes=${start}-${endInclusive}` },
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: local.signal,
        });
      } catch {
        throw new AudioExtractError(signal.aborted ? "ABORTED" : "MEDIA_NETWORK");
      }
      // The CDN answers 403 when the player Referer is missing; that is an
      // access problem, not a file without audio.
      if (response.status === 401 || response.status === 403) {
        local.abort();
        throw new AudioExtractError("MEDIA_DENIED");
      }
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
        local.abort();
        throw new AudioExtractError("UNSUPPORTED_MEDIA");
      }
      const body = await readExactly(response, expected, local);
      return { body, total: range.total };
    } finally {
      signal.removeEventListener("abort", forward);
    }
  }

  const fetchRange: RangeFetch = async (start, endInclusive) =>
    (await request(start, endInclusive)).body;

  async function totalSize(): Promise<number> {
    const { total } = await request(0, 0);
    knownTotal = total;
    return total;
  }

  return { fetchRange, totalSize };
}
