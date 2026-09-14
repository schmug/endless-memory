import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { BARS, VOICES, scene } from '../composer.mjs';
import { sampleAt, CYCLE_SECONDS } from './voices.mjs';
import { renderChunk, toPcm, isSilent, run, PRE_ROLL_CYCLES, REPORT_EVERY_CHUNKS } from './render.mjs';
import { pcmHash, GOLDEN } from './update-golden.mjs';

const QUIET = { version: 1, seed: 'window-seat-v1', events: [] };
const WEATHERED = {
  version: 1, seed: 'window-seat-v1',
  events: [
    { id: 'fixture-remember-1', at: '2026-09-09T12:00:00Z', type: 'remember', motif: 'm8329137' },
    { id: 'fixture-weather-1', at: '2026-09-10T18:00:00Z', type: 'weather', value: 'rain' },
  ],
};

// Every test below that spawns the CLI passes --journal. Without it render.mjs reads
// the repo's own journal.json, so an unrelated edit to that data file turned these
// tests red for reasons that had nothing to do with the renderer (#20). QUIET is what
// the repo journal holds today, so the audio these tests assert on is unchanged.
const work = mkdtempSync(join(tmpdir(), 'em-render-'));
const JOURNAL = join(work, 'journal.json');
writeFileSync(JOURNAL, JSON.stringify(QUIET, null, 2) + '\n');
after(() => rmSync(work, { recursive: true, force: true }));

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
  // A scene boundary falls every BARS cycles; straddle one. Sizes 4 and 8 are the
  // ones that matter most: in production chunkCycles is 8 and BARS is 32, so every
  // fourth chunk boundary IS a scene boundary — the most common alignment. With
  // start = boundary - 4, a chunk size of 4 lands a boundary exactly on the scene
  // edge (start + 4 === the scene boundary).
  const start = 216813 * BARS - 4;
  const onePass = renderChunk(start, 12, QUIET);
  for (const size of [3, 4, 8]) {
    assertIdentical(chunked(start, 12, size, QUIET), onePass, `scene boundary chunk size ${size}`);
  }
});

// The scene-boundary test above crosses 216812 -> 216813, where both scenes carry
// motif m7050732 and weather clear: a boundary at which nothing the listener would
// notice changes. The two parameterised spans cross no boundary at all — span 16 from
// a multiple of BARS (32) stays inside one scene. So the spec's acceptance criterion
// 3b (chunk-invariance "across ... motif handoffs and weather changes") had no test
// behind it until the two below. Both pin an index and then assert the property that
// index is chosen for, so neither can silently decay into another flat boundary if
// the score model shifts.

test('chunked rendering is bit-identical across a motif handoff', () => {
  // 216385 -> 216386 hands off m90395206 -> m8329137 with weather rain on both sides,
  // which isolates the motif change. This is the path PRE_ROLL_CYCLES makes
  // interesting: each chunk pulls the two preceding cycles, so a chunk starting just
  // after the boundary reaches back into a scene whose pattern content is genuinely
  // different — different degrees, and a transitioning melody blending the old motif.
  const index = 216386;
  assert.notEqual(scene(index, WEATHERED).motif, scene(index - 1, WEATHERED).motif,
    `scene ${index} must hand off to a new motif for this test to mean anything`);

  // start = boundary - 4 puts a size-4 chunk edge exactly on the scene edge, as the
  // scene-boundary test above does.
  const start = index * BARS - 4;
  const onePass = renderChunk(start, 12, WEATHERED);
  for (const size of [3, 4, 8]) {
    assertIdentical(chunked(start, 12, size, WEATHERED), onePass, `motif handoff chunk size ${size}`);
  }
});

