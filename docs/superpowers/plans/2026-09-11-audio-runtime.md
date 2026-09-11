# Audio Runtime (piece C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce continuous, correct PCM audio from the composition engine forever, so something downstream can encode and broadcast it.

**Architecture:** Four small modules under `runtime/`. `mini.mjs` parses the frozen mini-notation subset `scene()` emits. `voices.mjs` renders one parameterised event to samples. `schedule.mjs` joins `scene()`, the exported `VOICES` table and `atmosphere()` into timed events. `render.mjs` loops over chunks. Nothing imports Strudel at runtime; Strudel stays a devDependency acting as the test oracle.

**Tech Stack:** Node 22, ESM, `node:test`. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-11-audio-runtime-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 22.** CI pins `node-version: '22'`.
- **`runtime/` may import only Node built-ins and `../composer.mjs`.** No Strudel, no
  third-party packages. Task 5 adds a test asserting this.
- **Do not edit `composer.mjs`.** It carries the musical model. Its generated output is
  pinned byte-for-byte by `export.test.mjs`; if a fixture changes, the change is wrong.
- **Do not regenerate `test/fixtures/*.strudel`.** They must be unchanged at every commit.
- **Output format:** 48000 Hz, 16-bit, dual-mono (one mono signal on both channels).
- **Chunk invariance is the headline invariant.** Rendering a span in chunks must be
  bit-identical to rendering it in one pass. Task 4 proves it.
- **Report test results as counts** ("8 passing, 0 failing"), never "tests pass".
- **Commit prefixes:** conventional. Every commit ends with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Never add `Signed-off-by`.
- **`main` is gated.** Work on a branch, open a PR, never push to `main`.

## Facts you will need (verified 2026-09-11, do not re-derive)

`composer.mjs` exports `BPM` (76), `BARS` (32), `BAR_MS`, `EPOCH`, `hash`, `pick`,
`atmosphere(bar, journal)`, `validate(journal)`, `identity(index, journal)`,
`scene(index, journal)`, `VOICES`, `patternSource(s)`.

**One cycle equals one bar.** `setcps(76/60/4)` makes a cycle `240/76 = 3.157894…`
seconds. Scene index `i` covers cycles `[i*32, (i+1)*32)`, so cycle `c` belongs to scene
`Math.floor(c / 32)`.

**`VOICES`** (`composer.mjs:102`) is an array of six entries shaped:

```js
{ field: 'chords'|'bass'|'melody'|'kicks'|'snares'|'hats',
  kind: 'note' | 's',            // 'note' -> pitched, value is MIDI; 's' -> value is a trigger
  wave: 'triangle'|'sine'|'white',
  freq?: 52,                     // kicks only: fixed Hz, ignore the parsed value
  attack, decay, sustain, release: number,
  filters: [{ type:'lpf'|'hpf', value?: number, dynamic?: 'cutoff' }],
  gain: number }
```

**The mini-notation subset**, measured across 600 consecutive scenes — 6 distinct
characters (space, comma, digits, `<`, `>`, `[`, `]`, `~`), max nesting depth 2, 8
structural shapes. Real examples:

```
chords   <[57,60,64,67] [57,60,64,67] [65,69,72,76] ...>   // comma = simultaneous
bass     <[33 ~ 45 ~] [33 ~ 45 ~] ...>                     // 4 equal steps, ~ = rest
melody   <[76 ~ 72 79 ~ 72 76 69] ...>                     // 8 equal steps
hats     <[1 1 1 1 1 1 1 1] ...>
kicks    <[1 ~ ~ ~] [1 ~ ~ 1] ...>
snares   <[~ 1 ~ 1] ...>
```

`<a b c …>` alternates **one element per cycle**; each scene emits 32 entries, one per
bar, so cycle `c` selects entry `c % 32`. `[x y z]` subdivides its span into equal parts.
`[a,b,c]` stacks — every element spans the whole slot.

**Atmosphere drift.** `atmosphere(cycle, journal)` returns `{cutoff, gain, release}`. The
exported score applies it as: every voice's `gain` is multiplied by `drift.gain`; the
**chords voice only** additionally has its filter cutoff replaced by `drift.cutoff` and
its release replaced by `drift.release`. The chords voice is the one whose filter carries
`dynamic: 'cutoff'`.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `runtime/mini.mjs` | Parse one mini-notation string for one cycle into `[{value, begin, end}]` | 1 |
| `runtime/mini.test.mjs` | Differential test against `@strudel/mini` | 1 |
| `runtime/voices.mjs` | Render parameterised events to a Float32Array; `sampleAt` | 2 |
| `runtime/voices.test.mjs` | Envelope, filter, determinism | 2 |
| `runtime/schedule.mjs` | `scene()` + `VOICES` + `atmosphere()` → parameterised events | 3 |
| `runtime/schedule.test.mjs` | Differential against Strudel's `queryArc` | 3 |
| `runtime/render.mjs` | Chunk loop, CLI | 4, 5 |
| `runtime/render.test.mjs` | Chunk invariance, golden audio, guards | 4, 5 |
| `runtime/fixtures/` | Golden audio fixture | 5 |

