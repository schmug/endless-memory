import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEvents, sampleAt, SR, CYCLE_SECONDS } from './voices.mjs';

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
