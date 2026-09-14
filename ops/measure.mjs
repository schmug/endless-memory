// What the tier-0 run measures, separated from the running of it so the parsers and
// verdicts can be tested against captured ffmpeg output instead of a live pipeline.
//
// Drift, silence and the RSS slope are NOT here: runtime/realtime.mjs already derives
// and judges them, and the tier-0 harness imports that rather than restating a bound
// it would then have to keep in step.

import { parseProgress } from '../runtime/realtime.mjs';

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
export function assessStarvation(intervals, { floor = STARVATION_FLOOR, skipSeconds = 0, excludeWindows = [] } = {}) {
  const judged = intervals.filter((i) => i.fromSeconds >= skipSeconds && !excludeWindows.some((w) => overlaps(i, w)));
  if (!judged.length) {
    return { ok: false, assessed: false, reason: `no pacing interval past the ${skipSeconds}s warm-up window — the run produced nothing to judge` };
  }
  const worst = judged.reduce((a, b) => (b.speed < a.speed ? b : a));
  if (worst.speed < floor) {
    return { ok: false, assessed: true, worst, reason: `video starvation: pacing fell to ${worst.speed.toFixed(3)}x between ${worst.fromSeconds.toFixed(0)}s and ${worst.toSeconds.toFixed(0)}s, below the ${floor} floor` };
  }
  return { ok: true, assessed: true, worst, reason: `${judged.length} interval(s) past warm-up, slowest ${worst.speed.toFixed(3)}x, floor ${floor}` };
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

// What a video-feeder outage costs the audio, measured rather than assumed. Observed
// 2026-09-14: a 5-second outage dipped pacing to 0.650x and the run still reached its
// full length with no silent stretch — the muxer stalled and then caught up. The gate is
// RECOVERY, because criterion 6 is about the broadcast surviving; the dip itself is a
// figure to report.
export function assessFeederOutage({ intervals, killedAtSeconds, restartedAtSeconds, floor = STARVATION_FLOOR }) {
  if (killedAtSeconds === null || killedAtSeconds === undefined) {
    return { ok: true, attempted: false, reason: 'no video-feeder outage in this run' };
  }
  const window = [killedAtSeconds, restartedAtSeconds ?? Infinity];
  const during = intervals.filter((i) => overlaps(i, window));
  const dipSpeed = during.length ? Math.min(...during.map((i) => i.speed)) : null;
  const recovered = intervals.find((i) => i.fromSeconds >= (restartedAtSeconds ?? Infinity) && i.speed >= floor);
  const cost = dipSpeed === null
    ? 'no pacing sample landed inside the outage'
    : `pacing dipped to ${dipSpeed.toFixed(3)}x during the outage`;
  if (!recovered) {
    return {
      ok: false, attempted: true, dipSpeed, recoveredBySeconds: null,
      reason: `${cost} and never recovered above the ${floor} floor afterwards`,
    };
  }
  return {
    ok: true, attempted: true, dipSpeed, recoveredBySeconds: recovered.toSeconds,
    reason: `${cost}, back above the ${floor} floor by ${recovered.toSeconds.toFixed(0)}s`,
  };
}