---

### Task 1: Mini-notation parser

**Files:**
- Create: `runtime/mini.mjs`, `runtime/mini.test.mjs`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: nothing.
- Produces: `parseCycle(pattern: string, cycle: number) -> Array<{value: number, begin: number, end: number}>`, where `begin`/`end` are **absolute cycle positions** (fractional), and rests produce no entry.

- [ ] **Step 1: Branch**

```bash
cd /Users/cory/endless-memory && git checkout main && git pull && git checkout -b feat/audio-runtime
```

- [ ] **Step 2: Write the failing test**

Create `runtime/mini.test.mjs`. It compares our parser against `@strudel/mini` — the
oracle — for every field of many scenes.

```javascript
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
```

- [ ] **Step 3: Add the test file to the test script**

In `package.json`, change the `test` script to:

```json
    "test": "node --test composer.test.mjs export.test.mjs runtime/mini.test.mjs",
```

Leave `pretest`, `fixtures` and `export` untouched.

- [ ] **Step 4: Run the test to verify it fails**

```bash
cd /Users/cory/endless-memory && npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './mini.mjs'`. That is the right failure; the module
does not exist yet.

- [ ] **Step 5: Write the parser**

Create `runtime/mini.mjs`:

```javascript
// Parser for the frozen mini-notation subset composer.mjs emits.
//
// Grammar, measured across 600 consecutive scenes and unable to grow without failing
// export.test.mjs:
//   <a b c>   alternation, one element per cycle
//   [x y z]   equal subdivision of the enclosing span
//   [a,b,c]   stack; every element spans the whole slot
//   ~         rest, produces no event
//   integer   a value
//
// Strudel is the authority on what these mean; runtime/mini.test.mjs proves we agree.

// Split on `sep` at bracket depth 0 only.
function splitTop(src, sep) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of src) {
    if (ch === '[' || ch === '<') depth++;
    else if (ch === ']' || ch === '>') depth--;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function parseNode(src, begin, end, out) {
  const node = src.trim();
  if (node === '' || node === '~') return;

  if (node.startsWith('[') && node.endsWith(']')) {
    const inner = node.slice(1, -1);

    const stacked = splitTop(inner, ',');
    if (stacked.length > 1) {
      for (const part of stacked) parseNode(part, begin, end, out);
      return;
    }

    const steps = splitTop(inner, ' ');
    const width = (end - begin) / steps.length;
    steps.forEach((step, i) => parseNode(step, begin + i * width, begin + (i + 1) * width, out));
    return;
  }

  out.push({ value: Number(node), begin, end });
}

export function parseCycle(pattern, cycle) {
  const out = [];
  let src = String(pattern).trim();

  if (src.startsWith('<') && src.endsWith('>')) {
    const options = splitTop(src.slice(1, -1), ' ');
    const i = ((cycle % options.length) + options.length) % options.length;
    src = options[i];
  }

  parseNode(src, cycle, cycle + 1, out);
  return out;
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd /Users/cory/endless-memory && npm test 2>&1 | grep -E "^(not ok|ok)|# (tests|pass|fail)"
```

Expected: 11 passing, 0 failing — the 8 existing tests plus 3 new ones. Report counts.

If a comparison fails, read the assertion message: it prints the field, the cycle and the
first 120 characters of the pattern. Do not weaken the test to make it pass; the oracle is
right and the parser is wrong.

- [ ] **Step 7: Verify fixtures are untouched**

```bash
cd /Users/cory/endless-memory && git status --porcelain test/fixtures
```

Expected: no output.

- [ ] **Step 8: Commit**

