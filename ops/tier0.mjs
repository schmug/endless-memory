// Tier 0: the complete broadcast pipeline against a LOCAL sink.
//
// "The complete ffmpeg invocation, including the video fifo, the filter graph and both
// encoders, writing to -f flv /tmp/out.flv instead of the RTMPS URL. Every flag change
// is validated here first. This exercises everything except the network and costs
// nothing, so there is no excuse for changing a flag without it."
//
// It runs ops/stream.sh and ops/videofeed.sh — the production scripts, not a copy of
// their flags — with SINK set instead of CF_STREAM_KEY. There is no code path here that
// can reach Cloudflare, YouTube, or any network at all.
//
// Long-running, so it lives behind `npm run tier0` and outside `npm test`, following
// the `npm run endurance` and `npm run realtime` precedent. The pure verdicts in this
// file and in ops/measure.mjs are what `npm test` covers.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  driftTolerance, assessDrift, parseSilence, assessSilence, assessRssSlope,
  DEFAULT_ANCHOR, DEFAULT_JOURNAL, logSchedule,
} from '../runtime/realtime.mjs';
import { analyse } from '../runtime/endurance.mjs';
import { SR } from '../runtime/voices.mjs';
import {
  parseEbur128Summary, assessLevels, parseProgressRecords, intervalSpeeds,
  assessStarvation, startupOffsetSeconds, skewFromPackets, assessAvSkew, assessFeederOutage,
} from './measure.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const MB = 1024 * 1024;

// The seam contract piece D must meet: 1280x720. And the three audio values that are a
// restatement of the renderer's output format rather than a tuning choice.
export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 720;

export function assessTracks(streams) {
  const video = (streams || []).find((s) => s.codec_type === 'video');
  const audio = (streams || []).find((s) => s.codec_type === 'audio');
  const problems = [];
  if (!video) problems.push('no video track — YouTube Live requires one, so an audio-only file is not a smaller success');
  else if (video.width !== FRAME_WIDTH || video.height !== FRAME_HEIGHT) {
    problems.push(`video is ${video.width}x${video.height}, not ${FRAME_WIDTH}x${FRAME_HEIGHT}`);
  }
  if (!audio) problems.push('no audio track');
  else {
    if (Number(audio.sample_rate) !== SR) problems.push(`audio is ${audio.sample_rate} Hz, not ${SR} — it would play at the wrong speed`);
    if (Number(audio.channels) !== 2) problems.push(`audio is ${audio.channels} channel(s), not 2`);
  }
  return problems.length
    ? { ok: false, reason: problems.join('; ') }
    : { ok: true, reason: `${video.codec_name} ${video.width}x${video.height} + ${audio.codec_name} ${audio.sample_rate} Hz ${audio.channels}ch, one ffmpeg invocation` };
}

// Spec criterion 6. Killing videofeed must not end the broadcast: the picture freezes,
// the audio continues, and the feeder comes back. This is the criterion that proves
// piece D cannot take the station off the air, and it is the one the fifo holder fd in
// ops/stream.sh exists for — without it, ffmpeg takes EOF on the video input and the
// whole run ends with the feeder.
const FEEDER_KILL_SURVIVAL_MARGIN_SECONDS = 5;

export function assessFeederKill({ killedAtSeconds, audioEndSeconds, targetSeconds, framesResumed }) {
  if (killedAtSeconds === null || killedAtSeconds === undefined) {
    return { ok: true, attempted: false, reason: 'no feeder kill attempted in this run' };
  }
  if (audioEndSeconds < targetSeconds - FEEDER_KILL_SURVIVAL_MARGIN_SECONDS) {
    return {
      ok: false, attempted: true,
      reason: `the run ended at ${audioEndSeconds.toFixed(1)}s, shortly after the feeder was killed at ${killedAtSeconds.toFixed(1)}s, instead of reaching ${targetSeconds}s — the video feeder took the broadcast with it`,
    };
  }
  if (!framesResumed) {
    return {
      ok: false, attempted: true,
      reason: `the broadcast survived the feeder being killed at ${killedAtSeconds.toFixed(1)}s, but nothing ever resumed feeding it — the unit did not come back`,
    };
  }
  return {
    ok: true, attempted: true,
    reason: `feeder killed at ${killedAtSeconds.toFixed(1)}s; audio ran on to ${audioEndSeconds.toFixed(1)}s and the feed resumed`,
  };
}

