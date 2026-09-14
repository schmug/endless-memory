import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEbur128Summary, assessLevels, LOUDNESS_BAND_LUFS, MAX_TRUE_PEAK_DBFS, SOURCE_LEVELS,
  parseProgressRecords, intervalSpeeds, assessStarvation, startupOffsetSeconds,
  STARVATION_FLOOR, skewFromPackets, assessAvSkew, GOP_SECONDS, FORBIDDEN_FILTERS,
  assessFeederOutage, detectStall, assessStall,
} from './measure.mjs';

// Captured verbatim from the tier-0 invocation on ffmpeg 8.0, 2026-09-14. ebur128
// prints this block once, at the END of a run, and only at AV_LOG_INFO.
const SUMMARY = `[Parsed_ebur128_3 @ 0x124e060d0] Summary:

  Integrated loudness:
    I:         -19.9 LUFS
    Threshold: -29.9 LUFS

  Loudness range:
    LRA:         1.0 LU
    Threshold: -39.9 LUFS
    LRA low:   -20.4 LUFS
    LRA high:  -19.3 LUFS

  True peak:
    Peak:       -4.3 dBFS
[out#0/flv @ 0x144f11ae0] video:53KiB audio:954KiB subtitle:0KiB other streams:0KiB`;

test('parseEbur128Summary reads integrated loudness, range and true peak from a real summary', () => {
  assert.deepEqual(parseEbur128Summary(SUMMARY), { integratedLufs: -19.9, lra: 1.0, truePeakDbfs: -4.3 });
});

// The trap this parser exists to make visible. ebur128's summary is logged at
// AV_LOG_INFO, so the spec's production `-loglevel warning` suppresses it entirely and
// the run produces no loudness figure at all. A parser that quietly returned zeroes
// would turn that into a passing measurement.
test('a run whose loglevel suppressed the summary reports no measurement, not a zero one', () => {
  assert.equal(parseEbur128Summary('frame= 1231 fps= 25 q=-1.0 Lsize= 1064KiB'), null);
  assert.equal(parseEbur128Summary(''), null);
});

// The spec's recorded source figures: -20.0 LUFS day / -19.7 night, true peak -4.3 dBFS.
test('the levels the spec recorded at the source pass the band they set', () => {
  assert.equal(assessLevels({ integratedLufs: -20.0, truePeakDbfs: -4.3 }).ok, true);
  assert.equal(assessLevels({ integratedLufs: -19.7, truePeakDbfs: -4.1 }).ok, true);
});

// "If true peak is ever observed above -1 dBTP, or the clipped counter is ever nonzero,
// that is a renderer bug to investigate, not a level to correct downstream."
test('a true peak above the ceiling fails, and says it is a renderer question', () => {
  const verdict = assessLevels({ integratedLufs: -20.0, truePeakDbfs: -0.4 });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /renderer/);
});

test('loudness outside the band fails in both directions', () => {
  assert.equal(assessLevels({ integratedLufs: -14.0, truePeakDbfs: -4.3 }).ok, false);
  assert.equal(assessLevels({ integratedLufs: -30.0, truePeakDbfs: -4.3 }).ok, false);
  assert.deepEqual(LOUDNESS_BAND_LUFS, [-22, -18]);
  assert.equal(MAX_TRUE_PEAK_DBFS, -1);
});

test('a missing measurement is not a passing one', () => {
  assert.equal(assessLevels(null).ok, false);
});

// The spec measured the SOURCE PCM at -20.0 LUFS day / -19.7 night, true peak -4.3
// dBFS. What tier 0 measures is the same signal after asplit, so the two should agree:
// a gap means the graph is not passing samples through unaltered, which is the whole
// thing ebur128-off-an-asplit is there to demonstrate.
test('the report states how far the encoded run sits from the recorded source levels', () => {
  const verdict = assessLevels({ integratedLufs: -19.9, truePeakDbfs: -4.3 });

  assert.deepEqual(SOURCE_LEVELS, { integratedLufs: -20.0, truePeakDbfs: -4.3 });
  assert.ok(Math.abs(verdict.integratedDeltaLu - 0.1) < 1e-9, `delta was ${verdict.integratedDeltaLu}`);
  assert.equal(verdict.truePeakDeltaDb, 0);
  assert.match(verdict.reason, /source/);
});

