import { createFile, MP4BoxBuffer, type ISOFile, type Movie } from "mp4box";
import {
  audioLayout,
  Mp4Error,
  topLevelBox,
  type TopLevelBox,
  type ByteRange,
} from "./mp4-audio";

export type AudioExtractErrorCode =
  | "UNSUPPORTED_MEDIA"
  | "TOO_LARGE"
  | "MEDIA_DENIED"
  | "MEDIA_NETWORK"
  | "ABORTED";

export class AudioExtractError extends Error {
  constructor(readonly code: AudioExtractErrorCode) {
    super(code);
  }
}

export type RangeFetch = (
  start: number,
  endInclusive: number,
  signal?: AbortSignal,
) => Promise<ArrayBuffer>;

export type RangesFetch = (
  ranges: readonly ByteRange[],
  signal?: AbortSignal,
) => Promise<ArrayBuffer[]>;

interface ExtractOptions {
  signal?: AbortSignal;
  onProgress?: (bytes: number) => void;
  fetchRanges?: RangesFetch;
}

const HEADER_BYTES = 8;
const MAX_TOP_LEVEL_BOXES = 64;
const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const SAMPLES_PER_SEGMENT = 500;
const AUDIO_FETCH_CONCURRENCY = 4;

interface WalkedBox extends TopLevelBox {
  header: Uint8Array;
}

async function fetchBytes(
  fetchRange: RangeFetch,
  start: number,
  end: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  try {
    return new Uint8Array(await fetchRange(start, end - 1, signal));
  } catch (error) {
    if (error instanceof AudioExtractError) throw error;
    throw new AudioExtractError(signal?.aborted ? "ABORTED" : "MEDIA_NETWORK");
  }
}

/**
 * Walk the top-level boxes from byte 0, reading only each box header, so moov
 * is found wherever it sits (front after ftyp, or after mdat at the end).
 */
async function walkTopLevel(
  fetchRange: RangeFetch,
  totalSize: number,
  signal: AbortSignal | undefined,
): Promise<WalkedBox[]> {
  const found: WalkedBox[] = [];
  let offset = 0;
  while (offset < totalSize) {
    if (found.length >= MAX_TOP_LEVEL_BOXES)
      throw new AudioExtractError("UNSUPPORTED_MEDIA");
    // 8 bytes is the whole header unless size is 1 (64-bit largesize), so the
    // read never reaches into the first sample after an mdat header.
    const end = Math.min(offset + HEADER_BYTES, totalSize);
    let header = await fetchBytes(fetchRange, offset, end, signal);
    const largesize =
      header.length === HEADER_BYTES &&
      new DataView(header.buffer, header.byteOffset).getUint32(0) === 1;
    if (largesize) {
      const large = await fetchBytes(
        fetchRange,
        end,
        Math.min(end + HEADER_BYTES, totalSize),
        signal,
      );
      const joined = new Uint8Array(header.length + large.length);
      joined.set(header);
      joined.set(large, header.length);
      header = joined;
    }
    const box = topLevelBox(header, offset, totalSize);
    found.push({ ...box, header: header.slice(0, Math.min(header.length, box.end - box.start)) });
    offset = box.end;
  }
  return found;
}

/**
 * Stream only the audio track's bytes into a fresh fragmented `.m4a`. Video
 * sample ranges are never fetched; mp4box only sees ftyp, moov, the headers of
 * the other top-level boxes and the audio samples, each at its real offset.
 */
export async function extractAudio(
  totalSize: number,
  fetchRange: RangeFetch,
  options: ExtractOptions = {},
): Promise<Blob> {
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const stop = () => {
    if (signal?.aborted) throw new AudioExtractError("ABORTED");
  };
  try {
    stop();
    return await extract(totalSize, fetchRange, { ...options, signal }, stop);
  } catch (error) {
    if (error instanceof AudioExtractError) throw error;
    if (signal?.aborted) throw new AudioExtractError("ABORTED");
    throw new AudioExtractError("UNSUPPORTED_MEDIA");
  } finally {
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
  }
}

