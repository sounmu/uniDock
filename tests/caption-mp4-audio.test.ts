import { expect, it } from "vitest";
import { audioLayout, topLevelBox } from "../src/captions/mp4-audio";

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}
function ascii(text: string): Uint8Array {
  return new Uint8Array([...text].map((c) => c.charCodeAt(0)));
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
function box(type: string, payload: Uint8Array): Uint8Array {
  return concat(u32(payload.length + 8), ascii(type), payload);
}

function track(handler: string, trackId: number, stbl: Uint8Array): Uint8Array {
  const tkhd = box("tkhd", concat(u32(0), u32(0), u32(0), u32(trackId)));
  const hdlr = box("hdlr", concat(u32(0), u32(0), ascii(handler)));
  const minf = box("minf", stbl);
  const mdia = box("mdia", concat(hdlr, minf));
  return box("trak", concat(tkhd, mdia));
}

function audioStbl(): Uint8Array {
  const stsz = box("stsz", concat(u32(0), u32(0), u32(3), u32(100), u32(150), u32(50)));
  const stsc = box(
    "stsc",
    concat(u32(0), u32(2), u32(1), u32(2), u32(1), u32(2), u32(1), u32(1)),
  );
  const stco = box("stco", concat(u32(0), u32(2), u32(2_000_000), u32(3_000_000)));
  return box("stbl", concat(stsz, stsc, stco));
}

function emptyStbl(): Uint8Array {
  const stsz = box("stsz", concat(u32(0), u32(0), u32(0)));
  const stsc = box("stsc", concat(u32(0), u32(0)));
  const stco = box("stco", concat(u32(0), u32(0)));
  return box("stbl", concat(stsz, stsc, stco));
}

it("locates the audio track and coalesces its sample ranges", () => {
  const moov = box(
    "moov",
    concat(track("vide", 2, emptyStbl()), track("soun", 1, audioStbl())),
  );
  const layout = audioLayout(moov);
  expect(layout.trackId).toBe(1);
  expect(layout.ranges).toEqual([
    { start: 2_000_000, end: 2_000_250 },
    { start: 3_000_000, end: 3_000_050 },
  ]);
});

it("throws when there is no audio track", () => {
  const moov = box("moov", track("vide", 1, emptyStbl()));
  expect(() => audioLayout(moov)).toThrow();
});

it("reads 32-bit, 64-bit and to-end top-level box headers", () => {
  expect(topLevelBox(concat(u32(28), ascii("ftyp")), 0, 100)).toEqual({
    type: "ftyp",
    start: 0,
    end: 28,
  });
  expect(
    topLevelBox(concat(u32(1), ascii("mdat"), u32(0), u32(5000)), 40, 9000),
  ).toEqual({ type: "mdat", start: 40, end: 5040 });
  expect(topLevelBox(concat(u32(0), ascii("mdat")), 40, 9000).end).toBe(9000);
});

it("rejects box headers that are short or overrun the file", () => {
  expect(() => topLevelBox(concat(u32(4), ascii("free")), 0, 100)).toThrow();
  expect(() => topLevelBox(concat(u32(200), ascii("moov")), 0, 100)).toThrow();
  expect(() => topLevelBox(concat(u32(1), ascii("mdat")), 0, 100)).toThrow();
});

it("rejects sample tables whose counts overrun their boxes", () => {
  const stsz = box("stsz", concat(u32(0), u32(0), u32(4_000_000_000)));
  const stsc = box("stsc", concat(u32(0), u32(0)));
  const stco = box("stco", concat(u32(0), u32(0)));
  const moov = box("moov", track("soun", 1, box("stbl", concat(stsz, stsc, stco))));
  expect(() => audioLayout(moov)).toThrow("BAD_MP4");
});
