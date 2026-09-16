import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { encodePng, placeholderRaster, WIDTH, HEIGHT, GROUND, INK } from './placeholder.mjs';

// The PNG encoder is hand-written against node:zlib rather than pulled in, so it
// gets tested as a codec and not just as "something produced bytes". Inflating
// the IDAT back to filter-0 scanlines is the only check that proves the pixels
// ffmpeg will decode are the pixels that were drawn.
test('encodePng round-trips a raster back through inflate', () => {
  const raster = Uint8Array.from([
    1, 2, 3, 4, 5, 6,
    7, 8, 9, 10, 11, 12,
  ]);
  const png = encodePng(raster, 2, 2);

  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = idatPayload(png);
  // Each scanline is prefixed with filter byte 0.
  assert.deepEqual([...inflateSync(idat)], [0, 1, 2, 3, 4, 5, 6, 0, 7, 8, 9, 10, 11, 12]);
});

test('the IHDR declares the raster dimensions ffmpeg will read', () => {
  const png = encodePng(new Uint8Array(2 * 3 * 3), 3, 2);
  const ihdr = png.subarray(8 + 8, 8 + 8 + 13);

  assert.equal(ihdr.readUInt32BE(0), 3);
  assert.equal(ihdr.readUInt32BE(4), 2);
  assert.equal(ihdr[8], 8, 'bit depth');
  assert.equal(ihdr[9], 2, 'colour type 2 = truecolour RGB');
});

test('the placeholder is 1280x720, the frame size piece D must hand videofeed', () => {
  const raster = placeholderRaster();

  assert.equal(WIDTH, 1280);
  assert.equal(HEIGHT, 720);
  assert.equal(raster.length, WIDTH * HEIGHT * 3);
});

test('the placeholder sits on the dark ground, corner to corner', () => {
  const raster = placeholderRaster();
  const at = (x, y) => [...raster.subarray((y * WIDTH + x) * 3, (y * WIDTH + x) * 3 + 3)];

  for (const [x, y] of [[0, 0], [WIDTH - 1, 0], [0, HEIGHT - 1], [WIDTH - 1, HEIGHT - 1]]) {
    assert.deepEqual(at(x, y), GROUND, `pixel ${x},${y} is not the ground colour`);
  }
});

// "The station name, small, on the dark ground" — a frame that is entirely ground
// is indistinguishable from a broken feed on air, and a frame that is mostly ink is
// not what the spec asks for. Both directions are asserted.
test('the placeholder draws the station name rather than a blank field', () => {
  const raster = placeholderRaster();
  let ink = 0;
  for (let i = 0; i < raster.length; i += 3) {
    if (raster[i] === INK[0] && raster[i + 1] === INK[1] && raster[i + 2] === INK[2]) ink++;
  }

  assert.ok(ink > 0, 'the placeholder is a blank field');
  assert.ok(ink < WIDTH * HEIGHT * 0.05, `${ink} ink pixels is not "small"`);
});

// The committed PNG is what videofeed actually emits; the generator is what a
// reviewer can read. A drift between them means the picture on air is not the one
// in the source, so the two are pinned to each other — by decoded pixels rather
// than by bytes, because deflate output is a property of whichever zlib Node was
// built against and a byte comparison would go red on a Node upgrade that changed
// nothing about the picture.
test('the committed ops/placeholder.png decodes to exactly what the generator draws', () => {
  const committed = readFileSync(new URL('./placeholder.png', import.meta.url));
  const scanlines = inflateSync(idatPayload(committed));
  const stride = WIDTH * 3;
  const decoded = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    const row = y * (stride + 1);
    assert.equal(scanlines[row], 0, `scanline ${y} is not filter 0`);
    decoded.set(scanlines.subarray(row + 1, row + 1 + stride), y * stride);
  }

  assert.deepEqual([...decoded], [...placeholderRaster()]);
});

test('the committed ops/placeholder.png declares 1280x720 in its own header', () => {
  const committed = readFileSync(new URL('./placeholder.png', import.meta.url));
  const ihdr = committed.subarray(16, 29);

  assert.equal(ihdr.readUInt32BE(0), WIDTH);
  assert.equal(ihdr.readUInt32BE(4), HEIGHT);
});

function idatPayload(png) {
  let off = 8;
  const parts = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString('latin1');
    if (type === 'IDAT') parts.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  return Buffer.concat(parts);
}