test('chunked rendering is bit-identical across a weather change', () => {
  // 216101 -> 216102 is where WEATHERED's rain observation first takes effect. What
  // the renderer actually hears is atmosphere()'s target switching at that bar: the
  // chords cutoff drifts about -2.8 Hz/bar before it and about -10.9 Hz/bar after.
  // Drift is sampled per event onset, so a chunk edge landing on that switch is the
  // case worth pinning.
  //
  // The motif necessarily moves here too — identity() seeds the born motif with the
  // active weather event's id, so no weather change in this model leaves the motif
  // alone. That is not a mis-targeted index; the weather path under test is
  // atmosphere(), which reads only the bar and the journal.
  const index = 216102;
  assert.notEqual(scene(index, WEATHERED).weather, scene(index - 1, WEATHERED).weather,
    `scene ${index} must change weather for this test to mean anything`);

  const start = index * BARS - 4;
  const onePass = renderChunk(start, 12, WEATHERED);
  for (const size of [3, 4, 8]) {
    assertIdentical(chunked(start, 12, size, WEATHERED), onePass, `weather change chunk size ${size}`);
  }
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
  // Discovered, not hardcoded — a new production module in runtime/ must not be
  // able to silently skip this guard.
  const files = readdirSync(new URL('.', import.meta.url))
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'update-golden.mjs');
  assert.ok(files.length > 0, 'expected to discover at least one runtime/ production module');
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
  // A banner printed on import (this project has already hit @strudel/core's
  // 149-byte stdout banner) goes to *stdout*, never touching the output file.
  // Capture and check the child's stdout directly, not just the file.
  const out = `${process.env.TMPDIR ?? '/tmp'}/em-cli-${process.pid}.raw`;
  const stdout = execFileSync(process.execPath, [
    new URL('./render.mjs', import.meta.url).pathname,
    '--anchor', '2026-09-11T14:00:00Z', '--out', out, '--seconds', '6',
    '--journal', JOURNAL,
  ], { stdio: 'pipe' });
  assert.equal(stdout.length, 0, `expected no stdout output when writing to a file, got ${stdout.length} bytes`);
  const buf = readFileSync(out);
  assert.equal(buf.length % 4, 0, 'expected whole 16-bit stereo frames');
  assert.ok(buf.length > 6 * 48000 * 4 * 0.9, `expected ~6s of audio, got ${buf.length} bytes`);
  let peak = 0;
  for (let i = 0; i < buf.length; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)) / 32768);
  assert.ok(peak > 0.01, `expected audible output, peak ${peak}`);
});

