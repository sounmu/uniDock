export interface ByteRange {
  start: number;
  end: number;
}

export interface AudioLayout {
  trackId: number;
  ranges: ByteRange[];
}

export class Mp4Error extends Error {
  constructor(readonly code: "NO_AUDIO_TRACK" | "BAD_MP4") {
    super(code);
  }
}

const u32 = (b: Uint8Array, o: number) =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);
const fourcc = (b: Uint8Array, o: number) =>
  String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

interface Box {
  type: string;
  body: number;
  end: number;
}

/** Boxes directly inside [start,end); size 1 is a 64-bit largesize, 0 runs to end. */
function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = u32(b, offset);
    let body = offset + 8;
    if (size === 1) {
      size = u64(b, offset + 8);
      body = offset + 16;
    }
    if (size === 0) size = end - offset;
    if (size < 8 || offset + size > end) break;
    out.push({ type: fourcc(b, offset + 4), body, end: offset + size });
    offset += size;
  }
  return out;
}

function child(b: Uint8Array, box: Box, name: string): Box | undefined {
  return boxes(b, box.body, box.end).find((c) => c.type === name);
}

function trackId(b: Uint8Array, trak: Box): number {
  const tkhd = child(b, trak, "tkhd");
  if (!tkhd) throw new Mp4Error("BAD_MP4");
  const version = b[tkhd.body]!;
  return version === 1 ? u32(b, tkhd.body + 20) : u32(b, tkhd.body + 12);
}

function samples(b: Uint8Array, stbl: Box): ByteRange[] {
  const stsz = child(b, stbl, "stsz");
  const stsc = child(b, stbl, "stsc");
  const stco = child(b, stbl, "stco");
  const co64 = child(b, stbl, "co64");
  const chunkBox = stco ?? co64;
  if (!stsz || !stsc || !chunkBox) throw new Mp4Error("BAD_MP4");

  // Table counts must fit their boxes, so a corrupt moov cannot read past them.
  const fits = (box: Box, header: number, count: number, entry: number) =>
    box.body + header + count * entry <= box.end;
  const uniform = u32(b, stsz.body + 4);
  const sampleCount = u32(b, stsz.body + 8);
  if (!uniform && !fits(stsz, 12, sampleCount, 4)) throw new Mp4Error("BAD_MP4");
  const size = (index: number) =>
    uniform || u32(b, stsz.body + 12 + index * 4);

  const chunkCount = u32(b, chunkBox.body + 4);
  if (!fits(chunkBox, 8, chunkCount, stco ? 4 : 8)) throw new Mp4Error("BAD_MP4");
  const chunkOffset = (index: number) =>
    stco ? u32(b, stco.body + 8 + index * 4) : u64(b, co64!.body + 8 + index * 8);

  const runCount = u32(b, stsc.body + 4);
  if (!fits(stsc, 8, runCount, 12)) throw new Mp4Error("BAD_MP4");
  const runs: { first: number; perChunk: number }[] = [];
  for (let i = 0; i < runCount; i++)
    runs.push({
      first: u32(b, stsc.body + 8 + i * 12),
      perChunk: u32(b, stsc.body + 8 + i * 12 + 4),
    });

  const ranges: ByteRange[] = [];
  let sampleIndex = 0;
  for (let chunk = 1; chunk <= chunkCount && sampleIndex < sampleCount; chunk++) {
    let perChunk = 0;
    for (let r = runs.length - 1; r >= 0; r--)
      if (chunk >= runs[r]!.first) {
        perChunk = runs[r]!.perChunk;
        break;
      }
    let offset = chunkOffset(chunk - 1);
    for (let s = 0; s < perChunk && sampleIndex < sampleCount; s++) {
      const length = size(sampleIndex++);
      const last = ranges[ranges.length - 1];
      if (last && last.end === offset) last.end = offset + length;
      else ranges.push({ start: offset, end: offset + length });
      offset += length;
    }
  }
  if (sampleIndex !== sampleCount) throw new Mp4Error("BAD_MP4");
  return ranges;
}

/** Locate the audio (soun) track and the byte ranges of only its samples. */
export function audioLayout(moovBuffer: Uint8Array): AudioLayout {
  const [moov] = boxes(moovBuffer, 0, moovBuffer.length);
  if (!moov || moov.type !== "moov") throw new Mp4Error("BAD_MP4");
  for (const trak of boxes(moovBuffer, moov.body, moov.end).filter(
    (x) => x.type === "trak",
  )) {
    const mdia = child(moovBuffer, trak, "mdia");
    const hdlr = mdia && child(moovBuffer, mdia, "hdlr");
    if (!mdia || !hdlr || fourcc(moovBuffer, hdlr.body + 8) !== "soun") continue;
    const minf = child(moovBuffer, mdia, "minf");
    const stbl = minf && child(moovBuffer, minf, "stbl");
    if (!stbl) throw new Mp4Error("BAD_MP4");
    return { trackId: trackId(moovBuffer, trak), ranges: samples(moovBuffer, stbl) };
  }
  throw new Mp4Error("NO_AUDIO_TRACK");
}

export interface TopLevelBox {
  type: string;
  start: number;
  end: number;
}

/**
 * Parse one top-level box header read at `start` (8 or 16 bytes). Size 1 is a
 * 64-bit largesize and 0 runs to the end of the file.
 */
export function topLevelBox(
  header: Uint8Array,
  start: number,
  fileSize: number,
): TopLevelBox {
  if (header.length < 8) throw new Mp4Error("BAD_MP4");
  let size = u32(header, 0);
  if (size === 1) {
    if (header.length < 16) throw new Mp4Error("BAD_MP4");
    size = u64(header, 8);
  } else if (size === 0) size = fileSize - start;
  if (size < 8 || start + size > fileSize) throw new Mp4Error("BAD_MP4");
  return { type: fourcc(header, 4), start, end: start + size };
}
