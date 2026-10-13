// Piece D's picture: a 160x35 luminance grid in, a 1280x720 PNG out. Pure — no
// clock, no network, no filesystem, no ffmpeg. The decode and the crop live in
// ops/videoframe.mjs and nowhere else; this module only ever sees the cropped,
// downscaled grid that comes out of that one call.
//
// Specified in docs/superpowers/specs/2026-09-14-visual-layer-design.md, "The ASCII
// rendering", "Rasterising to the PNG" and "Night: observed, not assumed".
//
// The rasteriser is hand-drawn bitmaps through ops/placeholder.mjs's encoder rather
// than ffmpeg drawtext, which the prototype used. drawtext needs a font file and a
// freetype build on whichever host runs it, and it expands `%` unless told not to —
// the ramp contains `%`. Ten glyphs and a caption alphabet are less to depend on.

import { encodePng, FONT as LETTERS, WIDTH, HEIGHT, GROUND } from './placeholder.mjs';

export { WIDTH, HEIGHT };

// The grid. 3840x1700 is 2.26:1; at a cell aspect near 1:2, 160x35 reproduces it.
export const COLS = 160;
export const ROWS = 35;

// Dark to light. Ten levels: a 70-glyph ramp at this grid reads as texture, not tone.
// Bright maps to dense, so a bright sky is a dense field and the water is open.
export const RAMP = ' .:-=+*#%@';

// Per-frame auto-level percentiles. Load-bearing at night, where a fixed 0-255
// mapping renders 28 of 35 rows as one repeated glyph. Never make it optional.
export const LOW_PERCENTILE = 0.02;
export const HIGH_PERCENTILE = 0.98;

// Temporal smoothing weight on the newest frame. 0.4 took the measured night noise
// floor from ~11% glyph churn to ~4% and settles a real change in 2-3 frames.
export const ALPHA = 0.4;

// Sticky glyphs: a cell keeps its glyph until the smoothed tone is more than this far
// from that glyph's centre, i.e. 1.1 ramp steps past the edge of its own band. The EMA
// alone left night at ~24% churn on the 2026-10-11 log (spans of 16-17 levels); with
// this, noise that small moves the ink and not the shape. A real change still crosses
// the band within a few frames — see "sticky glyphs still follow a real change".
export const STICKY_BAND = 1.6 / RAMP.length;

// One cell is 8x16, so 160 columns are exactly 1280 px and 35 rows are 560 px.
export const CELL_W = 8;
export const CELL_H = 16;
const PANEL_TOP = 40;
export const PANEL_HEIGHT = ROWS * CELL_H;

// Light glyphs on piece E's near-black ground. The caption is dimmer on purpose: a
// footnote, not a chyron. GLYPH_INK is the mono ink, used when no camera ink is given.
export const GLYPH_INK = [0xc6, 0xd0, 0xd8];

// Camera ink: each glyph takes the hue of the camera at its cell, with saturation
// boosted around the cell's grey and the brightest channel pinned at INK_PEAK, so a
// dark cell is still a legible glyph — tone is carried by the glyph, colour by the ink.
// No channel goes below MIN_INK. Chosen by eye on 2026-10-12 against four alternatives.
export const INK_SATURATION = 2.2;
export const INK_PEAK = 215;
export const MIN_INK = 40;
export const CAPTION_INK = [0x5c, 0x68, 0x72];

// The ramp glyphs, 8 wide by 16 tall, as row -> pattern. Tone is what matters, so
// ops/asciiframe.test.mjs checks that ink coverage strictly rises along the ramp; a
// glyph redrawn heavier than its successor would invert part of the picture.
const RAMP_GLYPHS = {
  ' ': {},
  '.': { 12: '...##...', 13: '...##...' },
  ':': { 4: '...##...', 5: '...##...', 11: '...##...', 12: '...##...' },
  '-': { 7: '.######.', 8: '.######.' },
  '=': { 5: '.######.', 6: '.######.', 9: '.######.', 10: '.######.' },
  '+': {
    3: '...##...', 4: '...##...', 5: '...##...', 6: '...##...', 7: '.######.',
    8: '.######.', 9: '...##...', 10: '...##...', 11: '...##...', 12: '...##...',
  },
  '*': {
    4: '...##...', 5: '##.##.##', 6: '.######.', 7: '..####..', 8: '.######.',
    9: '##.##.##', 10: '...##...',
  },
  '#': {
    3: '.##..##.', 4: '.##..##.', 5: '########', 6: '########', 7: '.##..##.',
    8: '.##..##.', 9: '########', 10: '########', 11: '.##..##.', 12: '.##..##.',
  },
  '%': {
    2: '###...##', 3: '###..###', 4: '###.###.', 5: '...###..', 6: '..###...',
    7: '.###....', 8: '###.....', 9: '##..###.', 10: '#..#####', 11: '..######',
    12: '.##.####', 13: '##..###.',
  },
  '@': {
    2: '.######.', 3: '########', 4: '##....##', 5: '##.#####', 6: '##.##.##',
    7: '##.##.##', 8: '##.##.##', 9: '##.#####', 10: '##......', 11: '########',
    12: '.#######',
  },
};