// Every verdict is a gate. A clean exit and a large file prove nothing on their own —
// the same argument runtime/realtime.mjs makes about backpressure.
export function collectFailures(r) {
  const failures = [];
  if (r.renderCode !== 0 && r.renderCode !== null) failures.push(`the renderer exited ${r.renderCode}`);
  if (r.ffmpegCode !== 0) failures.push(`stream.sh exited ${r.ffmpegCode}`);
  if (!r.outputBytes) failures.push('the output file is empty');
  for (const key of ['tracks', 'drift', 'silence', 'starvation', 'levels', 'avSkew', 'feederKill', 'feederOutage', 'rssVerdict']) {
    const v = r[key];
    if (v && !v.ok) failures.push(v.reason);
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

const ffprobeJson = (args) => {
  try {
    return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-of', 'json', ...args], { encoding: 'utf8', maxBuffer: 256 * MB }));
  } catch { return null; }
};

// Walk the process tree from a root pid. stream.sh spawns node and ffmpeg itself, so
// their pids are not known here; `ps` is the only place they exist.
function descendants(rootPid) {
  let rows = '';
  try { rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' }); } catch { return []; }
  const procs = rows.split('\n').map((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), rssBytes: Number(m[3]) * 1024, comm: m[4].trim() } : null;
  }).filter(Boolean);
  const out = [];
  const frontier = [rootPid];
  while (frontier.length) {
    const pid = frontier.pop();
    for (const p of procs) {
      if (p.ppid === pid) { out.push(p); frontier.push(p.pid); }
    }
  }
  return out;
}

const killTree = (rootPid) => {
  for (const p of descendants(rootPid)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* already gone */ } }
  try { process.kill(rootPid, 'SIGKILL'); } catch { /* already gone */ }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnFeeder(fifo) {
  const child = spawn('bash', [join(HERE, 'videofeed.sh')], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, VIDEO_FIFO: fifo },
  });
  child.stderr.resume();
  child.on('error', () => {});
  return child;
}

