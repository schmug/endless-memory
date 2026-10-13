import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import {
  COLS, ROWS, RAMP, ALPHA, WIDTH, HEIGHT, GLYPH_INK,
  glyphCoverage, autoLevel, fixedLevel, smooth, toGlyphs, churn, rasterise, renderPng,
  captionLine, captionText, cameraInk, inkShift, MIN_INK,
} from './asciiframe.mjs';
import { isCompletePng } from './videofeed.mjs';
import { ARCHIVE_DATE } from './liveness.mjs';

// A seeded generator, so the noise tests are the same noise every run.
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const grid = (fn) => Float64Array.from({ length: COLS * ROWS }, (_, i) => fn(Math.floor(i / COLS), i % COLS));

// The ramp is a tone scale drawn as glyphs. If a glyph were redrawn heavier than the
// one after it, part of every picture would be inverted and nobody would see why.
test('ink coverage strictly rises along the ramp', () => {
  const coverage = [...RAMP].map(glyphCoverage);
  for (let i = 1; i < coverage.length; i++) {
    assert.ok(coverage[i] > coverage[i - 1], `'${RAMP[i]}' (${coverage[i]}) is not denser than '${RAMP[i - 1]}' (${coverage[i - 1]})`);
  }
  assert.equal(coverage[0], 0, 'the darkest level is empty ground');
});

test('the grid fills the frame width exactly', () => {
  assert.equal(COLS, 160);
  assert.equal(ROWS, 35);
  assert.equal(RAMP, ' .:-=+*#%@');
  assert.equal(ALPHA, 0.4);
});

test('auto-level stretches the 2nd..98th percentile across the whole ramp', () => {
  // A frame occupying only 100..140 of 0..255, the way a hazy day does.
  const r = rng(3);
  const luma = grid(() => 100 + Math.floor(r() * 41));
  const { levelled, span } = autoLevel(luma);
  const glyphs = new Set(toGlyphs(levelled).join(''));
  assert.ok(span > 30 && span <= 40, `span ${span}`);
  assert.equal(glyphs.size, RAMP.length, 'every ramp level is used once the range is stretched');
});

test('a flat frame levels to uniform mid-grey, not to black', () => {
  const { levelled, span } = autoLevel(grid(() => 42));
  assert.equal(span, 0);
  assert.ok(levelled.every((v) => v === 0.5));
});

// Criterion 9's point, made on a synthetic night: a bright skyline band over a dark
// field occupying 27..44, the band a fixed mapping draws as nothing but '.'. The real check renders a recorded night frame; this one
// pins the mechanism so the auto-level cannot be "simplified" away without a test
// going red.
test('without the auto-level a night frame is dead air; with it, it is a picture', () => {
  const r = rng(7);
  const night = grid((row, col) => {
    if (row < 7) return 60 + Math.floor(r() * 34);                  // the lit skyline
    return 27 + Math.round(8 * (1 + Math.sin(col / 9 + row / 4))) + Math.floor(r() * 2); // channel and shore
  });
  const uniformRows = (lines) => lines.filter((l) => new Set(l).size === 1).length;

  const fixed = toGlyphs(fixedLevel(night));
  const levelled = toGlyphs(autoLevel(night).levelled);
  assert.ok(uniformRows(fixed) >= 28, `fixed mapping left only ${uniformRows(fixed)} uniform rows`);
  assert.equal(uniformRows(levelled), 0, 'the auto-level should resolve structure in every row');
});

// The measured night noise floor was frame-independent churn of 11-12%. The EMA is
// what takes it down; the bar is 8%.
test('smoothing at alpha 0.4 cuts frame-to-frame noise churn by well over half', () => {
  const r = rng(11);
  const scene = grid((row, col) => 0.5 + 0.4 * Math.sin(col / 13) * Math.cos(row / 5));
  const noisy = () => Float64Array.from(scene, (v) => v + (r() - 0.5) * 0.06);

  const N = 40;
  const WARM = 10;
  let tone = null;
  let rawPrev = null; let avgPrev = null;
  let rawChurn = 0; let avgChurn = 0;
  for (let i = 0; i < N; i++) {
    const f = noisy();
    tone = smooth(tone, f);
    const raw = toGlyphs(f);
    const avg = toGlyphs(tone);
    if (i >= WARM) { rawChurn += churn(rawPrev, raw); avgChurn += churn(avgPrev, avg); }
    rawPrev = raw;
    avgPrev = avg;
  }
  const n = N - WARM;
  assert.ok(avgChurn < rawChurn / 2, `smoothed churn ${(avgChurn / n).toFixed(3)} vs raw ${(rawChurn / n).toFixed(3)}`);
});