// Ink pixels per ramp glyph, for the coverage test.
export function glyphCoverage(ch) {
  const rows = RAMP_GLYPHS[ch];
  if (!rows) throw new Error(`'${ch}' is not a ramp glyph`);
  return Object.values(rows).reduce((n, p) => n + [...p].filter((c) => c === '#').length, 0);
}

// The caption alphabet: placeholder.mjs's 5x7 A-Z plus what a date, a time and an
// age need. Same rule as there: a missing glyph throws rather than rendering wrong.
const CAPTION_FONT = {
  ...LETTERS,
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  ',': [0x00, 0x00, 0x00, 0x00, 0x0c, 0x04, 0x08],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  '/': [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x00],
};
const CAPTION_SCALE = 2;
const CAPTION_LEFT = 24;
const CAPTION_TOP = PANEL_TOP + PANEL_HEIGHT + 48;

// The value at quantile q of a numeric array, nearest-rank.
function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

// Per-frame auto-level: stretch the grid's 2nd..98th percentile across 0..1. Returns
// the levelled grid and the span (p98 - p02, in source levels), which is the cheap
// night-health proxy the spec asks the renderer to log.
export function autoLevel(luma) {
  if (luma.length !== COLS * ROWS) throw new Error(`grid is ${luma.length} cells, expected ${COLS * ROWS}`);
  const sorted = Float64Array.from(luma).sort();
  const lo = quantile(sorted, LOW_PERCENTILE);
  const hi = quantile(sorted, HIGH_PERCENTILE);
  const span = hi - lo;
  const out = new Float64Array(luma.length);
  // A flat frame has no range to stretch. Mid-grey rather than a divide by zero:
  // a uniform frame should read as uniform, not as black.
  if (span <= 0) { out.fill(0.5); return { levelled: out, lo, hi, span: 0 }; }
  for (let i = 0; i < luma.length; i++) out[i] = Math.min(1, Math.max(0, (luma[i] - lo) / span));
  return { levelled: out, lo, hi, span };
}

// The fixed 0-255 mapping, kept only so criterion 9 can show what the auto-level
// buys. Nothing on the broadcast path calls it.
export function fixedLevel(luma) {
  return Float64Array.from(luma, (v) => v / 255);
}

// One step of the exponential moving average, applied to the levelled grid before
// the glyph mapping. `previous` null starts the average at this frame.
export function smooth(previous, levelled, alpha = ALPHA) {
  if (previous === null) return Float64Array.from(levelled);
  const out = new Float64Array(levelled.length);
  for (let i = 0; i < levelled.length; i++) out[i] = alpha * levelled[i] + (1 - alpha) * previous[i];
  return out;
}

// 0..1 tone to a ramp glyph, one row of text per grid row. With `previous` (the last
// render's lines) each cell keeps its old glyph while the tone stays within STICKY_BAND
// of that glyph's centre; without it, this is the plain mapping.
export function toGlyphs(tone, previous = null) {
  const last = RAMP.length - 1;
  const lines = [];
  for (let r = 0; r < ROWS; r++) {
    let line = '';
    for (let c = 0; c < COLS; c++) {
      const v = tone[r * COLS + c];
      if (previous) {
        const held = RAMP.indexOf(previous[r][c]);
        if (Math.abs(v - (held + 0.5) / RAMP.length) <= STICKY_BAND) { line += RAMP[held]; continue; }
      }
      line += RAMP[Math.min(last, Math.max(0, Math.floor(v * RAMP.length)))];
    }
    lines.push(line);
  }
  return lines;
}