export async function tier0({
  seconds = 3600,
  anchor = DEFAULT_ANCHOR,
  journal = DEFAULT_JOURNAL,
  chunkCycles = 8,
  out,
  killFeederAt = null,
  sampleSeconds = 10,
  onSample = () => {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tier0-'));
  const fifo = join(dir, 'video.fifo');
  execFileSync('mkfifo', ['-m', '600', fifo]);
  const journalPath = join(dir, 'journal.json');
  writeFileSync(journalPath, JSON.stringify(journal));
  const output = out || join(dir, 'tier0.flv');
  if (!existsSync(dirname(output))) mkdirSync(dirname(output), { recursive: true });

  // SINK, never CF_STREAM_KEY: stream.sh refuses both, and with only SINK set there is
  // no rtmps destination anywhere in the argv it builds.
  const stream = spawn('bash', [join(HERE, 'stream.sh')], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      VIDEO_FIFO: fifo, SINK: output, CF_STREAM_KEY: '',
      ANCHOR: anchor, JOURNAL: journalPath, SECONDS_LIMIT: String(seconds),
      CHUNK_CYCLES: String(chunkCycles),
      // ebur128 prints its summary at AV_LOG_INFO; the production `warning` suppresses
      // it entirely. See ops/README.md — this is a finding, not a flag to copy upstream.
      LOGLEVEL: 'info', STATS_PERIOD: String(sampleSeconds),
    },
  });

  const started = Date.now();
  let stderr = '';
  stream.stderr.on('data', (d) => { stderr += d; });

  let feeder = spawnFeeder(fifo);
  let feederKilledAt = null;
  let feederRestartedAt = null;

  const samples = [];
  let lastRecord = null;
  const timer = setInterval(() => {
    const kids = descendants(stream.pid);
    const ffmpeg = kids.find((p) => p.comm.includes('ffmpeg'));
    const records = parseProgressRecords(stderr);
    lastRecord = records[records.length - 1] || lastRecord;
    if (!ffmpeg) return;
    const sample = { hours: (Date.now() - started) / 3600000, rss: ffmpeg.rssBytes, heapUsed: 0 };
    samples.push(sample);
    onSample(sample, lastRecord);
  }, sampleSeconds * 1000);

  // The feeder kill: SIGKILL the whole videofeed tree, leave it dead long enough that a
  // frame-starved ffmpeg would have shown it, then bring it back the way
  // `Restart=always` would.
  let killTimer = null;
  if (killFeederAt !== null) {
    killTimer = setTimeout(async () => {
      feederKilledAt = (Date.now() - started) / 1000;
      process.stderr.write(`  [${feederKilledAt.toFixed(0)}s] killing the video feeder\n`);
      killTree(feeder.pid);
      await sleep(5000);
      feeder = spawnFeeder(fifo);
      feederRestartedAt = (Date.now() - started) / 1000;
      process.stderr.write(`  [${feederRestartedAt.toFixed(0)}s] video feeder restarted\n`);
    }, killFeederAt * 1000);
  }

  const [streamCode] = await once(stream, 'close');
  clearInterval(timer);
  if (killTimer) clearTimeout(killTimer);
  const wallSeconds = (Date.now() - started) / 1000;
  killTree(feeder.pid);

  const records = parseProgressRecords(stderr);
  const producedSeconds = records.length ? records[records.length - 1].timeSeconds : 0;
  const outputBytes = existsSync(output) ? statSync(output).size : 0;

  // Silence is measured on the finished file rather than taken from render.mjs's own
  // guard, which throws on the first silent chunk and so can only report zero or
  // nothing at all — the same reasoning runtime/realtime.mjs records for its sink.
  let silenceStderr = '';
  try {
    silenceStderr = execFileSync('ffmpeg', [
      '-hide_banner', '-nostats', '-i', output, '-af', 'silencedetect=n=-50dB:d=1', '-f', 'null', '-',
    ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * MB });
  } catch (e) { silenceStderr = String(e.stderr || ''); }

  const probe = ffprobeJson(['-show_entries', 'stream=index,codec_type,codec_name,width,height,sample_rate,channels', output]);
  const format = ffprobeJson(['-show_entries', 'format=duration', output]);
  const durationSeconds = Number(format?.format?.duration) || 0;

  const packetEntries = ['-show_entries', 'packet=stream_index,pts_time'];
  const startSkew = skewFromPackets(ffprobeJson([...packetEntries, '-read_intervals', '%+10', output]));
  const endSkew = durationSeconds > 20
    ? skewFromPackets(ffprobeJson([...packetEntries, '-read_intervals', `${Math.floor(durationSeconds - 10)}%+10`, output]))
    : null;

  const intervals = intervalSpeeds(records);
  const tolerance = driftTolerance({ chunkCycles, pipeBytes: 64 * 1024 });
  const analysis = analyse(samples, { totalHours: Math.max(wallSeconds / 3600, 1e-9) });

  const result = {
    seconds, anchor, chunkCycles, output, outputBytes, wallSeconds, producedSeconds,
    durationSeconds, tolerance, records, intervals, samples, analysis,
    startupOffsetSeconds: startupOffsetSeconds(records),
    ffmpegCode: streamCode,
    // stream.sh runs under pipefail, so a renderer failure already fails the pipeline;
    // there is no separate renderer exit code to read from here.
    renderCode: null,
    renderReport: stderr.split('\n').filter((l) => l.startsWith('render:')).pop() || '',
    feederKilledAt, feederRestartedAt,
    tracks: assessTracks(probe?.streams),
    drift: assessDrift({ producedSeconds, elapsedSeconds: wallSeconds, tolerance }),
    silence: assessSilence(parseSilence(silenceStderr)),
    // The induced outage is excluded here and measured by assessFeederOutage: pacing
    // dips during a deliberate feeder kill by construction, so judging it as
    // spontaneous starvation would make the criterion-6 demonstration always fail.
    starvation: assessStarvation(intervals, {
      skipSeconds: 2 * sampleSeconds,
      excludeWindows: feederKilledAt === null ? [] : [[feederKilledAt, feederRestartedAt ?? Infinity]],
    }),
    levels: assessLevels(parseEbur128Summary(stderr)),
    avSkew: assessAvSkew({ startSkew, endSkew }),
    feederKill: assessFeederKill({
      killedAtSeconds: feederKilledAt,
      audioEndSeconds: durationSeconds,
      targetSeconds: seconds,
      framesResumed: feederRestartedAt !== null && durationSeconds > feederRestartedAt,
    }),
    feederOutage: assessFeederOutage({ intervals, killedAtSeconds: feederKilledAt, restartedAtSeconds: feederRestartedAt }),
    rssVerdict: assessRssSlope({ slopeBytesPerHour: analysis.rssSlopeBytesPerHour, wallSeconds }),
  };
  result.failures = collectFailures(result);
  result.passed = result.failures.length === 0;
  return result;
}

