import test from 'node:test';
import assert from 'node:assert/strict';
import { BARS } from '../composer.mjs';
import { sampleAt } from './voices.mjs';
import { renderChunk } from './render.mjs';

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