// Captured verbatim from the same run. ffmpeg 8.0 emits these \r-separated on one
// line, and `elapsed=` is what makes an interval reading possible at all.
const PROGRESS = [
  'frame=   40 fps=4.0 q=18.0 size=      33KiB time=00:00:01.30 bitrate= 210.3kbits/s speed=0.13x elapsed=0:00:10.00    ',
  'frame=  354 fps= 18 q=14.0 size=     256KiB time=00:00:11.73 bitrate= 178.7kbits/s speed=0.586x elapsed=0:00:20.01    ',
  'frame=  654 fps= 22 q=14.0 size=     512KiB time=00:00:21.73 bitrate= 193.0kbits/s speed=0.724x elapsed=0:00:30.02    ',
  'frame=  954 fps= 24 q=14.0 size=     768KiB time=00:00:31.73 bitrate= 198.3kbits/s speed=0.793x elapsed=0:00:40.02    ',
].join('\r');

test('parseProgressRecords reads elapsed alongside time and speed', () => {
  const records = parseProgressRecords(PROGRESS);

  assert.equal(records.length, 4);
  assert.deepEqual(records[1], { timeSeconds: 11.73, speed: 0.586, elapsedSeconds: 20.01 });
});

// The measurement this module exists for. Observed 2026-09-14: ffmpeg takes a fixed
// ~8s to get the video input running, and the CUMULATIVE speed it prints therefore
// climbs 0.13 -> 0.59 -> 0.72 -> 0.79 while the pipeline is perfectly healthy. Reading
// starvation off that number calls a working stream starved for its first few minutes.
// Between consecutive records the same run paces at exactly 1.000x.
test('interval speeds read 1x on a healthy run whose cumulative speed still says 0.79x', () => {
  const records = parseProgressRecords(PROGRESS);
  const intervals = intervalSpeeds(records);

  assert.equal(intervals.length, 3);
  assert.equal(records[records.length - 1].speed, 0.793);
  for (const i of intervals.slice(1)) {
    assert.ok(Math.abs(i.speed - 1) < 0.01, `interval speed ${i.speed} is not 1x`);
  }
});

test('the startup offset is reported as its own figure, not folded into drift', () => {
  assert.ok(Math.abs(startupOffsetSeconds(parseProgressRecords(PROGRESS)) - 8.7) < 0.01);
});

// `speed` below 1.0 while renderer progress lines keep arriving points at VIDEO
// STARVATION — the diagnostic the seam design makes possible, and the one way a
// picture problem takes the station off the air.
test('a sustained interval dip below the floor is reported as starvation', () => {
  const intervals = [
    { fromSeconds: 10, toSeconds: 20, speed: 1.0 },
    { fromSeconds: 20, toSeconds: 30, speed: 0.80 },
    { fromSeconds: 30, toSeconds: 40, speed: 0.82 },
  ];
  const verdict = assessStarvation(intervals, { skipSeconds: 0 });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.worst.speed, 0.80);
  assert.match(verdict.reason, /starv/i);
  assert.equal(STARVATION_FLOOR, 0.97);
});

// The first interval covers ffmpeg's startup, where the video input is still coming up
// and the reading means nothing. Judging it would fail every healthy run.
test('the warm-up window is excluded rather than judged', () => {
  const intervals = [
    { fromSeconds: 0, toSeconds: 10, speed: 0.13 },
    { fromSeconds: 10, toSeconds: 20, speed: 1.0 },
  ];

  assert.equal(assessStarvation(intervals, { skipSeconds: 10 }).ok, true);
  assert.equal(assessStarvation(intervals, { skipSeconds: 0 }).ok, false);
});

test('a run with no assessable intervals is not reported as a pass', () => {
  assert.equal(assessStarvation([], { skipSeconds: 10 }).ok, false);
  assert.equal(assessStarvation([{ fromSeconds: 0, toSeconds: 5, speed: 1 }], { skipSeconds: 10 }).ok, false);
});