```bash
cd /Users/cory/endless-memory
git add runtime/mini.mjs runtime/mini.test.mjs package.json
git commit -F - <<'MSG'
feat: mini-notation parser for the frozen subset composer.mjs emits

Parses <alternation>, [subdivision], [a,b,c] stacks and ~ rests — the whole
grammar scene() can produce, measured at 6 distinct characters and nesting
depth 2 across 600 consecutive scenes.

Verified against @strudel/mini as oracle over 5000+ comparisons spanning every
voice, plus a weathered journal exercising recall. Strudel stays a
devDependency: nothing in runtime/ imports it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 2: Voice synthesis

**Files:**
- Create: `runtime/voices.mjs`, `runtime/voices.test.mjs`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SR = 48000`, `CYCLE_SECONDS = 240 / 76`
  - `sampleAt(absCycle: number) -> number` — absolute sample index for an absolute cycle position
  - `renderEvents(events, { originSample, lengthSamples }) -> Float32Array`, where each event is `{ wave, freq, attack, decay, sustain, release, cutoff?, hcutoff?, gain, begin, end }` with `begin`/`end` in absolute cycles

**Why this shape:** every sample position and every noise seed derives from **absolute**
musical time, never from a chunk-relative offset. That is what makes Task 4's chunk
invariance possible. A version of this code seeded noise and positioned events relative to
the chunk, and chunked output differed from one-pass output by −23.5 dB at every boundary.

- [ ] **Step 1: Write the failing test**

Create `runtime/voices.test.mjs`:

```javascript
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

test('noise is seeded from absolute position, so the same event renders identically at any origin', () => {
  const evt = note({ wave: 'white', freq: 3000, begin: 4, end: 4.25 });
  const whole = renderEvents([evt], { originSample: sampleAt(4), lengthSamples: sampleAt(5) - sampleAt(4) });
  const shifted = renderEvents([evt], { originSample: sampleAt(4), lengthSamples: sampleAt(6) - sampleAt(4) });
  for (let i = 0; i < whole.length; i++) {
    assert.equal(whole[i], shifted[i], `sample ${i} differs with a different buffer length`);
  }
});

test('a low-pass filter attenuates high frequencies more than low ones', () => {
  const opts = { originSample: 0, lengthSamples: sampleAt(1) };
  const peak = (b) => b.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const low = peak(renderEvents([note({ freq: 200, cutoff: 400 })], opts));
  const high = peak(renderEvents([note({ freq: 8000, cutoff: 400 })], opts));
  assert.ok(high < low * 0.5, `lpf should cut 8k far more than 200Hz (low ${low}, high ${high})`);
});
```

- [ ] **Step 2: Add to the test script**

```json
    "test": "node --test composer.test.mjs export.test.mjs runtime/mini.test.mjs runtime/voices.test.mjs",
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /Users/cory/endless-memory && npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './voices.mjs'`.

- [ ] **Step 4: Write the synthesiser**

Create `runtime/voices.mjs`:

```javascript
// Renders parameterised events to PCM. No dependencies.
//
// Every sample position and every noise seed derives from ABSOLUTE musical time. This is
// deliberate and load-bearing: it is what lets a span be rendered in chunks and come out
// bit-identical to rendering it in one pass (see runtime/render.test.mjs). An earlier
// version positioned events and seeded noise relative to the chunk, and chunked output
// differed from one-pass by -23.5 dB at every boundary.

export const SR = 48000;
export const CYCLE_SECONDS = 240 / 76; // setcps(76/60/4)

export const sampleAt = (absCycle, sampleRate = SR, cycleSeconds = CYCLE_SECONDS) =>
  Math.round(absCycle * cycleSeconds * sampleRate);

const midiToHz = (n) => 440 * Math.pow(2, (n - 69) / 12);
export { midiToHz };

// xorshift32 — deterministic, seeded per event from its absolute sample position.
function makeNoise(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s / 4294967296) * 2 - 1;
  };
}

function envelope(t, dur, { attack = 0.001, decay = 0.05, sustain = 0, release = 0.01 }) {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  if (t < attack + decay) return 1 + (sustain - 1) * ((t - attack) / decay);
  if (t < dur) return sustain;
  const r = t - dur;
  return r < release ? sustain * (1 - r / release) : 0;
}

export function renderEvents(events, { sampleRate = SR, cycleSeconds = CYCLE_SECONDS, originSample = 0, lengthSamples }) {
  const out = new Float32Array(lengthSamples);

  for (const evt of events) {
    const startAbs = sampleAt(evt.begin, sampleRate, cycleSeconds);
    const endAbs = sampleAt(evt.end, sampleRate, cycleSeconds);
    const dur = (endAbs - startAbs) / sampleRate;
    const release = evt.release ?? 0.01;
    const start = startAbs - originSample;
    const total = Math.ceil((dur + release) * sampleRate);
    if (start + total < 0 || start >= lengthSamples) continue;

    const gain = evt.gain ?? 0.2;
    const freq = evt.freq;
    const noise = evt.wave === 'white' ? makeNoise((startAbs * 2654435761) ^ Math.round(freq * 1000)) : null;

    const lpA = evt.cutoff ? 1 - Math.exp((-2 * Math.PI * evt.cutoff) / sampleRate) : null;
    const hpA = evt.hcutoff ? 1 / (1 + (2 * Math.PI * evt.hcutoff) / sampleRate) : null;
    let lpZ = 0, hpY = 0, hpX = 0, phase = 0;
    const increment = freq / sampleRate;

    for (let i = 0; i < total; i++) {
      const t = i / sampleRate;
      const env = envelope(t, dur, evt);

      let x;
      if (noise) x = noise();
      else if (evt.wave === 'triangle') { const p = phase % 1; x = 4 * Math.abs(p - 0.5) - 1; }
      else x = Math.sin(2 * Math.PI * phase);
      phase += increment;

      if (hpA !== null) { const y = hpA * (hpY + x - hpX); hpX = x; hpY = y; x = y; }
      if (lpA !== null) { lpZ += lpA * (x - lpZ); x = lpZ; }

      if (env === 0 && t > dur) break;

      const idx = start + i;
      if (idx >= 0 && idx < lengthSamples) out[idx] += x * env * gain;
    }
  }

  return out;
}
```

