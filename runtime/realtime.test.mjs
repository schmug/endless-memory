import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgress, driftTolerance, assessDrift, parseSilence, assessSilence, assessRssSlope, BYTES_PER_SAMPLE } from './realtime.mjs';
import { SR, CYCLE_SECONDS } from './voices.mjs';

// Captured verbatim from ffmpeg 8.0 driving this repo's renderer, 2026-09-13. The
// format is asserted against a real line rather than an imagined one: ffmpeg 8.0
// added `elapsed=`, and `size=` carries a unit and leading spaces.
const LINE = 'size=      24KiB time=00:00:00.57 bitrate= 335.2kbits/s speed=1.15x elapsed=0:00:00.50';

test('parseProgress reads consumed time and pacing speed from a real ffmpeg progress line', () => {
  assert.deepEqual(parseProgress(LINE), { timeSeconds: 0.57, speed: 1.15 });
});

// The renderer blocks once the pipe fills, so it always runs AHEAD of ffmpeg by at
// most what is in flight: the chunk it is writing plus whatever the pipe holds.
// That bound is the drift tolerance, and it is derived from those two quantities
// rather than picked — a hardcoded constant would silently stop tracking a change
// to --chunk-cycles.
test('driftTolerance is one whole chunk plus the pipe capacity, in seconds of audio', () => {
  const chunkCycles = 8;
  const pipeBytes = 64 * 1024;
  const chunkSeconds = chunkCycles * CYCLE_SECONDS;
  const pipeSeconds = pipeBytes / (SR * BYTES_PER_SAMPLE);

  assert.equal(driftTolerance({ chunkCycles, pipeBytes }), chunkSeconds + pipeSeconds);
});

test('driftTolerance grows with the chunk size, so a larger --chunk-cycles is not read as drift', () => {
  const pipeBytes = 64 * 1024;
  const small = driftTolerance({ chunkCycles: 8, pipeBytes });
  const large = driftTolerance({ chunkCycles: 16, pipeBytes });

  // Compared with a tolerance: the subtraction reassociates the same sum and the
  // last bit moves. The behaviour under test is that the extra chunks are counted,
  // not that IEEE754 rounds a particular way.
  assert.ok(Math.abs((large - small) - 8 * CYCLE_SECONDS) < 1e-9);
});

// The failure this whole check exists to catch: if -re does not apply backpressure,
// the renderer runs free at ~109x and produces hours of audio in minutes. That looks
// like a wildly positive drift, and it must not read as success just because the
// process exited 0 and the file was non-empty.
test('a renderer running free of backpressure fails, however clean its exit', () => {
  const verdict = assessDrift({ producedSeconds: 3600, elapsedSeconds: 40, tolerance: 25.6 });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /ahead/);
});

// The opposite failure, and the one that would be audible on air: the renderer
// cannot keep up, ffmpeg starves, and the stream has a hole in it.
test('a renderer that starves the encoder fails', () => {
  const verdict = assessDrift({ producedSeconds: 100, elapsedSeconds: 400, tolerance: 25.6 });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /behind/);
});

// The passing shape, for completeness: ahead by less than what the pipe and the
// in-flight chunk can hold is exactly what a working -re pipeline looks like.
test('a renderer ahead by less than the in-flight bound passes', () => {
  const verdict = assessDrift({ producedSeconds: 3622.1, elapsedSeconds: 3600, tolerance: 25.6 });

  assert.equal(verdict.ok, true);
  assert.ok(verdict.aheadSeconds > 0);
});

// Captured verbatim from ffmpeg 8.0's silencedetect, 2026-09-13. Silence is measured
// on the OUTPUT FILE rather than trusted from render.mjs, whose own guard throws on
// the first silent chunk — a count that only ever reads zero because the process died
// proves nothing. endurance.mjs:20-23 records the same reasoning for its sink.
const SILENCE_STDERR = [
  '[silencedetect @ 0x130711450] silence_start: 2',
  '[silencedetect @ 0x130711450] silence_end: 5 | silence_duration: 3',
].join('\n');

test('parseSilence reads a completed silent stretch out of silencedetect output', () => {
  assert.deepEqual(parseSilence(SILENCE_STDERR), [{ start: 2, end: 5, duration: 3 }]);
});

// A silence that never ends has no silence_end line — the stream simply stopped
// producing sound and stayed that way. On air that is the worst case, not a lesser
// one, so it must not be reported as a shorter stretch or dropped for lacking a
// duration.
test('silence running to the end of the stream is reported as dead air, not a plain stretch', () => {
  const stretches = parseSilence('[silencedetect @ 0x1] silence_start: 1200');
  const verdict = assessSilence(stretches);

  assert.equal(verdict.ok, false);
  assert.equal(verdict.deadAir, true);
  assert.match(verdict.reason, /never recovered/);
});

test('no silent stretches passes', () => {
  assert.deepEqual(assessSilence([]), { ok: true, count: 0, deadAir: false, reason: 'no silent stretches' });
});

// endurance.mjs's 2 MB/h threshold is calibrated on a 24-hour run whose warm-up
// finishes well inside the first phase. Applied to a short run it measures the GC
// sawtooth instead: a real 5-minute validation run on 2026-09-13 swung 61→118→80 MB
// and fitted to +83 MB/h, which says nothing about a leak. Refusing to judge a run
// too short to judge is the same defence endurance.mjs:14-18 built for warm-up.
test('the RSS slope is reported but not judged on a run too short to fit a trend', () => {
  const verdict = assessRssSlope({ slopeBytesPerHour: 83 * 1024 * 1024, wallSeconds: 300 });

  assert.equal(verdict.ok, true);
  assert.equal(verdict.assessed, false);
  assert.match(verdict.reason, /too short/);
});

test('the RSS slope is judged once the run is long enough, and a real leak fails', () => {
  const verdict = assessRssSlope({ slopeBytesPerHour: 83 * 1024 * 1024, wallSeconds: 3 * 3600 });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.assessed, true);
});

// A NaN slope is what linearSlope returns when the points determine no line. It must
// not be silently read as "flat, therefore passing".
test('an unfittable slope is not reported as a pass', () => {
  const verdict = assessRssSlope({ slopeBytesPerHour: NaN, wallSeconds: 3 * 3600 });

  assert.equal(verdict.assessed, false);
});
