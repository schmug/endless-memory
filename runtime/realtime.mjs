// Realtime proof (#36) — the renderer has only ever been measured at ~109x
// realtime by endurance.mjs, which consumes chunks as fast as they are produced.
// This drives it at 1x through `ffmpeg -re`, the pipeline the audio-runtime spec
// assumes at :201 but never exercised.

// One ffmpeg progress record. ffmpeg 8.0 emits these \r-separated on one line:
//   size=      24KiB time=00:00:00.57 bitrate= 335.2kbits/s speed=1.15x elapsed=0:00:00.50
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { analyse, MAX_RSS_SLOPE_BYTES_PER_HOUR } from './endurance.mjs';
import { SR, CYCLE_SECONDS } from './voices.mjs';

// `time` is what ffmpeg has consumed; `speed` is its pacing against realtime, which
// is the figure that says whether -re backpressure is actually engaging.
export function parseProgress(line) {
  const time = /time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(line);
  const speed = /speed=\s*([\d.]+)x/.exec(line);
  if (!time || !speed) return null;
  const timeSeconds = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]);
  return { timeSeconds, speed: Number(speed[1]) };
}

// toPcm() writes each mono sample twice, 16-bit LE: four bytes of output per sample.
// endurance.mjs holds the same constant privately; it is repeated rather than
// imported so neither script's measurement depends on the other's internals.
export const BYTES_PER_SAMPLE = 4;

// How far ahead of ffmpeg the renderer may legitimately be, in seconds of audio.
//
// `ffmpeg -re` consumes at 1x, so the renderer runs until the pipe fills and then
// blocks. The gap between produced and consumed audio is therefore exactly what is in
// flight: the chunk currently being written, plus whatever the pipe holds. Deriving
// the bound from those two means a change to --chunk-cycles moves the tolerance with
// it; a constant here would quietly stop matching the thing it is bounding.
export function driftTolerance({ chunkCycles, pipeBytes }) {
  return chunkCycles * CYCLE_SECONDS + pipeBytes / (SR * BYTES_PER_SAMPLE);
}

// The realtime verdict. `ahead` is how much audio exists beyond what wall clock has
// had time to play. Both directions are failures, for opposite reasons:
//
//   ahead > tolerance  — backpressure is not engaging. The renderer is running free
//                        (endurance.mjs measures ~109x), so a clean exit and a large
//                        file prove nothing about realtime. This is the failure the
//                        check exists to catch.
//   ahead < -tolerance — the renderer could not keep up and starved ffmpeg. On a
//                        live stream that is audible: a hole.
export function assessDrift({ producedSeconds, elapsedSeconds, tolerance }) {
  const aheadSeconds = producedSeconds - elapsedSeconds;
  if (aheadSeconds > tolerance) {
    return { aheadSeconds, ok: false, reason: `renderer ran ${aheadSeconds.toFixed(2)}s ahead of realtime, past the ${tolerance.toFixed(2)}s in-flight bound — backpressure did not engage` };
  }
  if (aheadSeconds < -tolerance) {
    return { aheadSeconds, ok: false, reason: `renderer fell ${(-aheadSeconds).toFixed(2)}s behind realtime — it starved the encoder` };
  }
  return { aheadSeconds, ok: true, reason: `within ${tolerance.toFixed(2)}s of realtime` };
}

// Silent stretches in the RENDERED OUTPUT, from ffmpeg's silencedetect:
//   [silencedetect @ 0x...] silence_start: 2
//   [silencedetect @ 0x...] silence_end: 5 | silence_duration: 3
// Measured on the file rather than taken from render.mjs's own guard, which throws on
// the first silent chunk and so can only ever report zero or nothing at all.
export function parseSilence(stderr) {
  const out = [];
  for (const line of String(stderr).split('\n')) {
    const start = /silence_start:\s*([\d.-]+)/.exec(line);
    if (start) { out.push({ start: Number(start[1]), end: null, duration: null }); continue; }
    const end = /silence_end:\s*([\d.-]+)\s*\|\s*silence_duration:\s*([\d.]+)/.exec(line);
    if (end && out.length) {
      const open = out[out.length - 1];
      open.end = Number(end[1]);
      open.duration = Number(end[2]);
    }
  }
  return out;
}

// The silence verdict. A stretch with no `end` never recovered — the stream went
// quiet and stayed quiet to EOF. That is dead air, and it is called out separately
// because counting it as one stretch among others understates it: every other
// stretch ended on its own.
export function assessSilence(stretches) {
  if (!stretches.length) return { ok: true, count: 0, deadAir: false, reason: 'no silent stretches' };
  const deadAir = stretches.some((s) => s.end === null);
  const reason = deadAir
    ? `stream went silent at ${stretches.find((s) => s.end === null).start}s and never recovered`
    : `${stretches.length} silent stretch(es), longest ${Math.max(...stretches.map((s) => s.duration)).toFixed(2)}s`;
  return { ok: false, count: stretches.length, deadAir, reason };
}

