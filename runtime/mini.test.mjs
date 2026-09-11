import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@strudel/core';
import { mini } from '@strudel/mini';
import { scene } from '../composer.mjs';
import { parseCycle } from './mini.mjs';

core.setStringParser(core.pure);

// Strudel's own parse of the same string, for the same cycle, reduced to the shape
// parseCycle returns. This is the oracle; if the two disagree, we are wrong.
function strudelEvents(pattern, cycle) {
  return mini(pattern)
    .queryArc(cycle, cycle + 1)
    .map((h) => ({
      value: Number(h.value),
      begin: Number((h.whole ?? h.part).begin),
      end: Number((h.whole ?? h.part).end),
    }))
    .sort((a, b) => a.begin - b.begin || a.value - b.value);
}

const sorted = (evts) => [...evts].sort((a, b) => a.begin - b.begin || a.value - b.value);

test('parseCycle matches @strudel/mini across many scenes and every voice', () => {
  const journal = { version: 1, seed: 'window-seat-v1', events: [] };
  const fields = ['chords', 'bass', 'melody', 'kicks', 'snares', 'hats'];
  let compared = 0;
  for (let index = 216800; index < 216830; index++) {
    const s = scene(index, journal);
    for (let bar = 0; bar < 32; bar++) {
      const cycle = index * 32 + bar;
      for (const field of fields) {
        const ours = sorted(parseCycle(s[field], cycle));
        const theirs = strudelEvents(s[field], cycle);
        assert.deepEqual(ours, theirs, `${field} cycle ${cycle}\n${s[field].slice(0, 120)}`);
        compared++;
      }
    }
  }
  assert.ok(compared >= 5000, `expected a broad comparison, made ${compared}`);
});

test('parseCycle matches the oracle on a weathered journal with recall', () => {
  const journal = {
    version: 1,
    seed: 'window-seat-v1',
    events: [
      { id: 'fixture-remember-1', at: '2026-09-09T12:00:00Z', type: 'remember', motif: 'm8329137' },
      { id: 'fixture-weather-1', at: '2026-09-10T18:00:00Z', type: 'weather', value: 'rain' },
    ],
  };
  for (let index = 216386; index < 216400; index++) {
    const s = scene(index, journal);
    for (let bar = 0; bar < 32; bar += 3) {
      const cycle = index * 32 + bar;
      for (const field of ['chords', 'melody', 'kicks']) {
        assert.deepEqual(
          sorted(parseCycle(s[field], cycle)),
          strudelEvents(s[field], cycle),
          `${field} cycle ${cycle}`,
        );
      }
    }
  }
});

test('parseCycle matches the oracle at boundary cycles including 0 and negatives', () => {
  const journal = { version: 1, seed: 'window-seat-v1', events: [] };
  const s = scene(0, journal);
  const fields = ['chords', 'bass', 'melody', 'kicks', 'snares', 'hats'];
  const cycles = [0, 1, 2, 31, 32, -1, -32, -33];
  let compared = 0;
  for (const cycle of cycles) {
    for (const field of fields) {
      assert.deepEqual(
        sorted(parseCycle(s[field], cycle)),
        strudelEvents(s[field], cycle),
        `${field} cycle ${cycle}`,
      );
      compared++;
    }
  }
  assert.ok(compared >= 48, `expected 48 comparisons, made ${compared}`);
});

test('parseCycle throws on a value outside the frozen grammar instead of producing NaN', () => {
  // A NaN value that reached voices.mjs would write silent zero samples with no
  // thrown error — a hole in the audio with a zero exit code.
  assert.throws(() => parseCycle('bogus', 0), /not a finite number/);
  assert.throws(() => parseCycle('[1 bogus 3]', 0), /not a finite number/);
  assert.throws(() => parseCycle('<1 bogus>', 1), /not a finite number/);
});
