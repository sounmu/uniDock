import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { AudioExtractError, extractAudio } from "../src/captions/audio-extract";
import type { ByteRange } from "../src/captions/mp4-audio";

// Synthetic 60 s, 16x16 mpeg4 + mono AAC, interleaved at 10 video frames/s.
// ffmpeg -f lavfi -i testsrc=size=16x16:rate=10
//   -f lavfi -i sine=frequency=440:sample_rate=16000 -t 60
//   -c:v mpeg4 -q:v 20 -c:a aac -b:a 32k -ac 1 -movflags +faststart many-chunks.mp4
function source() {
  const bytes = new Uint8Array(readFileSync(
    path.resolve(__dirname, "fixtures/media/many-chunks.mp4"),
  ));
  const fetchRange = async (start: number, end: number) =>
    bytes.slice(start, end + 1).buffer;
  const fetchRanges = (ranges: readonly ByteRange[]) =>
    ranges.map((range) => bytes.slice(range.start, range.end).buffer);
  return { bytes, fetchRange, fetchRanges };
}

it("bounds grouped prefetch to two batches and preserves audio when the second finishes first", async () => {
  const media = source();
  const started = Promise.withResolvers<void>();
  const pending: {
    ranges: readonly ByteRange[];
    response: ReturnType<typeof Promise.withResolvers<ArrayBuffer[]>>;
  }[] = [];
  let released = false;
  let active = 0;
  let peak = 0;
  const extraction = extractAudio(media.bytes.byteLength, media.fetchRange, {
    fetchRanges: async (ranges) => {
      expect(ranges.length).toBeLessThanOrEqual(256);
      expect(ranges.reduce((sum, r) => sum + r.end - r.start, 0))
        .toBeLessThanOrEqual(1024 * 1024);
      active++;
      peak = Math.max(peak, active);
      try {
        if (released) return media.fetchRanges(ranges);
        const response = Promise.withResolvers<ArrayBuffer[]>();
        pending.push({ ranges, response });
        if (pending.length === 2) started.resolve();
        return await response.promise;
      } finally {
        active--;
      }
    },
  });
  await started.promise;
  expect(pending.map(({ ranges }) => ranges.length)).toEqual([256, 256]);
  released = true;
  for (const request of [...pending].reverse())
    request.response.resolve(media.fetchRanges(request.ranges));
  const output = await extraction;
  const reference = await extractAudio(media.bytes.byteLength, media.fetchRange);
  expect(peak).toBe(2);
  expect(new Uint8Array(await output.arrayBuffer()))
    .toEqual(new Uint8Array(await reference.arrayBuffer()));
});

it("rejects a failed prefetched batch immediately and aborts its pending sibling", async () => {
  const media = source();
  const started = Promise.withResolvers<void>();
  const failure = Promise.withResolvers<ArrayBuffer[]>();
  let requests = 0;
  let siblingAborted = false;
  const extraction = extractAudio(media.bytes.byteLength, media.fetchRange, {
    fetchRanges: (_ranges, signal) => {
      requests++;
      if (requests === 2) {
        started.resolve();
        return failure.promise;
      }
      return new Promise<ArrayBuffer[]>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          siblingAborted = true;
          reject(new AudioExtractError("ABORTED"));
        }, { once: true });
      });
    },
  });
  const rejected = expect(extraction).rejects.toMatchObject({ code: "MEDIA_DENIED" });
  await started.promise;
  failure.reject(new AudioExtractError("MEDIA_DENIED"));
  await rejected;
  expect(siblingAborted).toBe(true);
  expect(requests).toBe(2);
});
