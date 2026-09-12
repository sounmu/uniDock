import { Buffer } from "node:buffer";
import console from "node:console";
import fs from "node:fs";
import zlib from "node:zlib";
const crc = (data) => {
  let c = 0xffffffff;
  for (const b of data) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const name = Buffer.from(type),
    head = Buffer.alloc(4),
    tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([head, name, data, tail]);
};
function pixel(x, y) {
  const dx = Math.max(32 - x, 0, x - 96),
    dy = Math.max(32 - y, 0, y - 96);
  if (x < 16 || x >= 112 || y < 16 || y >= 112 || dx * dx + dy * dy > 256)
    return [0, 0, 0, 0];
  const circle = (x - 60) ** 2 + (y - 72) ** 2;
  const u =
    (((x >= 34 && x <= 50) || (x >= 70 && x <= 86)) && y >= 44 && y <= 72) ||
    (y >= 72 && circle <= 26 ** 2 && circle >= 10 ** 2) ||
    (x >= 70 && x <= 86 && y >= 44 && y <= 98);
  return u ? [255, 255, 255, 255] : [135, 32, 56, 255];
}
for (const size of [16, 32, 48, 128]) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const color = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const p = pixel(
            ((x + (sx + 0.5) / 4) * 128) / size,
            ((y + (sy + 0.5) / 4) * 128) / size,
          );
          for (let k = 0; k < 4; k++) color[k] += p[k] / 16;
        }
      for (let k = 0; k < 4; k++)
        raw[y * (size * 4 + 1) + 1 + x * 4 + k] = Math.round(color[k]);
    }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  fs.writeFileSync(
    `public/icons/${size}.png`,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
console.log("Generated original uniDock icons (no university branding).");
