import { readFileSync } from "node:fs";
import path from "node:path";
import { createFile, MP4BoxBuffer, type Movie } from "mp4box";
import { describe, expect, it } from "vitest";
import { AudioExtractError, extractAudio } from "../src/captions/audio-extract";

// Fixtures: 3 s, 160x90 mpeg4 video + mono AAC, made with
// ffmpeg -f lavfi -i testsrc=size=160x90:rate=10 -f lavfi -i sine=frequency=440:sample_rate=16000
//   -t 3 -c:v mpeg4 -q:v 10 -c:a aac -b:a 32k -ac 1 -movflags +faststart front.mp4
// ffmpeg -i front.mp4 -c copy tail.mp4   (moov after mdat)
// video-first.mp4: the same command with -itsoffset 0.5 before the sine input and
// no +faststart, so the first sample right after the mdat header is video.
const dir = path.resolve(__dirname, "fixtures/media");

interface Parsed {
  info: Movie;
  samples: Map<number, { offset: number; size: number }[]>;
}

function parse(bytes: ArrayBuffer): Parsed {
  const file = createFile();
  let info: Movie | null = null;
  file.onReady = (value: Movie) => {
    info = value;
  };
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes.slice(0), 0));
  file.flush();
  if (!info) throw new Error("mp4box did not parse the file");
  const parsed = info as Movie;
  const samples = new Map(
    parsed.tracks.map((t) => [
      t.id,
      file.getTrackById(t.id).samples.map((s) => ({ offset: s.offset, size: s.size })),
    ]),
  );
  return { info: parsed, samples };
}

// tail.mp4 is ftyp(28) free(8) mdat(...): rewrite free + the 8-byte mdat header
// as one 16-byte largesize mdat header so sample offsets stay the same.
function withLargesizeMdat(bytes: Buffer): Buffer {
  const out = Buffer.from(bytes);
  expect(out.toString("latin1", 32, 36)).toBe("free");
  expect(out.toString("latin1", 40, 44)).toBe("mdat");
  const mdatSize = out.readUInt32BE(36);
  out.writeUInt32BE(1, 28);
  out.write("mdat", 32, "latin1");
  out.writeUInt32BE(0, 36);
  out.writeUInt32BE(mdatSize + 8, 40);
  return out;
}

function source(name: string) {
  const raw = readFileSync(path.join(dir, name.replace(":largesize", "")));
  const bytes = name.endsWith(":largesize") ? withLargesizeMdat(raw) : raw;
  const buffer = new Uint8Array(bytes).buffer;
  const calls: [number, number][] = [];
  const fetchRange = async (start: number, end: number) => {
    calls.push([start, end]);
    return buffer.slice(start, end + 1);
  };
  return { buffer, calls, fetchRange };
}

for (const name of ["front.mp4", "tail.mp4", "video-first.mp4", "tail.mp4:largesize"]) {
  describe(`real remux of ${name}`, () => {
    it("keeps only the audio track and never fetches video samples", async () => {
      const { buffer, calls, fetchRange } = source(name);
      const original = parse(buffer);
      const audio = original.info.audioTracks[0]!;
      const video = original.info.videoTracks[0]!;
      expect(video).toBeDefined();

      const blob = await extractAudio(buffer.byteLength, fetchRange);
      expect(blob.type).toBe("audio/mp4");

      const output = parse(await blob.arrayBuffer());
      expect(output.info.tracks).toHaveLength(1);
      expect(output.info.videoTracks).toHaveLength(0);
      expect(output.info.audioTracks[0]!.codec).toBe(audio.codec);
      expect(output.info.audioTracks[0]!.nb_samples).toBe(audio.nb_samples);

      for (const sample of original.samples.get(video.id)!) {
        const touched = calls.some(
          ([start, end]) =>
            start < sample.offset + sample.size && end >= sample.offset,
        );
        expect(touched).toBe(false);
      }
      const audioBytes = original.samples
        .get(audio.id)!
        .reduce((sum, s) => sum + s.size, 0);
      const fetched = calls.reduce((sum, [s, e]) => sum + (e - s + 1), 0);
      expect(fetched).toBeLessThan(audioBytes + 4096);
    });
  });
}

it("reports a non-MP4 body as UNSUPPORTED_MEDIA", async () => {
  const junk = new Uint8Array(4096).fill(7).buffer;
  await expect(
    extractAudio(junk.byteLength, async (s, e) => junk.slice(s, e + 1)),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
});

it("maps a failed range fetch to NETWORK", async () => {
  await expect(
    extractAudio(1000, async () => {
      throw new TypeError("Failed to fetch");
    }),
  ).rejects.toMatchObject({ code: "NETWORK" });
});

it("stops between audio ranges once aborted", async () => {
  const { buffer, fetchRange } = source("tail.mp4");
  const controller = new AbortController();
  const result = extractAudio(buffer.byteLength, fetchRange, {
    signal: controller.signal,
    onProgress: () => controller.abort(),
  });
  await expect(result).rejects.toBeInstanceOf(AudioExtractError);
  await expect(result).rejects.toMatchObject({ code: "ABORTED" });
});
