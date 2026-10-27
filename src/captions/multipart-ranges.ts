import { AudioExtractError } from "./audio-extract";
import type { ByteRange } from "./mp4-audio";

const MAX_HEADERS = 4096;
const encoder = new TextEncoder();

export function multipartBoundary(contentType: string): string {
  const match =
    /^multipart\/byteranges\s*;\s*boundary=(?:"([0-9A-Za-z'()+_,./:=? -]{1,70})"|([0-9A-Za-z'+_.-]{1,70}))\s*$/i.exec(
      contentType,
    );
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.endsWith(" "))
    throw new AudioExtractError("UNSUPPORTED_MEDIA");
  return boundary;
}

export function multipartLimit(payload: number, parts: number, boundary: string): number {
  return payload + parts * (MAX_HEADERS + boundary.length + 8) + boundary.length + 8;
}

/** Only headers are scanned. Binary bodies are advanced by their exact range length. */
export function parseMultipartRanges(
  bytes: Uint8Array,
  boundary: string,
  ranges: readonly ByteRange[],
  total: number,
): ArrayBuffer[] {
  let offset = 0;
  function fail(): never {
    throw new AudioExtractError("UNSUPPORTED_MEDIA");
  }
  const take = (text: string) => {
    for (const byte of encoder.encode(text))
      if (bytes[offset++] !== byte) fail();
  };
  const result = new Map<number, ArrayBuffer>();
  // This CDN prefixes its first delimiter with the optional MIME CRLF.
  if (bytes[0] === 13 && bytes[1] === 10) take("\r\n");
  for (let part = 0; part < ranges.length; part++) {
    take(`${part === 0 ? "" : "\r\n"}--${boundary}\r\n`);
    let headers = "";
    while (!headers.endsWith("\r\n\r\n")) {
      const byte = bytes[offset++];
      if (byte === undefined || headers.length >= MAX_HEADERS ||
          (byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126)))
        fail();
      headers += String.fromCharCode(byte);
    }
    let range: ByteRange | undefined;
    const names = new Set<string>();
    for (const line of headers.slice(0, -4).split("\r\n")) {
      const header = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([\t\x20-\x7e]*)$/.exec(line);
      if (!header) fail();
      const name = header[1]?.toLowerCase() ?? "";
      if (names.has(name)) fail();
      names.add(name);
      if (name === "content-range") {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header[2] ?? "");
        if (!match) fail();
        const start = Number(match[1]);
        const inclusive = Number(match[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(inclusive) ||
            inclusive < start || inclusive >= total || Number(match[3]) !== total)
          fail();
        range = { start, end: inclusive + 1 };
      }
    }
    if (!range) fail();
    const expectedRange = range;
    const index = ranges.findIndex((r) => r.start === expectedRange.start && r.end === expectedRange.end);
    if (index < 0 || result.has(index)) fail();
    const end = offset + range.end - range.start;
    if (end > bytes.length) fail();
    result.set(index, bytes.slice(offset, end).buffer);
    offset = end;
  }
  take(`\r\n--${boundary}--`);
  if (offset !== bytes.length) take("\r\n");
  if (offset !== bytes.length) fail();
  return ranges.map((_, index) => {
    const body = result.get(index);
    if (!body) return fail();
    return body;
  });
}