// Measured 2026-09-14: killing the video feeder for 5s dipped pacing to 0.650x for the
// interval that contained the outage, and the audio still ran to the full length of the
// run with no silent stretch. The dip is the deliberate outage showing up, not the
// pipeline starving on its own, so the induced window is excluded from the starvation
// verdict — and reported separately by assessFeederOutage, never swallowed.
test('an interval inside a deliberately induced outage is excluded from the starvation verdict', () => {
  const intervals = [
    { fromSeconds: 30, toSeconds: 40, speed: 1.0 },
    { fromSeconds: 40, toSeconds: 50, speed: 0.65 },
    { fromSeconds: 50, toSeconds: 60, speed: 1.4 },
  ];

  assert.equal(assessStarvation(intervals, { skipSeconds: 0 }).ok, false);
  assert.equal(assessStarvation(intervals, { skipSeconds: 0, excludeWindows: [[45, 50]] }).ok, true);
});

test('a dip outside every excluded window still fails', () => {
  const intervals = [
    { fromSeconds: 30, toSeconds: 40, speed: 0.5 },
    { fromSeconds: 40, toSeconds: 50, speed: 1.0 },
  ];

  assert.equal(assessStarvation(intervals, { skipSeconds: 0, excludeWindows: [[45, 50]] }).ok, false);
});

// Criterion 6 is about survival, so what is judged is RECOVERY, not the dip. The dip is
// reported as the measured cost of a feeder outage — the number that says how much a
// picture problem can move the audio before the fifo holder fd catches it.
test('a feeder outage reports its pacing cost and passes on recovery', () => {
  const intervals = [
    { fromSeconds: 30, toSeconds: 40, speed: 1.0 },
    { fromSeconds: 40, toSeconds: 50, speed: 0.65 },
    { fromSeconds: 50, toSeconds: 60, speed: 1.4 },
  ];
  const verdict = assessFeederOutage({ intervals, killedAtSeconds: 45, restartedAtSeconds: 50 });

  assert.equal(verdict.ok, true);
  assert.equal(verdict.dipSpeed, 0.65);
  assert.equal(verdict.recoveredBySeconds, 60);
});

test('a feeder outage that pacing never recovered from fails', () => {
  const intervals = [
    { fromSeconds: 40, toSeconds: 50, speed: 0.65 },
    { fromSeconds: 50, toSeconds: 60, speed: 0.61 },
    { fromSeconds: 60, toSeconds: 70, speed: 0.60 },
  ];
  const verdict = assessFeederOutage({ intervals, killedAtSeconds: 45, restartedAtSeconds: 50 });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /never recovered/);
});

test('a run with no feeder outage reports no outage rather than a passing measurement', () => {
  const verdict = assessFeederOutage({ intervals: [], killedAtSeconds: null, restartedAtSeconds: null });

  assert.equal(verdict.attempted, false);
  assert.equal(verdict.ok, true);
});

// ffprobe -show_entries packet=stream_index,pts_time -of json, captured 2026-09-14.
// Video is stream 0, audio stream 1 — the order -map puts them in.
const PACKETS = {
  packets: [
    { stream_index: 0, pts_time: '38.067000' },
    { stream_index: 1, pts_time: '38.019000' },
    { stream_index: 0, pts_time: '40.900000' },
    { stream_index: 1, pts_time: '40.963000' },
  ],
};

test('skewFromPackets is how far video leads audio at the far edge of a window', () => {
  assert.ok(Math.abs(skewFromPackets(PACKETS, { video: 0, audio: 1 }) - (40.9 - 40.963)) < 1e-9);
});

test('a window with only one stream in it yields no skew rather than a fabricated zero', () => {
  assert.equal(skewFromPackets({ packets: [{ stream_index: 0, pts_time: '1.0' }] }, { video: 0, audio: 1 }), null);
});

// Audio is the clock; video is fitted to audio. Two independent -re pacers can drift
// against each other over a long run, and CFR fps=30 is BELIEVED to absorb it. This
// measures the belief. The bound is quantisation, not perception: each window's skew
// is fixed by where its edge falls inside a GOP, so a growth figure carries up to one
// GOP of error at each end.
test('A/V skew that does not grow across the run passes', () => {
  const verdict = assessAvSkew({ startSkew: -0.05, endSkew: -0.06 });

  assert.equal(verdict.ok, true);
  assert.ok(Math.abs(verdict.growthSeconds - -0.01) < 1e-9);
  assert.equal(verdict.boundSeconds, 2 * GOP_SECONDS);
});