// The camera's colour grid (COLS*ROWS RGB triples, 0..255, possibly smoothed) to one
// ink per cell, as a COLS*ROWS*3 Uint8Array that rasterise() takes.
export function cameraInk(rgb) {
  if (rgb.length !== COLS * ROWS * 3) throw new Error(`colour grid is ${rgb.length} values, expected ${COLS * ROWS * 3}`);
  const ink = new Uint8Array(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    const mean = (rgb[i] + rgb[i + 1] + rgb[i + 2]) / 3;
    const sat = [0, 1, 2].map((k) => mean + (rgb[i + k] - mean) * INK_SATURATION);
    const scale = INK_PEAK / Math.max(1, ...sat);
    for (let k = 0; k < 3; k++) ink[i + k] = Math.round(Math.min(255, Math.max(MIN_INK, sat[k] * scale)));
  }
  return ink;
}

// The mean per-channel ink change between two renders, as a share of full scale. Logged
// beside churn: with sticky glyphs, night noise shows up here instead.
export function inkShift(before, after) {
  if (!before) return null;
  let sum = 0;
  for (let i = 0; i < after.length; i++) sum += Math.abs(after[i] - before[i]);
  return sum / after.length / 255;
}

// The share of cells whose glyph changed between two renders. The criterion 8 bar
// is smoothed churn at or below 8% overnight.
export function churn(before, after) {
  if (!before) return null;
  let changed = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) if (before[r][c] !== after[r][c]) changed++;
  }
  return changed / (ROWS * COLS);
}

function fillRect(raster, x0, y0, w, h, ink) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const at = (y * WIDTH + x) * 3;
      raster[at] = ink[0];
      raster[at + 1] = ink[1];
      raster[at + 2] = ink[2];
    }
  }
}

// Caption text is upper-cased, and the em dash liveness.mjs uses is drawn as a hyphen.
export function captionText(text) {
  return text.toUpperCase().replace(/—/g, '-');
}

// The glyph field and its caption, rasterised to a 1280x720 RGB buffer. `ink` is one RGB
// triple per cell (cameraInk()); without it every glyph is GLYPH_INK.
export function rasterise(lines, caption, ink = null) {
  if (lines.length !== ROWS || lines.some((l) => l.length !== COLS)) {
    throw new Error(`expected ${ROWS} lines of ${COLS} glyphs`);
  }
  const raster = new Uint8Array(WIDTH * HEIGHT * 3);
  fillRect(raster, 0, 0, WIDTH, HEIGHT, GROUND);

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const rows = RAMP_GLYPHS[lines[r][c]];
      if (!rows) throw new Error(`'${lines[r][c]}' is not a ramp glyph`);
      const cell = ink ? ink.subarray((r * COLS + c) * 3, (r * COLS + c) * 3 + 3) : GLYPH_INK;
      for (const [dy, pattern] of Object.entries(rows)) {
        for (let dx = 0; dx < CELL_W; dx++) {
          if (pattern[dx] !== '#') continue;
          const at = ((PANEL_TOP + r * CELL_H + Number(dy)) * WIDTH + c * CELL_W + dx) * 3;
          raster[at] = cell[0];
          raster[at + 1] = cell[1];
          raster[at + 2] = cell[2];
        }
      }
    }
  }

  const text = captionText(caption);
  const advance = (5 + 1) * CAPTION_SCALE;
  if (CAPTION_LEFT + text.length * advance > WIDTH) throw new Error(`caption too long for the frame: ${text}`);
  for (let i = 0; i < text.length; i++) {
    const glyph = CAPTION_FONT[text[i]];
    if (!glyph) throw new Error(`no caption glyph for '${text[i]}'`);
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (!(glyph[row] & (1 << (4 - col)))) continue;
        fillRect(raster, CAPTION_LEFT + i * advance + col * CAPTION_SCALE,
          CAPTION_TOP + row * CAPTION_SCALE, CAPTION_SCALE, CAPTION_SCALE, CAPTION_INK);
      }
    }
  }
  return raster;
}

export const renderPng = (lines, caption, ink = null) => encodePng(rasterise(lines, caption, ink), WIDTH, HEIGHT);

// The caption line the renderer draws: place, view, the frame's own capture time and
// the ladder's verdict. `capturedAt` is null for the archive still, whose date is
// already in the liveness caption.
export function captionLine({ capturedAt, status }) {
  const parts = ['Boston Light, west'];
  if (capturedAt !== null && capturedAt !== undefined) {
    parts.push(new Date(capturedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
  }
  parts.push(status);
  return parts.join(' - ');
}
