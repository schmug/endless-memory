// What the tier-0 run measures, separated from the running of it so the parsers and
// verdicts can be tested against captured ffmpeg output instead of a live pipeline.
//
// Drift, silence and the RSS slope are NOT here: runtime/realtime.mjs already derives
// and judges them, and the tier-0 harness imports that rather than restating a bound
// it would then have to keep in step.

import { parseProgress, assessRssSlope } from '../runtime/realtime.mjs';

// Named permanently forbidden by the broadcast spec. Every one alters samples, and the
// sound is listener-approved: if one ever becomes necessary it is a sound change with a
// listening pass, governed by the same rule as `npm run fixtures`.
export const FORBIDDEN_FILTERS = ['loudnorm', 'alimiter', 'acompressor', 'aresample=async', 'atempo'];

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

// The spec's alert band and ceiling. The station measures -20.0 LUFS day / -19.7 night
// with a 1.0 LU range, which is consistent enough that this band is a tight signal
// rather than a noisy one.
export const LOUDNESS_BAND_LUFS = [-22, -18];
export const MAX_TRUE_PEAK_DBFS = -1;

// What the spec measured on the SOURCE PCM, five minutes at the day anchor, 2026-09-13.
// Tier 0 measures the same signal after asplit, so the two should agree: a gap means the
// filter graph is not passing samples through unaltered, which is precisely what hanging
// ebur128 off an asplit into anullsink is there to guarantee.
export const SOURCE_LEVELS = { integratedLufs: -20.0, truePeakDbfs: -4.3 };

// ebur128 prints its summary ONCE, at the end of a run, and at AV_LOG_INFO. The spec's
// production `-loglevel warning` suppresses it, so a 24/7 stream produces no loudness
// figure at all — see ops/README.md. Returning null rather than zeroes is what keeps a
// suppressed summary from reading as a measurement of silence.
export function parseEbur128Summary(stderr) {
  const text = String(stderr);
  const i = text.lastIndexOf('Summary:');
  if (i === -1) return null;
  const block = text.slice(i);
  const integrated = /\bI:\s*(-?[\d.]+)\s*LUFS/.exec(block);
  const lra = /\bLRA:\s*(-?[\d.]+)\s*LU\b/.exec(block);
  const peak = /Peak:\s*(-?[\d.]+)\s*dBFS/.exec(block);
  if (!integrated || !lra || !peak) return null;
  return { integratedLufs: Number(integrated[1]), lra: Number(lra[1]), truePeakDbfs: Number(peak[1]) };
}