test('a real step change settles within a few frames', () => {
  let tone = smooth(null, grid(() => 0.1));
  for (let i = 0; i < 4; i++) tone = smooth(tone, grid(() => 0.9));
  // 0.6^4: within 13% of the new level after four frames, about four minutes of air.
  const settled = (tone[0] - 0.1) / 0.8;
  assert.ok(settled > 0.85, `after four frames the average has covered ${(settled * 100).toFixed(0)}% of the step`);
});

test('churn is the share of cells whose glyph changed', () => {
  const a = toGlyphs(grid(() => 0));
  const b = toGlyphs(grid((row) => (row === 0 ? 0.99 : 0)));
  assert.equal(churn(null, a), null);
  assert.equal(churn(a, a), 0);
  assert.equal(churn(a, b), COLS / (COLS * ROWS));
});

function decodeRaster(png) {
  // Concatenate IDATs, inflate, strip the filter byte (always 0 from this encoder).
  const parts = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const out = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) raw.copy(out, y * WIDTH * 3, y * (WIDTH * 3 + 1) + 1, (y + 1) * (WIDTH * 3 + 1));
  return out;
}

test('the rendered PNG is the 1280x720 frame videofeed accepts', () => {
  const png = renderPng(toGlyphs(grid((row, col) => col / COLS)), captionLine({ capturedAt: 0, status: 'live' }));
  assert.ok(isCompletePng(png));
  assert.equal(png.readUInt32BE(16), 1280);
  assert.equal(png.readUInt32BE(20), 720);
  // Glyph ink is actually drawn.
  const px = decodeRaster(png);
  let inked = 0;
  for (let i = 0; i < px.length; i += 3) if (px[i] === GLYPH_INK[0] && px[i + 1] === GLYPH_INK[1]) inked++;
  assert.ok(inked > 10_000, `${inked} glyph pixels`);
});

test('a frame that is all ground draws no glyph ink at all', () => {
  const px = rasterise(toGlyphs(grid(() => 0)), 'live');
  for (let i = 0; i < px.length; i += 3) assert.notEqual(px[i], GLYPH_INK[0]);
});

// The caption carries the honesty burden for all three ladder states, so every
// caption liveness.mjs can produce must be drawable rather than throw on air.
test('every ladder caption is drawable', () => {
  for (const status of ['live', 'held, frame 29 min old', `archive ${ARCHIVE_DATE} — not live`]) {
    for (const capturedAt of [null, Date.parse('2026-10-11T03:07:00Z')]) {
      assert.doesNotThrow(() => rasterise(toGlyphs(grid(() => 0.5)), captionLine({ capturedAt, status })));
    }
  }
});

test('the caption names the place, the view and the frame time in UTC', () => {
  assert.equal(captionLine({ capturedAt: Date.parse('2026-10-11T03:07:41Z'), status: 'live' }),
    'Boston Light, west - 2026-10-11 03:07 UTC - live');
  assert.equal(captionLine({ capturedAt: null, status: `archive ${ARCHIVE_DATE} — not live` }),
    `Boston Light, west - archive ${ARCHIVE_DATE} — not live`);
  assert.equal(captionText('archive 2025-01-10 — not live'), 'ARCHIVE 2025-01-10 - NOT LIVE');
});