test('the CLI writes clean PCM to /dev/stdout itself, not just to a file', () => {
  const stdout = execFileSync(process.execPath, [
    new URL('./render.mjs', import.meta.url).pathname,
    '--anchor', '2026-09-11T14:00:00Z', '--out', '/dev/stdout', '--seconds', '6',
    '--journal', JOURNAL,
  ], { stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(stdout.length % 4, 0, 'expected whole 16-bit stereo frames on stdout');
  assert.ok(stdout.length > 6 * 48000 * 4 * 0.9, `expected ~6s of audio on stdout, got ${stdout.length} bytes`);
  let peak = 0;
  for (let i = 0; i < stdout.length; i += 2) peak = Math.max(peak, Math.abs(stdout.readInt16LE(i)) / 32768);
  assert.ok(peak > 0.01, `expected audible output on stdout, peak ${peak}`);
});

// `-` is the spelling the broadcast pipeline uses. It must reach fd 1 without
// reopening a path: on Linux /dev/stdout is /proc/self/fd/1 and libuv backs child
// stdio with a socketpair, where open() returns ENXIO. That failure is invisible on
// macOS, so this test only bites in CI — which is exactly where it needs to.
test('the CLI accepts - as stdout and writes whole PCM frames there', () => {
  const stdout = execFileSync(process.execPath, [
    new URL('./render.mjs', import.meta.url).pathname,
    '--anchor', '2026-09-11T14:00:00Z', '--out', '-', '--seconds', '6',
    '--journal', JOURNAL,
  ], { stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(stdout.length % 4, 0, 'expected whole 16-bit stereo frames on stdout');
  assert.ok(stdout.length > 6 * 48000 * 4 * 0.9, `expected ~6s of audio on stdout, got ${stdout.length} bytes`);
  let peak = 0;
  for (let i = 0; i < stdout.length; i += 2) peak = Math.max(peak, Math.abs(stdout.readInt16LE(i)) / 32768);
  assert.ok(peak > 0.01, `expected audible output on stdout, peak ${peak}`);
});

// The production streaming path omits --seconds, so run()'s loop never exits and
// anything reported after it is reported never (#12). Drive a real unbounded run,
// stop it once it is well past a reporting interval, and check the summary arrived —
// on stderr, because stdout is carrying the PCM.
test('an unbounded run reports peak and clipping on stderr while still streaming', async () => {
  const child = spawn(process.execPath, [
    new URL('./render.mjs', import.meta.url).pathname,
    '--anchor', '2026-09-11T14:00:00Z', '--out', '-', '--chunk-cycles', '1',
    '--journal', JOURNAL,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // One chunk-cycle of dual-mono 16-bit frames; stop two intervals in, by which point
  // a working periodic report has fired at least once.
  const chunkBytes = (sampleAt(1) - sampleAt(0)) * 4;
  let pcmBytes = 0;
  let stdoutTail = Buffer.alloc(0);
  let strayOnStdout = false;
  let stderr = '';
  child.stdout.on('data', (d) => {
    // Join across writes: a summary misrouted to fd 1 could straddle a chunk boundary.
    const scan = Buffer.concat([stdoutTail, d]);
    if (scan.includes('render:')) strayOnStdout = true;
    stdoutTail = scan.subarray(Math.max(0, scan.length - 16));
    pcmBytes += d.length;
    if (pcmBytes > 2 * REPORT_EVERY_CHUNKS * chunkBytes) child.kill();
  });
  child.stderr.on('data', (d) => { stderr += d; });
  await once(child, 'exit');

  assert.ok(pcmBytes > REPORT_EVERY_CHUNKS * chunkBytes,
    `expected the child to stream past a reporting interval, got ${pcmBytes} bytes; stderr: ${stderr}`);
  assert.match(stderr, /render: \+\d+ cycles since last report/,
    `expected a periodic summary during an unbounded run, got stderr: ${stderr}`);
  assert.ok(!strayOnStdout, 'the summary must go to stderr — stdout is the PCM channel');
});

test('the CLI reports a clear error for an unparseable --anchor, not a NaN cycle', () => {
  const out = `${process.env.TMPDIR ?? '/tmp'}/em-cli-badanchor-${process.pid}.raw`;
  assert.throws(
    () => {
      execFileSync(process.execPath, [
        new URL('./render.mjs', import.meta.url).pathname,
        '--anchor', 'not-a-date', '--out', out, '--seconds', '1',
        '--journal', JOURNAL,
      ], { stdio: 'pipe' });
    },
    (err) => {
      const stderr = err.stderr.toString();
      assert.ok(stderr.includes('not-a-date'), `expected error naming the bad anchor, got: ${stderr}`);
      assert.ok(!stderr.includes('NaN'), `expected no leaked NaN, got: ${stderr}`);
      return true;
    },
  );
});

// Without this the suite cannot tell a wired-up --journal from an ignored one: if the
// flag were dropped, every test above would quietly fall back to the repo's valid
// journal.json and still pass, restoring the coupling #20 removed. An invalid journal
// at the flag's path must therefore be the journal that gets read.
test('the CLI reads the journal --journal names, not the repo default', () => {
  const badPath = join(work, 'invalid-journal.json');
  writeFileSync(badPath, JSON.stringify({
    version: 1, seed: 'x',
    events: [{ id: 'bad-1', at: 'not-a-date', type: 'weather', value: 'rain' }],
  }));
  assert.throws(
    () => {
      execFileSync(process.execPath, [
        new URL('./render.mjs', import.meta.url).pathname,
        '--anchor', '2026-09-11T14:00:00Z', '--out', '-', '--seconds', '1',
        '--journal', badPath,
      ], { stdio: 'pipe' });
    },
    (err) => {
      assert.match(err.stderr.toString(), /Invalid or duplicate event/,
        `expected the journal at --journal to be validated, got: ${err.stderr}`);
      return true;
    },
  );
});

test('toPcm counts pre-clip over-unity samples and stays 0 when none clip', () => {
  const quiet = new Float32Array([0.1, -0.2, 0.05, 0.999]);
  assert.equal(toPcm(quiet).clipped, 0, 'no sample exceeds unity, so nothing should be counted as clipped');
  const loud = new Float32Array([1.5, -2.0, 0.1, 0.99, 1.0001]);
  assert.equal(toPcm(loud).clipped, 3, 'exactly the three samples over |1.0| should be counted');
});

test('isSilent trips on NaN as well as on zero, but not on an audible peak', () => {
  // NaN === 0 is false, so the old `peak === 0` guard would have let a NaN peak
  // through; !(NaN > 0) is true, so isSilent catches it.
  assert.equal(isSilent(0), true);
  assert.equal(isSilent(NaN), true);
  assert.equal(isSilent(0.01), false);
});

test('run() validates the journal, rejecting an invalid one before rendering', async () => {
  const sink = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const badJournal = {
    version: 1, seed: 'x',
    events: [{ id: 'bad-1', at: 'not-a-date', type: 'weather', value: 'rain' }],
  };
  await assert.rejects(
    run({ anchorCycle: 216813 * BARS, chunkCycles: 1, seconds: CYCLE_SECONDS, sink, journal: badJournal }),
    /Invalid or duplicate event/,
  );
});

test('PRE_ROLL_CYCLES covers the longest possible event duration plus release', () => {
  // Worst case is an unsubdivided event spanning a full cycle (duration === CYCLE_SECONDS;
  // parseCycle can never produce a span wider than one cycle). The chords voice's release
  // is replaced at render time by atmosphere().release, whose maximum is .6 + .045 — use
  // that upper bound, not the VOICES table's static .6, which chords never actually uses.
  const CHORDS_RELEASE_UPPER_BOUND = 0.6 + 0.045;
  const maxRelease = Math.max(
    ...VOICES.map((v) => (v.field === 'chords' ? CHORDS_RELEASE_UPPER_BOUND : v.release)),
  );
  const worstCase = CYCLE_SECONDS + maxRelease;
  assert.ok(
    worstCase < PRE_ROLL_CYCLES * CYCLE_SECONDS,
    `worst case duration+release (${worstCase}s) must fit under ${PRE_ROLL_CYCLES} pre-roll cycles (${PRE_ROLL_CYCLES * CYCLE_SECONDS}s)`,
  );
});