Note the loop advances oscillator phase, filter state and the noise generator on **every**
iteration, including samples that fall outside the buffer. Skipping them would make the
output depend on where the buffer happens to start, which is exactly the bug Task 4 guards
against.

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /Users/cory/endless-memory && npm test 2>&1 | grep -E "^(not ok|ok)|# (tests|pass|fail)"
```

Expected: 17 passing, 0 failing. Report counts.

- [ ] **Step 6: Commit**

```bash
cd /Users/cory/endless-memory
git add runtime/voices.mjs runtime/voices.test.mjs package.json
git commit -F - <<'MSG'
feat: dependency-free voice synthesis

Triangle, sine and white-noise sources with ADSR and one-pole low/high-pass
filters — the whole palette VOICES describes.

Sample positions and noise seeds both derive from absolute musical time rather
than a chunk-relative offset. That is load-bearing: it is what makes chunked
rendering bit-identical to one-pass rendering. Oscillator phase, filter state
and the noise generator advance on every iteration including samples outside
the buffer, so output cannot depend on where a buffer starts.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 3: Event scheduling

**Files:**
- Create: `runtime/schedule.mjs`, `runtime/schedule.test.mjs`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `parseCycle` (Task 1); `scene`, `atmosphere`, `VOICES`, `BARS` from `../composer.mjs`.
- Produces: `eventsForCycles(startCycle: number, cycleCount: number, journal) -> Array<event>` where each event is exactly the shape `renderEvents` consumes: `{ wave, freq, attack, decay, sustain, release, cutoff?, hcutoff?, gain, begin, end }`.

- [ ] **Step 1: Write the failing test**

Create `runtime/schedule.test.mjs`. The oracle is the real exported score run through
Strudel, exactly as `composer.test.mjs` does it.

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '@strudel/core';
import { mini } from '@strudel/mini';
import { transpiler } from '@strudel/transpiler';
import { EPOCH, BAR_MS, BARS } from '../composer.mjs';
import { eventsForCycles } from './schedule.mjs';

core.setStringParser(core.pure);

// Build the same pattern the browser would run, from a committed fixture.
function strudelPattern(fixture) {
  const source = readFileSync(new URL(`../test/fixtures/${fixture}.strudel`, import.meta.url), 'utf8');
  const names = ['Pattern', 'stack', 'note', 's'];
  const { output } = transpiler(source, { wrapAsync: false, addReturn: true });
  return new Function(...names, 'setcps', 'mini', output)(...names.map((n) => core[n]), () => {}, mini);
}

