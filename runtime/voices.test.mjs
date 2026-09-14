import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEvents, noiseSeed, sampleAt, SR, CYCLE_SECONDS } from './voices.mjs';

const note = (over = {}) => ({
  wave: 'sine', freq: 440,
  attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.1,
  gain: 0.5, begin: 0, end: 0.5, ...over,
});

test('sampleAt maps absolute cycles to absolute samples', () => {
  assert.equal(sampleAt(0), 0);
  assert.equal(sampleAt(1), Math.round(CYCLE_SECONDS * SR));
  assert.equal(sampleAt(2), Math.round(2 * CYCLE_SECONDS * SR));
});

test('a rendered note is silent before its start and audible after', () => {
  const buf = renderEvents([note({ begin: 0.5, end: 1 })], { originSample: 0, lengthSamples: sampleAt(2) });
  const startsAt = sampleAt(0.5);
  let before = 0;
  for (let i = 0; i < startsAt; i++) before = Math.max(before, Math.abs(buf[i]));
  let after = 0;
  for (let i = startsAt; i < startsAt + SR * 0.2; i++) after = Math.max(after, Math.abs(buf[i]));
  assert.equal(before, 0, 'must be silent before the note begins');
  assert.ok(after > 0.1, `expected audible signal, peak was ${after}`);
});

test('gain scales the output proportionally', () => {
  const opts = { originSample: 0, lengthSamples: sampleAt(1) };
  const quiet = renderEvents([note({ gain: 0.1 })], opts);
  const loud = renderEvents([note({ gain: 0.4 })], opts);
  const peak = (b) => b.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(Math.abs(peak(loud) / peak(quiet) - 4) < 0.01, 'gain must scale linearly');
});

test('rendering is deterministic, including the noise voices', () => {
  const evts = [note({ wave: 'white', freq: 3000 }), note({ wave: 'triangle' })];
  const opts = { originSample: 0, lengthSamples: sampleAt(1) };
  assert.deepEqual(Array.from(renderEvents(evts, opts)), Array.from(renderEvents(evts, opts)));
});

test('rendering is identical regardless of origin offset, preserving absolute time seeding', () => {
  // Events spanning cycles 3..6 with white-noise and pitched event with release tail
  const events = [
    note({ wave: 'white', freq: 3000, begin: 3, end: 4 }),
    note({ wave: 'sine', freq: 440, begin: 3.5, end: 5, release: 0.5 }),
  ];

  const renderA = renderEvents(events, { originSample: sampleAt(3), lengthSamples: sampleAt(6) - sampleAt(3) });
  const renderB = renderEvents(events, { originSample: sampleAt(4), lengthSamples: sampleAt(6) - sampleAt(4) });

  // Overlapping region: cycles 4..6 in renderA maps to samples [sampleAt(4) - sampleAt(3), renderA.length)
  // Same region in renderB is [0, renderB.length)
  const offset = sampleAt(4) - sampleAt(3);
  for (let i = 0; i < renderB.length; i++) {
    assert.equal(renderA[i + offset], renderB[i], `sample ${i} differs between origin=sampleAt(3) and origin=sampleAt(4)`);
  }
});

test('a low-pass filter attenuates high frequencies more than low ones', () => {
  const opts = { originSample: 0, lengthSamples: sampleAt(1) };
  const peak = (b) => b.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const low = peak(renderEvents([note({ freq: 200, cutoff: 400 })], opts));
  const high = peak(renderEvents([note({ freq: 8000, cutoff: 400 })], opts));
  assert.ok(high < low * 0.5, `lpf should cut 8k far more than 200Hz (low ${low}, high ${high})`);
});

// A broadcast-era cycle: the stream's epoch is 2026, which puts absolute sample
// positions around 1.05e12 — past 2^32, and far past where a float multiply by a
// 32-bit constant keeps its low bits.
const BROADCAST_CYCLE = 6938016;
const CYCLES_PER_YEAR = Math.round((365 * 24 * 3600) / CYCLE_SECONDS);

// Hats land 8 to the cycle; one day of them is ~212k onsets. Sample that grid rather
// than consecutive samples, because the collapse this guards against (#11) was in the
// high bits of the position, which a dense sample of adjacent positions would miss.
function distinctSeeds(fromCycle, onsets, voiceId) {
  const step = sampleAt(1) / 8;
  const seeds = new Set();
  for (let i = 0; i < onsets; i++) seeds.add(noiseSeed(sampleAt(fromCycle) + Math.round(i * step), voiceId));
  return seeds.size;
}

test('noise seeds stay distinct across a day of onsets, and do not thin out as the stream ages', () => {
  // The old seed reached exactly 8192 distinct values here, halving for each later
  // anchor. A 32-bit seed gives ~1 birthday collision at this count, so allow a few.
  const onsets = 20000;
  for (const years of [0, 1, 5, 20]) {
    const distinct = distinctSeeds(BROADCAST_CYCLE + years * CYCLES_PER_YEAR, onsets, 'hats');
    assert.ok(
      distinct > onsets - 10,
      `${years} years in: expected ~${onsets} distinct seeds, got ${distinct}`,
    );
  }
});

test('two voices on the same onset get different noise, not one shared realization', () => {
  // Snares and hats are both `wave: 'white'` triggers with no freq of their own, so
  // before #11 they shared schedule.mjs's 440 fallback and seeded identically.
  const startAbs = sampleAt(BROADCAST_CYCLE + 0.25);
  assert.notEqual(noiseSeed(startAbs, 'snares'), noiseSeed(startAbs, 'hats'));

  const opts = { originSample: 0, lengthSamples: sampleAt(1) };
  const shared = { wave: 'white', freq: 440, attack: 0.001, decay: 0.08, sustain: 0, release: 0.025, gain: 0.5, begin: 0, end: 0.25 };
  const snare = renderEvents([{ ...shared, voice: 'snares' }], opts);
  const hat = renderEvents([{ ...shared, voice: 'hats' }], opts);
  assert.notDeepEqual(Array.from(snare), Array.from(hat), 'same onset, different voice must not render identically');
});

test('a noise seed depends only on absolute position and voice, never on how it is reached', () => {
  // The bit-identity guarantee render.test.mjs asserts on whole chunks, stated at the
  // level of the seed itself: same position and voice, same seed, every time.
  const startAbs = sampleAt(BROADCAST_CYCLE + 0.5);
  assert.equal(noiseSeed(startAbs, 'hats'), noiseSeed(startAbs, 'hats'));
  assert.notEqual(noiseSeed(startAbs, 'hats'), noiseSeed(startAbs + 1, 'hats'));
});
