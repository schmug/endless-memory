// The launch picture: `ops/placeholder.png`, the frame `videofeed` emits when piece D
// (#38) has nothing to say — which at launch is always.
//
// It is generated rather than drawn in an image editor, and generated with node:zlib
// rather than with ffmpeg or a PNG package, for two reasons. A committed binary blob in
// a public repo is unreviewable: nobody can tell what is in it or regenerate it. And
// ops/ sits outside the runtime/ no-dependencies guard, so nothing stops a package being
// added here — but the host already has Node, and a 5x7 font plus a deflate call is less
// to install, pin and trust than a font stack.
//
// `ops/placeholder.test.mjs` pins the committed PNG to this file by decoded pixels.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The frame size in the seam contract: "hand videofeed a PNG, 1280x720".
export const WIDTH = 1280;
export const HEIGHT = 720;

// A dark ground and a muted foreground. Piece D owns the eventual palette; these two
// values are a placeholder for it, not a decision about it.
export const GROUND = [0x0e, 0x11, 0x16];
export const INK = [0x8a, 0x9b, 0xa8];

export const TEXT = 'ENDLESS MEMORY';

// 5x7, one byte per row, bit 4 is the leftmost column. Only the characters this frame
// needs would be enough, but a partial alphabet silently renders the wrong picture the
// first time the text changes, so the whole of A-Z is here.
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const FONT = {
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
};

// 4x, so "small": 14 characters land in 336 of 1280 px.
const SCALE = 4;
// One blank column between glyphs, at glyph scale.
const TRACKING = 1;

export function placeholderRaster(text = TEXT) {
  const raster = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let i = 0; i < raster.length; i += 3) {
    raster[i] = GROUND[0];
    raster[i + 1] = GROUND[1];
    raster[i + 2] = GROUND[2];
  }

  const advance = GLYPH_WIDTH + TRACKING;
  const textWidth = (text.length * advance - TRACKING) * SCALE;
  const originX = Math.round((WIDTH - textWidth) / 2);
  const originY = Math.round((HEIGHT - GLYPH_HEIGHT * SCALE) / 2);

  for (let c = 0; c < text.length; c++) {
    const glyph = FONT[text[c]];
    if (!glyph) throw new Error(`no glyph for '${text[c]}' — the 5x7 font covers space and A-Z`);
    for (let row = 0; row < GLYPH_HEIGHT; row++) {
      for (let col = 0; col < GLYPH_WIDTH; col++) {
        if (!(glyph[row] & (1 << (GLYPH_WIDTH - 1 - col)))) continue;
        const x0 = originX + (c * advance + col) * SCALE;
        const y0 = originY + row * SCALE;
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            const at = ((y0 + dy) * WIDTH + (x0 + dx)) * 3;
            raster[at] = INK[0];
            raster[at + 1] = INK[1];
            raster[at + 2] = INK[2];
          }
        }
      }
    }
  }
  return raster;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])), 0);
  return Buffer.concat([head, payload, crc]);
}

// 8-bit truecolour, every scanline filter 0. Filtering would compress a photograph
// better; this image is two colours and flat fields, where filter 0 already deflates to
// a few kilobytes, and a fixed filter keeps the decode in the test trivial and exact.
export function encodePng(raster, width = WIDTH, height = HEIGHT) {
  const stride = width * 3;
  const scanlines = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    scanlines[y * (stride + 1)] = 0;
    scanlines.set(raster.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour RGB
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const placeholderPng = (text = TEXT) => encodePng(placeholderRaster(text), WIDTH, HEIGHT);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] || new URL('./placeholder.png', import.meta.url);
  const png = placeholderPng();
  writeFileSync(out, png);
  console.error(`placeholder: ${WIDTH}x${HEIGHT}, ${png.length} bytes -> ${out}`);
}