test('skew that grows past the quantisation bound fails', () => {
  assert.equal(assessAvSkew({ startSkew: 0, endSkew: 9 }).ok, false);
  assert.equal(assessAvSkew({ startSkew: 0, endSkew: -9 }).ok, false);
});

test('an unmeasurable skew is not a passing one', () => {
  assert.equal(assessAvSkew({ startSkew: null, endSkew: -0.06 }).ok, false);
});

test('the forbidden filter list is the one the spec names permanently forbidden', () => {
  assert.deepEqual([...FORBIDDEN_FILTERS].sort(), ['acompressor', 'alimiter', 'aresample=async', 'atempo', 'loudnorm'].sort());
});

// Observed 2026-09-14, 31 minutes into a 60-minute run, 90 seconds after the video
// feeder was killed and restarted: ffmpeg's output clock froze at 1791s and never moved
// again. Every process stayed alive — renderer, ffmpeg, videofeed, stream.sh — and every
// ffmpeg thread (both demuxers, the filter chain, both encoders, the muxer) sat in
// __psynch_cvwait, so nothing was blocked on a pipe read. RSS crept 350.3 -> 352.2 MB as
// buffers filled behind the wedge.
//
// This is worse than a crash: nothing exits, so pipefail never fires, -shortest never
// fires, and Restart=always never fires. A supervisor watching process liveness sees a
// healthy unit over dead air. The only thing that catches it is watching OUTPUT advance.
test('a frozen output clock is a stall, however alive the processes are', () => {
  const records = [
    { elapsedSeconds: 1700, timeSeconds: 1682, speed: 0.99 },
    { elapsedSeconds: 1800, timeSeconds: 1782, speed: 0.99 },
    { elapsedSeconds: 1860, timeSeconds: 1791, speed: 0.97 },
    { elapsedSeconds: 1920, timeSeconds: 1791, speed: 0.94 },
    { elapsedSeconds: 1980, timeSeconds: 1791, speed: 0.91 },
  ];
  const verdict = detectStall(records, { stallSeconds: 120 });

  assert.equal(verdict.stalled, true);
  assert.equal(verdict.frozenAtSeconds, 1791);
  assert.ok(verdict.stalledForSeconds >= 120, `only ${verdict.stalledForSeconds}s`);
});

test('a clock still advancing is not a stall, even when it is behind', () => {
  const records = [
    { elapsedSeconds: 1800, timeSeconds: 1782, speed: 0.99 },
    { elapsedSeconds: 1920, timeSeconds: 1899, speed: 0.98 },
    { elapsedSeconds: 2040, timeSeconds: 2019, speed: 0.98 },
  ];

  assert.equal(detectStall(records, { stallSeconds: 120 }).stalled, false);
});

// A freeze shorter than the window is the feeder outage being absorbed, which the
// 2-minute run showed recovering. Calling that a stall would fail every criterion-6
// demonstration.
test('a brief freeze inside the window is not yet a stall', () => {
  const records = [
    { elapsedSeconds: 1800, timeSeconds: 1782, speed: 0.99 },
    { elapsedSeconds: 1830, timeSeconds: 1791, speed: 0.98 },
    { elapsedSeconds: 1860, timeSeconds: 1791, speed: 0.97 },
  ];

  assert.equal(detectStall(records, { stallSeconds: 120 }).stalled, false);
});

test('too few records to judge is not a stall', () => {
  assert.equal(detectStall([], { stallSeconds: 120 }).stalled, false);
  assert.equal(detectStall([{ elapsedSeconds: 10, timeSeconds: 2, speed: 0.2 }], { stallSeconds: 120 }).stalled, false);
});

// The verdict a stalled run must carry, so it reports FAIL instead of hanging forever.
test('a stall is a failure that names dead air, not a slow run', () => {
  const verdict = assessStall({ stalled: true, frozenAtSeconds: 1791, stalledForSeconds: 180, sinceSeconds: 1860 });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /dead air|stall/i);
  assert.match(verdict.reason, /1791/);
});

test('no stall passes', () => {
  assert.equal(assessStall({ stalled: false }).ok, true);
});
