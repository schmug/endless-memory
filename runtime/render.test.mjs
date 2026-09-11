import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BARS } from '../composer.mjs';
import { sampleAt } from './voices.mjs';
import { renderChunk } from './render.mjs';
import { pcmHash, GOLDEN } from './update-golden.mjs';

const QUIET = { version: 1, seed: 'window-seat-v1', events: [] };
const WEATHERED = {
  version: 1, seed: 'window-seat-v1',
  events: [
    { id: 'fixture-remember-1', at: '2026-09-09T12:00:00Z', type: 'remember', motif: 'm8329137' },
    { id: 'fixture-weather-1', at: '2026-09-10T18:00:00Z', type: 'weather', value: 'rain' },
  ],
};

// Render [start, start+span) in chunks of `size`, concatenated.
function chunked(start, span, size, journal) {
  const out = new Float32Array(sampleAt(start + span) - sampleAt(start));
  for (let c = start; c < start + span; c += size) {
    const count = Math.min(size, start + span - c);
    out.set(renderChunk(c, count, journal), sampleAt(c) - sampleAt(start));
  }
  return out;
}

function assertIdentical(a, b, label) {
  assert.equal(a.length, b.length, `${label}: lengths differ`);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      assert.fail(`${label}: sample ${i} differs — chunked ${a[i]} vs one-pass ${b[i]}`);
    }
  }
}

for (const [name, journal, start] of [
  ['quiet', QUIET, 216813 * BARS],
  ['weathered', WEATHERED, 216386 * BARS],
]) {
  test(`chunked rendering is bit-identical to one-pass (${name})`, () => {
    const span = 16;
    const onePass = renderChunk(start, span, journal);
    for (const size of [1, 2, 3, 4, 8]) {
      assertIdentical(chunked(start, span, size, journal), onePass, `${name} chunk size ${size}`);
    }
  });
}

test('chunked rendering is bit-identical across a scene boundary', () => {
  // A scene boundary falls every BARS cycles; straddle one.
  const start = 216813 * BARS - 4;
  const onePass = renderChunk(start, 12, QUIET);
  assertIdentical(chunked(start, 12, 3, QUIET), onePass, 'scene boundary');
});

test('a rendered chunk is never silent', () => {
  const buf = renderChunk(216813 * BARS, 4, QUIET);
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak > 0.01, `expected audible output, peak was ${peak}`);
});

test('a chunk covers exactly its cycle span in samples', () => {
  const start = 216813 * BARS;
  assert.equal(renderChunk(start, 8, QUIET).length, sampleAt(start + 8) - sampleAt(start));
});

test('golden audio: a fixed anchor renders to the pinned hash and levels', () => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/golden-quiet.json', import.meta.url), 'utf8'));
  const actual = pcmHash(renderChunk(GOLDEN.startCycle, GOLDEN.cycles, GOLDEN.journal));
  assert.equal(actual.hash, expected.hash,
    'Rendered audio changed. If deliberate, run `npm run golden` and review the diff.');
  assert.ok(Math.abs(actual.peak - expected.peak) < 1e-9, `peak ${actual.peak} vs ${expected.peak}`);
  assert.ok(Math.abs(actual.rms - expected.rms) < 1e-9, `rms ${actual.rms} vs ${expected.rms}`);
});

test('runtime/ imports only node builtins and composer.mjs', () => {
  const files = ['mini.mjs', 'voices.mjs', 'schedule.mjs', 'render.mjs'];
  // Match specifiers, not whole statements — a regex anchored to one statement
  // shape (e.g. single-quoted `import x from '...'`) is easy to evade with a
  // different quote style, a bare side-effect import, dynamic import(), or
  // require(). Cover all four forms independently.
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,               // static: import x from 'pkg' | "pkg"
    /\bimport\s+['"]([^'"]+)['"]/g,             // bare side-effect: import 'pkg' | "pkg"
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,   // dynamic: import('pkg') | import("pkg")
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,  // require('pkg') | require("pkg")
  ];
  for (const file of files) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    for (const pattern of patterns) {
      for (const m of src.matchAll(pattern)) {
        const spec = m[1];
        const ok = spec.startsWith('node:') || spec.startsWith('./') || spec === '../composer.mjs';
        assert.ok(ok, `${file} imports '${spec}' — runtime/ must not depend on packages`);
      }
    }
  }
});

test('the CLI writes PCM with no stray bytes before it', () => {
  const out = `${process.env.TMPDIR ?? '/tmp'}/em-cli-${process.pid}.raw`;
  execFileSync(process.execPath, [
    new URL('./render.mjs', import.meta.url).pathname,
    '--anchor', '2026-09-11T14:00:00Z', '--out', out, '--seconds', '6',
  ], { stdio: 'pipe' });
  const buf = readFileSync(out);
  assert.equal(buf.length % 4, 0, 'expected whole 16-bit stereo frames');
  assert.ok(buf.length > 6 * 48000 * 4 * 0.9, `expected ~6s of audio, got ${buf.length} bytes`);
  let peak = 0;
  for (let i = 0; i < buf.length; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)) / 32768);
  assert.ok(peak > 0.01, `expected audible output, peak ${peak}`);
});