// A fixed default anchor, for the same reason endurance.mjs and the fixtures pin
// one: a run that reads the wall clock cannot be compared against last week's.
export const DEFAULT_ANCHOR = '2026-09-11T12:00:00Z';
export const DEFAULT_JOURNAL = { version: 1, seed: 'window-seat-v1', events: [] };

// Silence threshold. -50 dBFS for at least 1s: the quiet journal's floor sits far
// above this, so anything tripping it is a hole rather than a soft passage.
const SILENCE_DB = -50;
const SILENCE_SECONDS = 1;

// macOS and Linux `ps` both report RSS in KiB with this form.
function rssBytes(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return out ? Number(out) * 1024 : NaN;
  } catch { return NaN; }
}

// Drive render.mjs -> ffmpeg -re for `hours` of audio and report what happened.
//
// The renderer is spawned as a PROCESS, not imported: the thing under test is the
// production path — the CLI, its fd-1 stdout handling, and a real pipe applying real
// backpressure. Importing renderChunk would measure a different program.
export async function realtime({
  hours = 3,
  anchor = DEFAULT_ANCHOR,
  journal = DEFAULT_JOURNAL,
  chunkCycles = 8,
  out,
  sampleSeconds = 10,
  onSample = () => {},
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'realtime-'));
  const journalPath = join(dir, 'journal.json');
  writeFileSync(journalPath, JSON.stringify(journal));
  const output = out || join(dir, 'realtime.flac');

  const renderArgs = [
    new URL('./render.mjs', import.meta.url).pathname,
    '--anchor', anchor, '--out', '-', '--journal', journalPath,
    '--chunk-cycles', String(chunkCycles), '--seconds', String(Math.round(hours * 3600)),
  ];
  const started = Date.now();
  const render = spawn(process.execPath, renderArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-f', 's16le', '-ar', '48000', '-ac', '2', '-re', '-i', '-',
    '-c:a', 'flac', '-y', output,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });

  render.stdout.pipe(ffmpeg.stdin);

  let renderStderr = '';
  render.stderr.on('data', (d) => { renderStderr += d; });
  let lastProgress = null;
  let ffmpegStderr = '';
  ffmpeg.stderr.on('data', (d) => {
    const text = String(d);
    ffmpegStderr += text;
    // Progress records are \r-separated within one line; take the newest complete one.
    for (const part of text.split(/[\r\n]/)) {
      const p = parseProgress(part);
      if (p) lastProgress = p;
    }
  });

  const samples = [];
  const timer = setInterval(() => {
    const rss = rssBytes(render.pid);
    if (!Number.isFinite(rss)) return;
    const sample = { hours: (Date.now() - started) / 3600000, rss, heapUsed: 0 };
    samples.push(sample);
    onSample(sample, lastProgress);
  }, sampleSeconds * 1000);

  const [[renderCode], [ffmpegCode]] = await Promise.all([once(render, 'close'), once(ffmpeg, 'close')]);
  clearInterval(timer);
  const wallSeconds = (Date.now() - started) / 1000;

  // Silence is measured on the finished file, independently of render.mjs's own
  // guard — see parseSilence.
  let silenceStderr = '';
  try {
    silenceStderr = execFileSync('ffmpeg', [
      '-hide_banner', '-nostats', '-i', output,
      '-af', `silencedetect=n=${SILENCE_DB}dB:d=${SILENCE_SECONDS}`, '-f', 'null', '-',
    ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { silenceStderr = String(e.stderr || ''); }

  const producedSeconds = lastProgress ? lastProgress.timeSeconds : 0;
  const tolerance = driftTolerance({ chunkCycles, pipeBytes: 64 * 1024 });
  const drift = assessDrift({ producedSeconds, elapsedSeconds: wallSeconds, tolerance });
  const silence = assessSilence(parseSilence(silenceStderr));
  const analysis = analyse(samples, { totalHours: Math.max(wallSeconds / 3600, 1e-9) });

  const failures = [];
  if (renderCode !== 0) failures.push(`render.mjs exited ${renderCode}`);
  if (ffmpegCode !== 0) failures.push(`ffmpeg exited ${ffmpegCode}`);
  if (!statSync(output).size) failures.push('output file is empty');
  if (!drift.ok) failures.push(drift.reason);
  if (!silence.ok) failures.push(silence.reason);
  const rssVerdict = assessRssSlope({ slopeBytesPerHour: analysis.rssSlopeBytesPerHour, wallSeconds });
  if (!rssVerdict.ok) failures.push(rssVerdict.reason);

  return {
    hours, anchor, chunkCycles, output, wallSeconds, producedSeconds, tolerance,
    drift, silence, analysis, rssVerdict, samples, renderCode, ffmpegCode,
    finalSpeed: lastProgress ? lastProgress.speed : NaN,
    outputBytes: statSync(output).size,
    renderReport: renderStderr.trim().split('\n').filter((l) => l.startsWith('render:')).pop() || '',
    failures, passed: failures.length === 0,
  };
}

const fmtMb = (b) => `${(b / MB).toFixed(1)} MB`;
const fmtSlope = (b) => `${(b / MB).toFixed(3)} MB/h (${((b * 24) / MB).toFixed(1)} MB/day)`;

const MB = 1024 * 1024;

// The shortest run whose post-warm-up fit means anything. Below this the per-phase
// medians still sit inside one warm-up-and-GC cycle, so the fit measures where the
// sawtooth happened to be — a 5-minute run on 2026-09-13 read +83 MB/h while swinging
// 61->118->80 MB. #36 mandates 3 hours anyway, so this only ever spares a smoke run.
export const MIN_ASSESSABLE_SECONDS = 3600;

// Report the slope always; judge it only when the run could support a judgement.
// A NaN slope (linearSlope found no line) is unassessed rather than passing.
export function assessRssSlope({ slopeBytesPerHour, wallSeconds }) {
  if (wallSeconds < MIN_ASSESSABLE_SECONDS) {
    return { ok: true, assessed: false, reason: `run too short to fit a trend (${(wallSeconds / 60).toFixed(1)} min < ${MIN_ASSESSABLE_SECONDS / 60} min); slope reported, not judged` };
  }
  if (!Number.isFinite(slopeBytesPerHour)) {
    return { ok: true, assessed: false, reason: 'slope did not fit a line; not judged' };
  }
  const ok = slopeBytesPerHour <= MAX_RSS_SLOPE_BYTES_PER_HOUR;
  return {
    ok, assessed: true,
    reason: ok
      ? `${(slopeBytesPerHour / MB).toFixed(3)} MB/h is within the ${(MAX_RSS_SLOPE_BYTES_PER_HOUR / MB).toFixed(1)} MB/h endurance threshold`
      : `post-warm-up RSS slope ${(slopeBytesPerHour / MB).toFixed(3)} MB/h exceeds the ${(MAX_RSS_SLOPE_BYTES_PER_HOUR / MB).toFixed(1)} MB/h endurance threshold`,
  };
}

export function formatRealtimeReport(r) {
  const lines = [];
  lines.push(`realtime: ${r.hours} h target, anchor ${r.anchor}, chunk ${r.chunkCycles} cycles`);
  lines.push(`  produced ${(r.producedSeconds / 3600).toFixed(3)} h of audio in ${(r.wallSeconds / 3600).toFixed(3)} h wall — final speed ${Number.isFinite(r.finalSpeed) ? r.finalSpeed.toFixed(3) : '?'}x`);
  lines.push(`  drift: ${r.drift.aheadSeconds >= 0 ? '+' : ''}${r.drift.aheadSeconds.toFixed(2)}s vs realtime, bound ±${r.tolerance.toFixed(2)}s (one ${r.chunkCycles}-cycle chunk + a 64 KiB pipe) — ${r.drift.reason}`);
  lines.push(`  silence: ${r.silence.reason}`);
  lines.push(`  output: ${fmtMb(r.outputBytes)} at ${r.output}`);
  if (r.renderReport) lines.push(`  ${r.renderReport}`);
  lines.push('  phase  span (h)        samples   median RSS    min RSS     max RSS');
  for (const p of r.analysis.phases) {
    const warm = p.index < r.analysis.warmupPhases ? ' (warm-up)' : '';
    lines.push(
      `  ${String(p.index + 1).padStart(5)}  ${p.fromHours.toFixed(2).padStart(5)}–${p.toHours.toFixed(2).padEnd(5)} ` +
      `${String(p.samples).padStart(9)}  ${fmtMb(p.medianRss).padStart(11)} ${fmtMb(p.minRss).padStart(10)} ${fmtMb(p.maxRss).padStart(11)}${warm}`,
    );
  }
  lines.push(`  post-warm-up RSS slope: ${fmtSlope(r.analysis.rssSlopeBytesPerHour)}`);
  lines.push(`  RSS verdict: ${r.rssVerdict.reason}`);
  lines.push(`  (whole-run RSS slope, warm-up included: ${fmtSlope(r.analysis.wholeRunRssSlopeBytesPerHour)} — contrast, not the criterion)`);
  lines.push('  (heap is not reported: the renderer is a separate process, so only RSS is observable from here)');
  for (const f of r.failures) lines.push(`  FAIL: ${f}`);
  lines.push(`  verdict: ${r.passed ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const hours = Number(arg('hours', 3));
  const out = arg('out', undefined);
  const result = await realtime({
    hours,
    anchor: arg('anchor', DEFAULT_ANCHOR),
    chunkCycles: Number(arg('chunk-cycles', 8)),
    out,
    // Progress to stderr as it goes: a 3-hour run with no output for 3 hours is
    // indistinguishable from a hang.
    onSample: (s, p) => {
      if (Math.round(s.hours * 3600) % 300 !== 0) return;
      process.stderr.write(`  [${(s.hours * 60).toFixed(1)} min] rss ${fmtMb(s.rss)}, ffmpeg at ${p ? p.timeSeconds.toFixed(0) : '?'}s, speed ${p ? p.speed.toFixed(2) : '?'}x\n`);
    },
  });
  console.log(formatRealtimeReport(result));
  process.exitCode = result.passed ? 0 : 1;
}