async function extract(
  totalSize: number,
  fetchRange: RangeFetch,
  options: ExtractOptions,
  stop: () => void,
): Promise<Blob> {
  const { signal } = options;
  const top = await walkTopLevel(fetchRange, totalSize, signal);
  const ftyp = top[0];
  const moov = top.find((box) => box.type === "moov");
  if (ftyp?.type !== "ftyp" || !moov) throw new Mp4Error("BAD_MP4");
  if (moov.end - moov.start > MAX_MOOV_BYTES)
    throw new AudioExtractError("TOO_LARGE");
  stop();
  const ftypBytes = await fetchBytes(fetchRange, ftyp.start, ftyp.end, signal);
  const moovBytes = await fetchBytes(fetchRange, moov.start, moov.end, signal);
  const layout = audioLayout(moovBytes);
  const total = layout.ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  if (total > MAX_AUDIO_BYTES) throw new AudioExtractError("TOO_LARGE");

  const file: ISOFile = createFile();
  const parts: ArrayBuffer[] = [];
  let failed = false;
  let ready = false;
  file.onError = () => {
    failed = true;
  };
  file.onReady = (info: Movie) => {
    const audio = info.audioTracks.find((t) => t.id === layout.trackId);
    if (!audio) {
      failed = true;
      return;
    }
    file.setSegmentOptions(audio.id, null, { nbSamples: SAMPLES_PER_SEGMENT });
    parts.push(file.initializeSegmentation().buffer);
    file.onSegment = (id, _user, buffer, nextSample) => {
      parts.push(buffer);
      // Drop samples already written so mp4box does not keep the whole track.
      file.releaseUsedSamples(id, nextSample);
    };
    ready = true;
    file.start();
  };

  const append = (bytes: Uint8Array, start: number) => {
    file.appendBuffer(
      MP4BoxBuffer.fromArrayBuffer(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        start,
      ),
    );
    if (failed) throw new Mp4Error("BAD_MP4");
  };
  for (const box of top) {
    if (box === ftyp) append(ftypBytes, box.start);
    else if (box === moov) append(moovBytes, box.start);
    else append(box.header, box.start);
  }
  if (!ready) throw new Mp4Error("NO_AUDIO_TRACK");

  let done = 0;
  for (let index = 0; index < layout.ranges.length;) {
    stop();
    const ranges: ByteRange[] = [];
    let size = 0;
    const limit = options.fetchRanges ? 64 : AUDIO_FETCH_CONCURRENCY;
    while (index < layout.ranges.length && ranges.length < limit) {
      const range = layout.ranges[index];
      if (!range) break;
      const bytes = range.end - range.start;
      if (options.fetchRanges && size + bytes > 1024 * 1024) break;
      ranges.push(range);
      size += bytes;
      index++;
    }
    // A single contiguous audio run can exceed the multipart payload cap.
    if (!ranges.length) {
      const range = layout.ranges[index];
      if (!range) break;
      const bytes = await fetchBytes(fetchRange, range.start, range.end, signal);
      stop();
      append(bytes, range.start);
      done += range.end - range.start;
      options.onProgress?.(done);
      index++;
      continue;
    }
    // Bound prefetch to one batch and append in file order.
    const buffers = options.fetchRanges
      ? (await options.fetchRanges(ranges, signal)).map((bytes, offset) => {
          const range = ranges[offset];
          if (!range || bytes.byteLength !== range.end - range.start)
            throw new Mp4Error("BAD_MP4");
          return { range, bytes: new Uint8Array(bytes) };
        })
      : await Promise.all(
      ranges.map(async (range) => ({
        range,
        bytes: await fetchBytes(fetchRange, range.start, range.end, signal),
      })),
    );
    if (buffers.length !== ranges.length) throw new Mp4Error("BAD_MP4");
    for (const { range, bytes } of buffers) {
      stop();
      append(bytes, range.start);
      done += range.end - range.start;
      options.onProgress?.(done);
    }
  }
  stop();
  file.flush();
  if (parts.length < 2) throw new Mp4Error("BAD_MP4");
  return new Blob(parts, { type: "audio/mp4" });
}
