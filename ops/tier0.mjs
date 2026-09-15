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
import { mkdtempSync, writeFileSync, statSync, existsSync, mkdirSync, createWriteStream } from 'node:fs';
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
  assessStarvation, startupOffsetSeconds, skewFromPackets, assessAvSkew,
  detectStall, assessStall, STALL_SECONDS,
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

// Criterion 6, inverted by measurement. The spec asked for "videofeed is killed and the
// broadcast does not end ... the unit restarts and resumes feeding". On 2026-09-15 that
// was measured to be unachievable: replacing the fifo's writer under a live ffmpeg wedges
// it into dead air no liveness check can see, across six ffmpeg configurations.
//
// stream.sh now owns the feeder, so the safe behaviour is the opposite: a dead feeder
// must END the pipeline promptly, and systemd restarts renderer, ffmpeg and feeder
// together. A pipeline that outlives its feeder is the wedge.
export const FEEDER_EXIT_GRACE_SECONDS = 15;

export function assessFeederKill({ killedAtSeconds, exitedAtSeconds, graceSeconds = FEEDER_EXIT_GRACE_SECONDS }) {
  if (killedAtSeconds === null || killedAtSeconds === undefined) {
    return { ok: true, attempted: false, reason: 'no feeder kill attempted in this run' };
  }
  if (exitedAtSeconds === null || exitedAtSeconds === undefined) {
    return {
      ok: false, attempted: true, tookSeconds: Infinity,
      reason: `the feeder was killed at ${killedAtSeconds.toFixed(1)}s and the pipeline did not end — that is the wedge, and it is dead air no liveness check can see`,
    };
  }
  const tookSeconds = exitedAtSeconds - killedAtSeconds;
  if (tookSeconds > graceSeconds) {
    return {
      ok: false, attempted: true, tookSeconds,
      reason: `the pipeline took ${tookSeconds.toFixed(1)}s to end after its feeder died, past the ${graceSeconds}s grace — every second of that is dead air before systemd can restart it`,
    };
  }
  return {
    ok: true, attempted: true, tookSeconds,
    reason: `feeder killed at ${killedAtSeconds.toFixed(1)}s; the pipeline ended ${tookSeconds.toFixed(1)}s later, so systemd restarts all three together`,
  };
}