export function assessLevels(levels) {
  if (!levels || !Number.isFinite(levels.integratedLufs) || !Number.isFinite(levels.truePeakDbfs)) {
    return { ok: false, reason: 'no ebur128 summary in the run — ffmpeg logged below AV_LOG_INFO, so nothing was measured' };
  }
  const [low, high] = LOUDNESS_BAND_LUFS;
  const problems = [];
  if (levels.integratedLufs < low || levels.integratedLufs > high) {
    problems.push(`integrated ${levels.integratedLufs.toFixed(1)} LUFS is outside ${low}…${high}`);
  }
  if (levels.truePeakDbfs > MAX_TRUE_PEAK_DBFS) {
    // Not a level to correct downstream: the renderer soft-clips through tanh and
    // cannot exceed full scale by construction, so a peak this high is a renderer bug.
    problems.push(`true peak ${levels.truePeakDbfs.toFixed(1)} dBFS is above ${MAX_TRUE_PEAK_DBFS} dBTP — investigate the renderer, do not add a limiter`);
  }
  const integratedDeltaLu = levels.integratedLufs - SOURCE_LEVELS.integratedLufs;
  const truePeakDeltaDb = levels.truePeakDbfs - SOURCE_LEVELS.truePeakDbfs;
  const against = `source recorded ${SOURCE_LEVELS.integratedLufs.toFixed(1)} LUFS / ${SOURCE_LEVELS.truePeakDbfs.toFixed(1)} dBFS, so ${integratedDeltaLu >= 0 ? '+' : ''}${integratedDeltaLu.toFixed(1)} LU and ${truePeakDeltaDb >= 0 ? '+' : ''}${truePeakDeltaDb.toFixed(1)} dB`;
  return problems.length
    ? { ok: false, reason: problems.join('; '), integratedDeltaLu, truePeakDeltaDb, ...levels }
    : {
      ok: true, integratedDeltaLu, truePeakDeltaDb, ...levels,
      reason: `integrated ${levels.integratedLufs.toFixed(1)} LUFS${Number.isFinite(levels.lra) ? `, LRA ${levels.lra.toFixed(1)} LU` : ''}, true peak ${levels.truePeakDbfs.toFixed(1)} dBFS — ${against}`,
    };
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

// `speed` below 1.0 while renderer progress lines keep arriving points at video
// starvation. 0.97 is the spec's alert floor.
export const STARVATION_FLOOR = 0.97;

// And the spec's condition is `speed` outside 0.97-1.03 FOR TWO MINUTES, not for one
// sample. The duration is not incidental — it is what separates a starving muxer from
// the jitter of pairing two clocks read at slightly different moments.
//
// Measured over two clean 60-minute runs, 2026-09-15: 359 intervals each, median exactly
// 1.000, and exactly ONE interval below the floor in each — every one of them preceded by
// a compensating overshoot that cancels it (1.034 then 0.969 sums to 2.003 over 20s;
// 1.032 then 0.967 sums to 1.999). An implementation that judged single intervals failed
// both runs on that artifact. The floor is unchanged; the missing requirement is restored.
export const SUSTAINED_STARVATION_SECONDS = 120;

// ffmpeg's own `speed=` is CUMULATIVE. Observed 2026-09-14: ffmpeg takes a fixed ~8s to
// bring the image2pipe input up, and the cumulative figure therefore climbs 0.13 → 0.79
// → 0.94 over two minutes of a run that is pacing at exactly 1.000x throughout. Reading
// starvation off it calls a healthy stream starved for its first several minutes, and
// on the production host would fire the dead-air alert on every restart. `elapsed=` is
// what makes an interval reading possible instead.
export function parseProgressRecords(stderr) {
  const out = [];
  for (const part of String(stderr).split(/[\r\n]/)) {
    const base = parseProgress(part);
    if (!base) continue;
    const elapsed = /elapsed=(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(part);
    if (!elapsed) continue;
    out.push({
      ...base,
      elapsedSeconds: Number(elapsed[1]) * 3600 + Number(elapsed[2]) * 60 + Number(elapsed[3]),
    });
  }
  return out;
}

export function intervalSpeeds(records) {
  const out = [];
  for (let i = 1; i < records.length; i++) {
    const dWall = records[i].elapsedSeconds - records[i - 1].elapsedSeconds;
    if (!(dWall > 0)) continue;
    out.push({
      fromSeconds: records[i - 1].elapsedSeconds,
      toSeconds: records[i].elapsedSeconds,
      speed: (records[i].timeSeconds - records[i - 1].timeSeconds) / dWall,
    });
  }
  return out;
}

// How far ffmpeg's output clock sits behind the wall clock once it is running. A fixed
// one-time latency, not a hole: the renderer blocks on a full pipe rather than losing
// the samples. Reported on its own so it is not mistaken for drift.
export function startupOffsetSeconds(records) {
  if (!records.length) return NaN;
  return records[0].elapsedSeconds - records[0].timeSeconds;
}

const overlaps = (interval, [from, to]) => interval.fromSeconds < to && interval.toSeconds > from;

// `excludeWindows` carries deliberately induced outages — the tier-0 feeder kill. During
// one, pacing dips by construction: that is what the kill is demonstrating. Judging it
// as spontaneous starvation would make the criterion-6 demonstration always fail, and
// swallowing it would hide the one number that says what a picture problem costs the
// audio. So it is excluded here and measured by assessFeederOutage instead.
// The longest unbroken stretch below the floor, in seconds of wall clock.
function longestDip(judged, floor) {
  let best = { seconds: 0, fromSeconds: NaN, toSeconds: NaN };
  let run = null;
  for (const i of judged) {
    if (i.speed < floor) {
      // Contiguity is by adjacency in the judged list: a gap in sampling ends the run.
      run = run && run.toSeconds === i.fromSeconds
        ? { fromSeconds: run.fromSeconds, toSeconds: i.toSeconds }
        : { fromSeconds: i.fromSeconds, toSeconds: i.toSeconds };
      const seconds = run.toSeconds - run.fromSeconds;
      if (seconds > best.seconds) best = { seconds, ...run };
    } else {
      run = null;
    }
  }
  return best;
}

export function assessStarvation(intervals, {
  floor = STARVATION_FLOOR, skipSeconds = 0, excludeWindows = [],
  sustainedSeconds = SUSTAINED_STARVATION_SECONDS,
} = {}) {
  const judged = intervals.filter((i) => i.fromSeconds >= skipSeconds && !excludeWindows.some((w) => overlaps(i, w)));
  if (!judged.length) {
    return { ok: false, assessed: false, reason: `no pacing interval past the ${skipSeconds}s warm-up window — the run produced nothing to judge` };
  }
  const worst = judged.reduce((a, b) => (b.speed < a.speed ? b : a));
  const dip = longestDip(judged, floor);
  if (dip.seconds >= sustainedSeconds) {
    return {
      ok: false, assessed: true, worst, dip,
      reason: `video starvation: pacing stayed below the ${floor} floor for ${dip.seconds.toFixed(0)}s, from ${dip.fromSeconds.toFixed(0)}s to ${dip.toSeconds.toFixed(0)}s (worst ${worst.speed.toFixed(3)}x)`,
    };
  }
  // The worst sample is always reported, whether or not it gated. A single interval under
  // the floor is jitter, but it is not hidden.
  const aside = worst.speed < floor
    ? `; deepest single sample ${worst.speed.toFixed(3)}x at ${worst.fromSeconds.toFixed(0)}s, below the floor but not sustained (longest dip ${dip.seconds.toFixed(0)}s < ${sustainedSeconds}s)`
    : '';
  return { ok: true, assessed: true, worst, dip, reason: `${judged.length} interval(s) past warm-up, slowest ${worst.speed.toFixed(3)}x, floor ${floor}${aside}` };
}

// ---------------------------------------------------------------------------
// A/V sync
// ---------------------------------------------------------------------------

// -g 60 at fps=30. The keyframe spacing is what quantises a skew reading.
export const GOP_SECONDS = 2;

// How far video leads audio at the far edge of a probed window, from
// `ffprobe -show_entries packet=stream_index,pts_time -of json`.
export function skewFromPackets(probe, { video = 0, audio = 1 } = {}) {
  const last = (index) => {
    let max = null;
    for (const p of probe?.packets ?? []) {
      if (p.stream_index !== index) continue;
      const t = Number(p.pts_time);
      if (Number.isFinite(t) && (max === null || t > max)) max = t;
    }
    return max;
  };
  const v = last(video);
  const a = last(audio);
  if (v === null || a === null) return null;
  return v - a;
}

// Audio is the clock; video is fitted to audio, never the other way round. Two
// independent -re pacers can drift against each other over a long run, and CFR fps=30
// regenerating video timestamps is BELIEVED to absorb it. This measures the belief.
//
// The bound is measurement quantisation, not perception: each window's skew depends on
// where its edge falls inside a GOP, so a growth figure carries up to one GOP of error
// at each end. If skew ever proves to grow, the fix is on the video side — pacing
// videofeed off the audio byte count — never on the audio side.
export function assessAvSkew({ startSkew, endSkew }) {
  const boundSeconds = 2 * GOP_SECONDS;
  if (!Number.isFinite(startSkew) || !Number.isFinite(endSkew)) {
    return { ok: false, boundSeconds, growthSeconds: NaN, reason: 'A/V skew could not be measured at both ends of the run' };
  }
  const growthSeconds = endSkew - startSkew;
  const ok = Math.abs(growthSeconds) <= boundSeconds;
  return {
    ok, boundSeconds, growthSeconds, startSkew, endSkew,
    reason: ok
      ? `skew ${startSkew.toFixed(3)}s at the start, ${endSkew.toFixed(3)}s at the end — grew ${growthSeconds.toFixed(3)}s, within the ±${boundSeconds}s GOP quantisation`
      : `A/V skew grew ${growthSeconds.toFixed(3)}s across the run, past the ±${boundSeconds}s quantisation bound — fps=30 CFR is not absorbing the two -re pacers`,
  };
}

// ---------------------------------------------------------------------------
// Stalls
// ---------------------------------------------------------------------------

// How long ffmpeg's output clock may sit still before it counts as dead air rather than
// an outage being absorbed. 120s matches the spec's own `speed outside band for 2
// minutes` alert window, and is comfortably longer than the few seconds a feeder outage
// was observed to cost.
export const STALL_SECONDS = 120;

// Observed 2026-09-14, 31 minutes into a 60-minute tier-0 run and 90 seconds after the
// video feeder was killed and restarted: ffmpeg's `time=` froze at 1791s and never moved
// again. Every process stayed alive and every ffmpeg thread — both demuxers, the filter
// chain, both encoders, the muxer — sat in __psynch_cvwait, so nothing was blocked on a
// pipe read. It is an internal deadlock, and it is worse than a crash: nothing exits, so
// pipefail, -shortest and Restart=always are all silent over dead air, and a supervisor
// watching process liveness sees a healthy unit.
//
// Watching the OUTPUT advance is the only thing that catches it. This is also why the
// spec's off-host watchdog is load-bearing rather than a refinement: a host-local check
// on process liveness would have reported this pipeline as healthy indefinitely.
export function detectStall(records, { stallSeconds = STALL_SECONDS } = {}) {
  if (records.length < 2) return { stalled: false, reason: 'not enough progress records to judge' };
  const latest = records[records.length - 1];
  let since = latest;
  for (let i = records.length - 2; i >= 0; i--) {
    if (records[i].timeSeconds !== latest.timeSeconds) break;
    since = records[i];
  }
  const stalledForSeconds = latest.elapsedSeconds - since.elapsedSeconds;
  return {
    stalled: stalledForSeconds >= stallSeconds,
    frozenAtSeconds: latest.timeSeconds,
    stalledForSeconds,
    sinceSeconds: since.elapsedSeconds,
  };
}

export function assessStall(stall) {
  if (!stall || !stall.stalled) return { ok: true, reason: 'output clock advanced throughout' };
  return {
    ok: false,
    reason: `DEAD AIR: ffmpeg's output clock froze at ${stall.frozenAtSeconds}s and did not move for ${stall.stalledForSeconds.toFixed(0)}s — every process stayed alive, so nothing exited and no supervisor would have noticed`,
  };
}

// ---------------------------------------------------------------------------
// ffmpeg's RSS
// ---------------------------------------------------------------------------

// runtime/realtime.mjs judges the RENDERER's RSS, whose trace is a smooth GC sawtooth,
// and refuses to fit a trend to anything under an hour. ffmpeg's trace is a different
// shape and needs a different minimum — not a different threshold.
//
// Measured across four clean runs, 2026-09-15/16: ffmpeg takes ONE ~1.5 MB allocation
// somewhere in the first three quarters of an hour and is flat either side of it.
//
//   hour2   1 h   step ~43 min      linear fit 3.293 MB/h
//   hour3   1 h   no step           linear fit 1.304 MB/h
//   hour4   1 h   step ~28-33 min   linear fit 3.516 MB/h
//   rss4h   4 h   step at 25 min    linear fit 0.094 MB/h, 0.70 MB/h counting the step
//
// One step dominates an hour-long fit and washes out of a four-hour one, so whether a
// one-hour run passes depends on when the step happens to land relative to the warm-up
// phase — which is arbitrary. Four hours is where the statistic starts describing
// ffmpeg rather than describing the step.
//
// The 2.0 MB/h threshold is NOT changed; it is still the renderer harness's figure,
// imported rather than restated. What changes is refusing to judge a run too short for
// the number to mean anything, which is the defence runtime/realtime.mjs already built
// for exactly this reason — the rule is theirs, the duration is ffmpeg's.
//
// Consequence worth stating: a one-hour tier-0 run cannot assess ffmpeg's RSS at all, so
// the spec's criterion 2 ("ffmpeg RSS flat", on a one-hour run) needs four hours to mean
// anything. See ops/README.md.
export const FFMPEG_RSS_MIN_ASSESSABLE_SECONDS = 4 * 3600;

export function assessFfmpegRss({ slopeBytesPerHour, wallSeconds, minSeconds = FFMPEG_RSS_MIN_ASSESSABLE_SECONDS }) {
  const mb = (b) => (b / (1024 * 1024)).toFixed(3);
  if (wallSeconds < minSeconds) {
    return {
      ok: true, assessed: false,
      reason: `${mb(slopeBytesPerHour)} MB/h reported, not judged: ${(wallSeconds / 3600).toFixed(1)} h is under the ${minSeconds / 3600} h a single ~1.5 MB ffmpeg allocation needs to wash out of the fit`,
    };
  }
  return assessRssSlope({ slopeBytesPerHour, wallSeconds });
}