// Criterion 8 failed on the 2026-10-11 24-hour log: at a night span of 16-17 levels the
// auto-level turns sensor noise into ~24% smoothed churn. Sticky glyphs keep a cell's
// glyph until its tone has clearly left that glyph's band, so the noise shows as a shift
// in ink rather than a change of shape.
test('sticky glyphs hold through night-level noise that boils the plain mapping', () => {
  const r = rng(5);
  const scene = grid((row, col) => 0.5 + 0.4 * Math.sin(col / 13) * Math.cos(row / 5));
  // Noise large against a ramp step (0.1): what a 17-level span does after the stretch.
  const noisy = () => Float64Array.from(scene, (v) => v + (r() - 0.5) * 0.5);
  let tone = null; let plainPrev = null; let stickyPrev = null;
  let plain = 0; let sticky = 0; let n = 0;
  for (let i = 0; i < 40; i++) {
    tone = smooth(tone, noisy());
    const p = toGlyphs(tone);
    const s = toGlyphs(tone, stickyPrev);
    if (i >= 10) { plain += churn(plainPrev, p); sticky += churn(stickyPrev, s); n++; }
    plainPrev = p; stickyPrev = s;
  }
  assert.ok(plain / n > 0.15, `the noise is not night-like: plain churn ${(plain / n).toFixed(3)}`);
  assert.ok(sticky / n <= 0.08, `sticky churn ${(sticky / n).toFixed(3)} is over the 8% bar`);
});

// The price of the band: a cell can settle one ramp step short of the plain mapping and
// stay there. Never more than one, and a real change still moves it on the first frame.
test('sticky glyphs still follow a real change, to within one ramp step', () => {
  let tone = smooth(null, grid(() => 0.1));
  let lines = toGlyphs(tone);
  const step = (a, b) => Math.abs(RAMP.indexOf(a[0][0]) - RAMP.indexOf(b[0][0]));
  for (let i = 1; i <= 20; i++) {
    tone = smooth(tone, grid(() => 0.9));
    const before = lines;
    lines = toGlyphs(tone, lines);
    if (i === 1) assert.notDeepEqual(lines, before, 'the first frame after the step changed nothing');
    if (i >= 5) assert.ok(step(lines, toGlyphs(tone)) <= 1, `frame ${i}: more than one step behind`);
  }
});

test('with no previous render, sticky glyphs are the plain mapping', () => {
  const tone = grid((row, col) => col / COLS);
  assert.deepEqual(toGlyphs(tone, null), toGlyphs(tone));
});

// The ink is the camera's colour at that cell: its hue, saturation boosted, its value
// pinned bright so the glyph stays legible on the near-black ground.
test('camera ink keeps the hue, and never drops a glyph below legible', () => {
  const rgb = new Float64Array(COLS * ROWS * 3);
  const cell = (i, c) => rgb.set(c, i * 3);
  cell(0, [120, 120, 120]);   // grey sky
  cell(1, [40, 70, 160]);     // blue water
  cell(2, [3, 2, 1]);         // near black
  const ink = cameraInk(rgb);
  assert.equal(ink.length, COLS * ROWS * 3);
  const at = (i) => [...ink.subarray(i * 3, i * 3 + 3)];
  const [gr, gg, gb] = at(0);
  assert.ok(gr === gg && gg === gb, `grey is not neutral: ${at(0)}`);
  const [br, bg, bb] = at(1);
  assert.ok(bb > bg && bg > br, `blue is not blue: ${at(1)}`);
  for (let i = 0; i < 3; i++) assert.ok(Math.max(...at(i)) >= 200, `cell ${i} ink ${at(i)} is too dim to read`);
  for (const v of ink) assert.ok(v >= MIN_INK && v <= 255);
});

test('ink shift is the mean per-channel change, as a share of full scale', () => {
  const a = new Uint8Array(COLS * ROWS * 3).fill(100);
  assert.equal(inkShift(null, a), null);
  assert.equal(inkShift(a, a), 0);
  assert.equal(inkShift(a, Uint8Array.from(a, () => 151)), 51 / 255);
});

test('each glyph is drawn in its own cell\'s ink', () => {
  const lines = toGlyphs(grid(() => 0.99));
  const ink = new Uint8Array(COLS * ROWS * 3);
  for (let i = 0; i < COLS * ROWS; i++) ink.set(i % 2 ? [200, 60, 60] : [60, 60, 200], i * 3);
  const px = rasterise(lines, 'live', ink);
  const colours = new Set();
  for (let i = 0; i < px.length; i += 3) colours.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
  assert.ok(colours.has('200,60,60') && colours.has('60,60,200'));
  assert.ok(!colours.has(GLYPH_INK.join(',')), 'the mono ink was drawn as well');
});
