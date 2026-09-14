import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@strudel/core';
import { mini } from '@strudel/mini';
import { transpiler } from '@strudel/transpiler';
import { EPOCH, BAR_MS, BARS } from '../composer.mjs';
import { readFixture } from '../test/update-fixtures.mjs';
import { eventsForCycles, build } from './schedule.mjs';

core.setStringParser(core.pure);

// Build the same pattern the browser would run, from a committed fixture. The
// fixtures are two layers since issue #3 — a shared engine snapshot plus a small
// per-anchor file — so the source comes back through readFixture() rather than
// off disk in one piece. What it hands back is still the committed bytes:
// export.test.mjs asserts the reassembled source is byte-identical to the export.
function strudelPattern(fixture) {
  const source = readFixture(fixture).strudel;
  const names = ['Pattern', 'stack', 'note', 's'];
  const { output } = transpiler(source, { wrapAsync: false, addReturn: true });
  return new Function(...names, 'setcps', 'mini', output)(...names.map((n) => core[n]), () => {}, mini);
}

// The fixture's own anchor, in cycles, so our absolute cycles line up with its timeline.
function anchorCycle(fixture) {
  const source = readFixture(fixture).strudel;
  const at = source.match(/Score anchor: (\S+)\./)[1];
  return Math.floor((Date.parse(at) - EPOCH) / BAR_MS);
}

const round = (n) => Math.round(n * 1e6) / 1e6;

// Reduce a Strudel hap to a comparable record.
function fromHap(hap, startBar) {
  const v = hap.value;
  const whole = hap.whole ?? hap.part;
  return {
    wave: v.s,
    // White-noise voices (snares, hats) carry neither freq nor note; the runtime
    // falls back to 440 for them, so the oracle must too or every one mismatches.
    freq: round(
      v.freq !== undefined ? Number(v.freq)
        : v.note !== undefined ? 440 * Math.pow(2, (Number(v.note) - 69) / 12)
        : 440,
    ),
    attack: round(v.attack), decay: round(v.decay), sustain: round(v.sustain), release: round(v.release),
    cutoff: v.cutoff === undefined ? null : round(v.cutoff),
    hcutoff: v.hcutoff === undefined ? null : round(v.hcutoff),
    gain: round(v.gain),
    begin: round(Number(whole.begin) + startBar),
    end: round(Number(whole.end) + startBar),
  };
}

function fromOurs(evt) {
  return {
    wave: evt.wave, freq: round(evt.freq),
    attack: round(evt.attack), decay: round(evt.decay), sustain: round(evt.sustain), release: round(evt.release),
    cutoff: evt.cutoff === undefined ? null : round(evt.cutoff),
    hcutoff: evt.hcutoff === undefined ? null : round(evt.hcutoff),
    gain: round(evt.gain),
    begin: round(evt.begin), end: round(evt.end),
  };
}

// Sort on the whole record, not a subset of fields — a partial key leaves equal
// keys (e.g. two events sharing begin/wave/freq/gain but differing in cutoff or
// release) in an unstable order, which risks a spurious deepEqual failure.
const sortEvents = (a) => [...a].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));

const JOURNALS = {
  'quiet-afternoon': { version: 1, seed: 'window-seat-v1', events: [] },
  'weathered-night': {
    version: 1, seed: 'window-seat-v1',
    events: [
      { id: 'fixture-remember-1', at: '2026-09-09T12:00:00Z', type: 'remember', motif: 'm8329137' },
      { id: 'fixture-weather-1', at: '2026-09-10T18:00:00Z', type: 'weather', value: 'rain' },
    ],
  },
};

// Acceptance criterion 2 requires "at least 1,000 scenes" of differential coverage
// against the Strudel oracle. One cycle is one bar; BARS cycles make a scene, so
// TARGET_SCENES * BARS cycles gives that many scenes per fixture.
const TARGET_SCENES = 1000;

for (const fixture of Object.keys(JOURNALS)) {
  test(`schedule matches the Strudel score for ${fixture}`, () => {
    const pattern = strudelPattern(fixture);
    const startBar = anchorCycle(fixture);
    const journal = JOURNALS[fixture];

    for (let offset = 0; offset < TARGET_SCENES * BARS; offset++) {
      const theirs = sortEvents(
        pattern.queryArc(offset, offset + 1).map((h) => fromHap(h, startBar)),
      );
      const ours = sortEvents(eventsForCycles(startBar + offset, 1, journal).map(fromOurs));
      assert.deepEqual(ours, theirs, `${fixture} cycle offset ${offset}`);
    }
  });
}

test('eventsForCycles spanning many cycles equals the union of single cycles', () => {
  const journal = JOURNALS['quiet-afternoon'];
  const start = 216813 * BARS;
  const wide = sortEvents(eventsForCycles(start, 8, journal).map(fromOurs));
  let narrow = [];
  for (let c = 0; c < 8; c++) narrow = narrow.concat(eventsForCycles(start + c, 1, journal).map(fromOurs));
  assert.deepEqual(wide, sortEvents(narrow));
});

test('build throws on an unrecognised filter type instead of treating it as hpf', () => {
  // composer.mjs's real VOICES table only ever has 'lpf'/'hpf' filters, so this
  // constructs a synthetic voice to exercise the branch a future third filter
  // type would otherwise fall silently into as a high-pass.
  const voice = {
    field: 'bogus', kind: 's', wave: 'sine', freq: 440,
    attack: 0.01, decay: 0.1, sustain: 0, release: 0.1, gain: 0.5,
    filters: [{ type: 'bandpass', value: 1000 }],
  };
  const parsed = { value: 1, begin: 0, end: 1 };
  const sceneData = {};
  const drift = { gain: 1, cutoff: 1800, release: 0.6 };
  assert.throws(() => build(voice, parsed, sceneData, drift), /unrecognised filter type/);
});