const fmtMb = (b) => `${(b / MB).toFixed(1)} MB`;

export function formatTier0Report(r) {
  const lines = [];
  lines.push(`tier 0: ${(r.seconds / 60).toFixed(0)} min target, anchor ${r.anchor}, chunk ${r.chunkCycles} cycles, local sink`);
  lines.push(`  tracks: ${r.tracks.reason}`);
  lines.push(`  output: ${fmtMb(r.outputBytes)}, ${r.durationSeconds.toFixed(2)}s at ${r.output}`);
  lines.push(`  produced ${(r.producedSeconds / 3600).toFixed(3)} h of audio in ${(r.wallSeconds / 3600).toFixed(3)} h wall`);
  lines.push(`  drift: ${r.drift.aheadSeconds >= 0 ? '+' : ''}${r.drift.aheadSeconds.toFixed(2)}s vs realtime, bound ±${r.tolerance.toFixed(2)}s (one ${r.chunkCycles}-cycle chunk + a 64 KiB pipe) — ${r.drift.reason}`);
  lines.push(`  startup offset: ${r.startupOffsetSeconds.toFixed(2)}s — a one-time latency, which is why ffmpeg's cumulative speed= is not the starvation signal`);
  lines.push(`  pacing: ${r.starvation.reason}`);
  lines.push(`  A/V sync: ${r.avSkew.reason}`);
  lines.push(`  levels: ${r.levels.reason}`);
  lines.push(`  silence: ${r.silence.reason}`);
  lines.push(`  video feeder: ${r.feederKill.reason}`);
  lines.push(`  outage cost: ${r.feederOutage.reason}`);
  if (r.renderReport) lines.push(`  ${r.renderReport}`);
  lines.push('  phase  span (h)        samples   median RSS    min RSS     max RSS   (ffmpeg)');
  for (const p of r.analysis.phases) {
    const warm = p.index < r.analysis.warmupPhases ? ' (warm-up)' : '';
    lines.push(
      `  ${String(p.index + 1).padStart(5)}  ${p.fromHours.toFixed(2).padStart(5)}–${p.toHours.toFixed(2).padEnd(5)} ` +
      `${String(p.samples).padStart(9)}  ${fmtMb(p.medianRss).padStart(11)} ${fmtMb(p.minRss).padStart(10)} ${fmtMb(p.maxRss).padStart(11)}${warm}`,
    );
  }
  lines.push(`  ffmpeg RSS verdict: ${r.rssVerdict.reason}`);
  for (const f of r.failures) lines.push(`  FAIL: ${f}`);
  lines.push(`  verdict: ${r.passed ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const minutes = Number(arg('minutes', 60));
  const logDue = logSchedule(Number(arg('log-every', 300)));
  const result = await tier0({
    seconds: Math.round(minutes * 60),
    anchor: arg('anchor', DEFAULT_ANCHOR),
    chunkCycles: Number(arg('chunk-cycles', 8)),
    out: arg('out', undefined),
    killFeederAt: arg('kill-feeder-at') ? Number(arg('kill-feeder-at')) : null,
    // An hour with no output for an hour is indistinguishable from a hang.
    onSample: (s, p) => {
      if (!logDue(s.hours * 3600)) return;
      process.stderr.write(`  [${(s.hours * 60).toFixed(1)} min] ffmpeg rss ${fmtMb(s.rss)}, at ${p ? p.timeSeconds.toFixed(0) : '?'}s, cumulative speed ${p ? p.speed.toFixed(2) : '?'}x\n`);
    },
  });
  console.log(formatTier0Report(result));
  process.exitCode = result.passed ? 0 : 1;
}