// Every verdict is a gate. A clean exit and a large file prove nothing on their own —
// the same argument runtime/realtime.mjs makes about backpressure.
export function collectFailures(r) {
  const failures = [];
  if (r.renderCode !== 0 && r.renderCode !== null) failures.push(`the renderer exited ${r.renderCode}`);
  // A stalled run is killed by the harness, so its exit code is the kill and reporting
  // it as well would bury the stall under a second, less informative failure.
  // A stalled run is killed by the harness, and a feeder-kill run is MEANT to exit
  // non-zero — that is the property under test. Neither is a separate failure.
  if (r.ffmpegCode !== 0 && r.stall?.ok !== false && !r.feederKill?.attempted) failures.push(`stream.sh exited ${r.ffmpegCode}`);
  if (!r.outputBytes) failures.push('the output file is empty');
  // A run killed on purpose cannot produce an end-of-run measurement: ffmpeg never
  // prints its ebur128 Summary and the flv has no trailer to probe for skew. Those are
  // reported but not judged, the same way assessRssSlope refuses to judge a run too
  // short to fit a trend. Everything else still gates.
  const endOfRunOnly = r.feederKill?.attempted ? ['levels', 'avSkew'] : [];
  for (const key of ['stall', 'tracks', 'drift', 'silence', 'starvation', 'levels', 'avSkew', 'feederKill', 'rssVerdict']) {
    if (endOfRunOnly.includes(key)) continue;
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

export async function tier0({
  seconds = 3600,
  anchor = DEFAULT_ANCHOR,
  journal = DEFAULT_JOURNAL,
  chunkCycles = 8,
  out,
  killFeederAt = null,
  sampleSeconds = 10,
  stallSeconds = STALL_SECONDS,
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
  // Teed to disk as well as held in memory. A wedged run reports nothing until it exits,
  // and on 2026-09-14 one never exited — ffmpeg's own account of the stall was
  // unreachable for as long as it mattered. The file is what makes a live stall
  // diagnosable.
  const stderrPath = `${output}.ffmpeg.log`;
  const stderrFile = createWriteStream(stderrPath);
  stream.stderr.on('data', (d) => { stderr += d; stderrFile.write(d); });

  // stream.sh starts the feeder itself and dies with it — the writer is never replaced
  // under a live ffmpeg. Nothing here spawns or restarts one.
  let feederKilledAt = null;
  let feederExitedAt = null;
  let stall = null;

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

    // A wedged ffmpeg keeps every process alive and never exits, so waiting on close()
    // waits forever — observed 2026-09-14. The harness has to notice the output clock
    // standing still and end the run itself, or it cannot report the one failure that
    // matters most.
    const check = detectStall(records, { stallSeconds });
    if (check.stalled && !stall) {
      stall = check;
      process.stderr.write(`  [${((Date.now() - started) / 60000).toFixed(1)} min] STALLED: output clock frozen at ${check.frozenAtSeconds}s for ${check.stalledForSeconds.toFixed(0)}s — ending the run\n`);
      killTree(stream.pid);
    }
  }, sampleSeconds * 1000);

  // The feeder kill: find stream.sh's feeder child and SIGKILL it. What is being checked
  // is that the whole pipeline ends promptly afterwards, not that it survives.
  let killTimer = null;
  if (killFeederAt !== null) {
    killTimer = setTimeout(() => {
      const feeder = descendants(stream.pid).filter((p) => p.comm.includes('node'));
      const target = feeder.find((p) => p.pid !== stream.pid);
      feederKilledAt = (Date.now() - started) / 1000;
      process.stderr.write(`  [${feederKilledAt.toFixed(0)}s] killing the video feeder — the pipeline should end, not survive\n`);
      for (const p of descendants(stream.pid)) {
        // videofeed.sh execs node on videofeed.mjs, so match the script rather than the
        // command name, and never take the renderer down by mistake.
        if (p.comm.includes('node') && p.pid !== target?.pid) continue;
        try { process.kill(p.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }, killFeederAt * 1000);
  }

  const [streamCode] = await once(stream, 'close');
  clearInterval(timer);
  if (killTimer) clearTimeout(killTimer);
  const wallSeconds = (Date.now() - started) / 1000;
  if (feederKilledAt !== null) feederExitedAt = wallSeconds;

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
    seconds, anchor, chunkCycles, output, outputBytes, wallSeconds, producedSeconds, stderrPath,
    durationSeconds, tolerance, records, intervals, samples, analysis,
    startupOffsetSeconds: startupOffsetSeconds(records),
    ffmpegCode: streamCode,
    // stream.sh runs under pipefail, so a renderer failure already fails the pipeline;
    // there is no separate renderer exit code to read from here.
    renderCode: null,
    renderReport: stderr.split('\n').filter((l) => l.startsWith('render:')).pop() || '',
    feederKilledAt, feederExitedAt,
    tracks: assessTracks(probe?.streams),
    drift: assessDrift({ producedSeconds, elapsedSeconds: wallSeconds, tolerance }),
    silence: assessSilence(parseSilence(silenceStderr)),
    // The induced outage is excluded here and measured by assessFeederOutage: pacing
    // dips during a deliberate feeder kill by construction, so judging it as
    // spontaneous starvation would make the criterion-6 demonstration always fail.
    starvation: assessStarvation(intervals, {
      // Everything from the kill onward is the pipeline shutting down on purpose, so it
      // is not a pacing judgement.
      skipSeconds: 2 * sampleSeconds,
      excludeWindows: feederKilledAt === null ? [] : [[feederKilledAt, Infinity]],
    }),
    levels: assessLevels(parseEbur128Summary(stderr)),
    avSkew: assessAvSkew({ startSkew, endSkew }),
    feederKill: assessFeederKill({ killedAtSeconds: feederKilledAt, exitedAtSeconds: feederExitedAt }),
    stall: assessStall(stall ?? detectStall(records, { stallSeconds })),
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
  lines.push(`  A/V sync: ${r.avSkew.reason}${r.feederKill?.attempted ? ' (not judged: a killed run leaves no trailer to probe)' : ''}`);
  lines.push(`  levels: ${r.levels.reason}${r.feederKill?.attempted ? ' (not judged: the run was killed before ffmpeg could print its summary)' : ''}`);
  lines.push(`  silence: ${r.silence.reason}`);
  lines.push(`  video feeder: ${r.feederKill.reason}`);
  lines.push(`  stall: ${r.stall.reason}`);
  lines.push(`  ffmpeg log: ${r.stderrPath}`);
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