// The fixture's own anchor, in cycles, so our absolute cycles line up with its timeline.
function anchorCycle(fixture) {
  const source = readFileSync(new URL(`../test/fixtures/${fixture}.strudel`, import.meta.url), 'utf8');
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

const key = (e) => `${e.begin}|${e.wave}|${e.freq}|${e.gain}`;
const sortEvents = (a) => [...a].sort((x, y) => key(x).localeCompare(key(y)));

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

for (const fixture of Object.keys(JOURNALS)) {
  test(`schedule matches the Strudel score for ${fixture}`, () => {
    const pattern = strudelPattern(fixture);
    const startBar = anchorCycle(fixture);
    const journal = JOURNALS[fixture];

    for (let offset = 0; offset < 40; offset++) {
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
```

- [ ] **Step 2: Add to the test script**

```json
    "test": "node --test composer.test.mjs export.test.mjs runtime/mini.test.mjs runtime/voices.test.mjs runtime/schedule.test.mjs",
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /Users/cory/endless-memory && npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './schedule.mjs'`.

- [ ] **Step 4: Write the scheduler**

Create `runtime/schedule.mjs`:

```javascript
// Joins the score model, the voice table and atmosphere drift into timed events.
// Imports only Node built-ins and ../composer.mjs — never Strudel.

import { scene, atmosphere, VOICES, BARS } from '../composer.mjs';
import { parseCycle } from './mini.mjs';
import { midiToHz } from './voices.mjs';

// One cycle is one bar; scene i covers cycles [i*BARS, (i+1)*BARS).
export const sceneIndexForCycle = (cycle) => Math.floor(cycle / BARS);

function build(voice, parsed, sceneData, drift) {
  const evt = {
    wave: voice.wave,
    attack: voice.attack,
    decay: voice.decay,
    sustain: voice.sustain,
    release: voice.release,
    gain: voice.gain * drift.gain,
    begin: parsed.begin,
    end: parsed.end,
  };

  // 'note' voices carry a MIDI pitch; 's' voices are triggers with a fixed frequency.
  evt.freq = voice.kind === 'note' ? midiToHz(parsed.value) : voice.freq ?? 440;

  let isChords = false;
  for (const filter of voice.filters) {
    const value = filter.dynamic ? sceneData[filter.dynamic] : filter.value;
    if (filter.dynamic) isChords = true;
    if (filter.type === 'lpf') evt.cutoff = value;
    else evt.hcutoff = value;
  }

  // The exported score replaces the chords voice's cutoff and release with the drifting
  // values. Every voice's gain is scaled by drift.gain, applied above.
  if (isChords) {
    evt.cutoff = drift.cutoff;
    evt.release = drift.release;
  }

  return evt;
}

export function eventsForCycles(startCycle, cycleCount, journal) {
  const events = [];
  for (let cycle = startCycle; cycle < startCycle + cycleCount; cycle++) {
    const sceneData = scene(sceneIndexForCycle(cycle), journal);
    const drift = atmosphere(cycle, journal);
    for (const voice of VOICES) {
      for (const parsed of parseCycle(sceneData[voice.field], cycle)) {
        events.push(build(voice, parsed, sceneData, drift));
      }
    }
  }
  return events;
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /Users/cory/endless-memory && npm test 2>&1 | grep -E "^(not ok|ok)|# (tests|pass|fail)"
```

Expected: 20 passing, 0 failing. Report counts.

If the comparison fails on `gain`, check that `drift.gain` multiplies every voice. If it
fails on `cutoff` or `release` for the chords voice only, check the `isChords` branch —
the drift values **replace** the table's values rather than scaling them.

- [ ] **Step 6: Commit**

```bash
cd /Users/cory/endless-memory
git add runtime/schedule.mjs runtime/schedule.test.mjs package.json
git commit -F - <<'MSG'
feat: schedule scene data into parameterised events

Joins scene(), the exported VOICES table and atmosphere() into the event shape
the synthesiser consumes. Selects the chords voice by its dynamic filter rather
than by matching a gain value, which is the magic-number coupling noted in #2.

Verified against the real Strudel score built from both committed fixtures, 40
cycles each, comparing every field of every event. Strudel is the oracle and
stays a devDependency.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 4: Chunked rendering and the invariance proof

**Files:**
- Create: `runtime/render.mjs`, `runtime/render.test.mjs`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `eventsForCycles` (Task 3); `renderEvents`, `sampleAt`, `SR` (Task 2).
- Produces: `renderChunk(startCycle: number, cycleCount: number, journal) -> Float32Array`, covering exactly samples `[sampleAt(startCycle), sampleAt(startCycle + cycleCount))`.

**The point of this task.** Rendering in chunks must be bit-identical to rendering in one
pass. It is the invariant that makes streaming legitimate, and it was violated by the
prototype at −23.5 dB per boundary.

- [ ] **Step 1: Write the failing test**

Create `runtime/render.test.mjs`:

```javascript
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
```

- [ ] **Step 2: Add to the test script**

```json
    "test": "node --test composer.test.mjs export.test.mjs runtime/mini.test.mjs runtime/voices.test.mjs runtime/schedule.test.mjs runtime/render.test.mjs",
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd /Users/cory/endless-memory && npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module './render.mjs'`.

- [ ] **Step 4: Write the chunk renderer**

Create `runtime/render.mjs`:

```javascript
// Chunked rendering. A chunk covers exactly samples [sampleAt(start), sampleAt(start+n)).
//
// PRE_ROLL_CYCLES exists because an event beginning before a chunk can still be sounding
// inside it — a chord spans a full cycle and releases for up to ~0.6s beyond. Querying
// only the chunk's own cycles drops those tails and produces an audible discontinuity at
// every boundary. Two cycles comfortably covers the longest event plus its release.

import { eventsForCycles } from './schedule.mjs';
import { renderEvents, sampleAt } from './voices.mjs';

export const PRE_ROLL_CYCLES = 2;

export function renderChunk(startCycle, cycleCount, journal) {
  const originSample = sampleAt(startCycle);
  const lengthSamples = sampleAt(startCycle + cycleCount) - originSample;

  const from = startCycle - PRE_ROLL_CYCLES;
  const events = eventsForCycles(from, cycleCount + PRE_ROLL_CYCLES, journal);

  return renderEvents(events, { originSample, lengthSamples });
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /Users/cory/endless-memory && npm test 2>&1 | grep -E "^(not ok|ok)|# (tests|pass|fail)"
```

Expected: 25 passing, 0 failing. Report counts.

If a bit-identity assertion fails, the message names the exact sample. Check in this
order, because each was a real cause: positions or noise seeds computed from a
chunk-relative offset rather than absolute time; oscillator or filter state not advanced
for samples outside the buffer; pre-roll too short.

- [ ] **Step 6: Prove the test actually catches the bug it exists for**

Temporarily set `PRE_ROLL_CYCLES = 0` in `runtime/render.mjs`, then:

```bash
cd /Users/cory/endless-memory && npm test 2>&1 | grep -E "# (tests|pass|fail)"
```

Expected: the chunk-invariance tests **fail**. Restore `PRE_ROLL_CYCLES = 2` and re-run:

```bash
cd /Users/cory/endless-memory && npm test 2>&1 | grep -E "# (tests|pass|fail)"
```

Expected: 25 passing, 0 failing. Do not continue until you have watched it fail and pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/cory/endless-memory
git add runtime/render.mjs runtime/render.test.mjs package.json
git commit -F - <<'MSG'
feat: chunked rendering, bit-identical to one-pass

Chunk invariance is the property that makes streaming legitimate, and the
prototype violated it: chunked output differed from one-pass by a maximum
sample difference of 0.119958 (~17% of peak), -23.5 dB relative to signal, at
every boundary. Peak, RMS and silence checks all passed while it was broken.

Tested across chunk sizes 1, 2, 3, 4 and 8, on both quiet and weathered
journals, and across a scene boundary. Verified the test catches its bug by
setting PRE_ROLL_CYCLES to 0 and watching it fail.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 5: CLI, golden audio, and the import guard

**Files:**
- Modify: `runtime/render.mjs` (add `run` and the CLI entry point), `runtime/render.test.mjs`, `package.json`
- Create: `runtime/fixtures/golden-quiet.json`, `runtime/update-golden.mjs`

**Interfaces:**
- Consumes: `renderChunk` (Task 4).
- Produces: `run({ anchorCycle, chunkCycles, sink, onChunk }) -> Promise<void>`; CLI `node runtime/render.mjs --anchor <ISO> --out <path> [--chunk-cycles 8] [--seconds N]`.

- [ ] **Step 1: Write the failing tests**

Append to `runtime/render.test.mjs`:

```javascript
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pcmHash, GOLDEN } from './update-golden.mjs';

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
  for (const file of files) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)) {
      const spec = m[1];
      const ok = spec.startsWith('node:') || spec.startsWith('./') || spec === '../composer.mjs';
      assert.ok(ok, `${file} imports '${spec}' — runtime/ must not depend on packages`);
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
```

- [ ] **Step 2: Write the golden helper**

Create `runtime/update-golden.mjs`:

```javascript
// Golden audio fixture: definition, hashing, and the regenerate entry point.
// Run deliberately with `npm run golden`, and review the resulting diff.

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { BARS } from '../composer.mjs';
import { renderChunk } from './render.mjs';

export const GOLDEN = {
  startCycle: 216813 * BARS,
  cycles: 8,
  journal: { version: 1, seed: 'window-seat-v1', events: [] },
};

export function pcmHash(samples) {
  const hash = createHash('sha256');
  let peak = 0;
  let sumSq = 0;
  const view = new DataView(new ArrayBuffer(4));
  for (const v of samples) {
    view.setFloat32(0, v);
    hash.update(new Uint8Array(view.buffer));
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  return {
    hash: hash.digest('hex'),
    peak: Math.round(peak * 1e9) / 1e9,
    rms: Math.round(Math.sqrt(sumSq / samples.length) * 1e9) / 1e9,
    samples: samples.length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = pcmHash(renderChunk(GOLDEN.startCycle, GOLDEN.cycles, GOLDEN.journal));
  writeFileSync(new URL('./fixtures/golden-quiet.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(`golden-quiet: ${result.samples} samples, peak ${result.peak}, rms ${result.rms}`);
}
```

- [ ] **Step 3: Add `run` and the CLI to `runtime/render.mjs`**

Append to `runtime/render.mjs`:

```javascript
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { EPOCH, BAR_MS, validate } from '../composer.mjs';
import { SR, CYCLE_SECONDS } from './voices.mjs';

export const cycleForInstant = (iso) => Math.floor((Date.parse(iso) - EPOCH) / BAR_MS);

// Dual-mono 16-bit LE. A silent chunk is a bug, not valid output.
function toPcm(samples) {
  const buf = Buffer.alloc(samples.length * 4);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    const s = Math.max(-32768, Math.min(32767, Math.round(Math.tanh(samples[i]) * 32767)));
    buf.writeInt16LE(s, i * 4);
    buf.writeInt16LE(s, i * 4 + 2);
  }
  return { buf, peak };
}

export async function run({ anchorCycle, chunkCycles = 8, sink, seconds = Infinity }) {
  const limit = seconds === Infinity ? Infinity : Math.ceil(seconds / CYCLE_SECONDS);
  let rendered = 0;
  for (let cycle = anchorCycle; rendered < limit; cycle += chunkCycles) {
    const count = Math.min(chunkCycles, limit - rendered);
    const { buf, peak } = toPcm(renderChunk(cycle, count, run.journal));
    if (peak === 0) throw new Error(`silent chunk at cycle ${cycle} — this is a bug, not valid output`);
    if (!sink.write(buf)) await once(sink, 'drain');
    rendered += count;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const journalPath = new URL('../journal.json', import.meta.url);
  const { readFileSync } = await import('node:fs');
  run.journal = validate(JSON.parse(readFileSync(journalPath, 'utf8')));

  const out = arg('out');
  if (!out) throw new Error('usage: node runtime/render.mjs --anchor <ISO> --out <path> [--chunk-cycles 8] [--seconds N]');
  const sink = createWriteStream(out);
  await run({
    anchorCycle: cycleForInstant(arg('anchor', new Date().toISOString())),
    chunkCycles: Number(arg('chunk-cycles', 8)),
    seconds: arg('seconds') ? Number(arg('seconds')) : Infinity,
    sink,
  });
  sink.end();
}
```

Note `run.journal` must be set by the caller; the test sets it via the CLI path. If you
prefer a cleaner signature, pass `journal` through `run(...)` and thread it into
`renderChunk` — just keep the CLI and the test in agreement.

- [ ] **Step 4: Add scripts and run the tests to verify they fail**

In `package.json`, add `"golden": "node runtime/update-golden.mjs"` to `scripts`.

```bash
cd /Users/cory/endless-memory && npm test 2>&1 | tail -20
```

Expected: FAIL — the golden fixture file does not exist yet.

- [ ] **Step 5: Generate the golden fixture**

```bash
cd /Users/cory/endless-memory && mkdir -p runtime/fixtures && npm run golden
```

Expected output names the sample count, peak and rms.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd /Users/cory/endless-memory && npm test 2>&1 | grep -E "^(not ok|ok)|# (tests|pass|fail)"
```

Expected: 28 passing, 0 failing. Report counts.

- [ ] **Step 7: Prove the golden test catches a sound change**

```bash
cd /Users/cory/endless-memory
sed -i '' 's/gain: voice.gain \* drift.gain/gain: voice.gain * drift.gain * 1.01/' runtime/schedule.mjs
npm test 2>&1 | grep -E "# (tests|pass|fail)"
```

Expected: the golden audio test **fails**. Revert and confirm green:

```bash
cd /Users/cory/endless-memory
git checkout runtime/schedule.mjs
npm test 2>&1 | grep -E "# (tests|pass|fail)"
```

Expected: 28 passing, 0 failing.

- [ ] **Step 8: Confirm nothing in the engine moved**

```bash
cd /Users/cory/endless-memory && git status --porcelain test/fixtures composer.mjs
```

Expected: no output. If `composer.mjs` or a fixture changed, the work is wrong.

- [ ] **Step 9: Commit and open a PR**

```bash
cd /Users/cory/endless-memory
git add runtime/ package.json
git commit -F - <<'MSG'
feat: audio runtime CLI, golden audio fixture and import guard

Adds run() and a CLI writing dual-mono 16-bit PCM, a golden fixture pinning the
rendered audio by hash plus peak and rms, a guard asserting runtime/ imports
only node builtins and ../composer.mjs, and a silent-chunk check that treats
silence as a bug rather than valid output.

Verified the golden test catches a 1% gain change, and that composer.mjs and
test/fixtures/ are untouched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
git push -u origin feat/audio-runtime
gh pr create --title "feat: audio runtime (piece C)" --body "Implements docs/superpowers/specs/2026-09-11-audio-runtime-design.md.

Four modules under runtime/: mini-notation parser, voice synthesis, event scheduling, chunked rendering. No runtime dependencies — Strudel stays a devDependency acting as the test oracle.

Chunk invariance is the headline: rendering a span in chunks is bit-identical to rendering it in one pass, tested across five chunk sizes, both journals, and a scene boundary.

Test output:
\`\`\`
# tests 28
# pass 28
# fail 0
\`\`\`
"
```

---

## Self-Review

**1. Spec coverage.**

| Spec requirement | Task |
|---|---|
| `runtime/mini.mjs` parser | 1 |
| `runtime/voices.mjs` synthesis | 2 |
| `runtime/schedule.mjs` with `VOICES` and drift | 3 |
| `runtime/render.mjs` chunk loop | 4 |
| Chunk invariance, all five mechanisms | 2 (absolute positions, absolute noise seed, state advanced outside buffer), 4 (exact sample boundaries, pre-roll) |
| Verification layer 1: differential vs Strudel | 1 (parser), 3 (full events) |
| Verification layer 2: golden audio, hash + bounds | 5 |
| `renderChunk` pure and deterministic | 4 |
| CLI with `--anchor`, `--out`, `--chunk-cycles` | 5 |
| Pacing is the consumer's job | 4, 5 — `run` renders as fast as the sink accepts |
| Fail fast on invalid journal | 5 — CLI calls `validate()` before rendering |
| Silent chunk is a bug | 5 — `run` throws; 4 has a non-silence test |
| Soft clip via `tanh` | 5 — `toPcm` |
| No runtime dependencies | 5 — import guard test |
| 48 kHz, 16-bit, dual-mono | 5 — `toPcm` writes each sample twice |
| Fixtures unchanged | every task's verify step; 5 step 8 |
| Acceptance 1–6 | 1–5 step counts; 4 step 6; 5 step 7; 4 (chunk tests); 5 step 8 |

Out of scope in the spec and absent here, correctly: ffmpeg, HLS, RTMP, Cloudflare Stream, monitoring, supervision, stereo width, live journal reload.

**2. Placeholder scan.** No `TBD`, `TODO`, "implement later", "add appropriate error
handling", or "similar to Task N". Every code step carries real code. The one judgement
call flagged inline is `run.journal` in Task 5 step 3, where the note states the
alternative and the constraint that keeps CLI and test in agreement.

**3. Type consistency.** `parseCycle(pattern, cycle) -> [{value, begin, end}]` is produced
in Task 1 and consumed in Task 3 under those names. `renderEvents(events, {originSample,
lengthSamples})` and `sampleAt(absCycle)` are produced in Task 2 and consumed in Tasks 4
and 5 identically. `eventsForCycles(startCycle, cycleCount, journal)` is produced in Task
3 and consumed in Task 4. `renderChunk(startCycle, cycleCount, journal)` is produced in
Task 4 and consumed in Task 5 and in `update-golden.mjs`. Event field names — `wave`,
`freq`, `attack`, `decay`, `sustain`, `release`, `cutoff`, `hcutoff`, `gain`, `begin`,
`end` — are identical in Task 2's renderer, Task 3's builder, and Task 3's comparison
helpers. `midiToHz` is exported from `voices.mjs` in Task 2 and imported by `schedule.mjs`
in Task 3.

Running test counts: 8 before, then 11, 17, 20, 25, 28. (Task 1's third test was added during review; each later count follows from the test() calls its brief contains.)
