// Endurance check — spec acceptance criterion 4 (#13): a continuous render of at
// least 24 simulated hours completes with zero silent chunks and no memory growth
// beyond warm-up.
//
// Deliberately NOT part of `npm test`. It renders a simulated day, which takes
// minutes; the suite is meant to stay interactive. Run it with `npm run endurance`.
//
// Two measurement decisions, both made against false positives this project has
// already produced:
//
// 1. The trend is fitted on per-phase medians, never on raw samples. RSS under a
//    GC that collects lazily is a sawtooth, so a fit over raw samples measures
//    where the sawtooth happened to be rather than the trend.
// 2. Warm-up phases are excluded from the fit. A whole-run linear fit on this
//    project once reported "+111 MB/day" for a process that was flat after
//    warm-up: the climb from startup to steady state dominated the fit and was
//    read as a leak. `analyse()` reports the whole-run slope too, precisely so
//    that the gap between the two is visible rather than a matter of trust.
//
// Silent chunks are counted here independently of render.mjs's own guard. run()
// throws on the first silent chunk, which would abort this script — but a count
// that only ever reads zero because the process died proves nothing, so the sink
// inspects the PCM it is handed and reports what it saw.

import { Writable } from 'node:stream';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { run, cycleForInstant } from './render.mjs';
import { SR } from './voices.mjs';

const MB = 1024 * 1024;
// toPcm() writes each mono sample twice, 16-bit LE: four bytes of output per sample.
const BYTES_PER_SAMPLE = 4;

// A fixed default anchor, for the same reason fixtures pin one: a run that reads
// the wall clock cannot be compared against the run recorded last week.
export const DEFAULT_ANCHOR = '2026-09-11T12:00:00Z';

// The quiet journal, matching the golden fixture's. Held as a literal rather than
// read from the repo's journal.json so that editing that data file cannot silently
// change what this check measures (#19, #20). Override with --journal.
export const DEFAULT_JOURNAL = { version: 1, seed: 'window-seat-v1', events: [] };

// Post-warm-up growth allowed before the run is called a failure, in bytes of RSS
// per simulated hour. 2 MB/h is ~48 MB/day: comfortably above the sampling noise
// measured on a flat run, and far below any leak that would matter over a week of
// broadcast. The recorded evidence in the audio-runtime spec gives the observed
// figure, which is what this threshold has margin over.
export const MAX_RSS_SLOPE_BYTES_PER_HOUR = 2 * MB;

export function median(xs) {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Ordinary least squares. Returns slope in y-units per x-unit, or NaN when the
// points do not determine a line (fewer than two, or all at the same x).
export function linearSlope(points) {
  const n = points.length;
  if (n < 2) return NaN;
  let sx = 0, sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;
  let num = 0, den = 0;
  for (const p of points) {
    const dx = p.x - mx;
    num += dx * (p.y - my);
    den += dx * dx;
  }
  return den === 0 ? NaN : num / den;
}

// Bucket samples into `phaseCount` equal spans of simulated time. Each phase
// reports a median (the trend figure) alongside min and max, so a phase whose
// median is flat but whose peak is climbing is still visible.
export function phaseStats(samples, totalHours, phaseCount) {
  const phases = Array.from({ length: phaseCount }, (_, i) => ({
    index: i,
    fromHours: (i * totalHours) / phaseCount,
    toHours: ((i + 1) * totalHours) / phaseCount,
    rss: [],
    heapUsed: [],
  }));
  for (const s of samples) {
    const i = Math.min(phaseCount - 1, Math.floor((s.hours / totalHours) * phaseCount));
    phases[i].rss.push(s.rss);
    phases[i].heapUsed.push(s.heapUsed);
  }
  return phases.map((p) => ({
    index: p.index,
    fromHours: p.fromHours,
    toHours: p.toHours,
    samples: p.rss.length,
    medianRss: median(p.rss),
    // Reduced rather than spread into Math.min/max: a long run with few phases
    // puts tens of thousands of samples in a bucket, and spreading that many
    // arguments overflows the stack.
    minRss: p.rss.length ? p.rss.reduce((a, b) => (b < a ? b : a), Infinity) : NaN,
    maxRss: p.rss.length ? p.rss.reduce((a, b) => (b > a ? b : a), -Infinity) : NaN,
    medianHeapUsed: median(p.heapUsed),
  }));
}

export function analyse(samples, { totalHours, phaseCount = 8, warmupPhases = 1 } = {}) {
  const phases = phaseStats(samples, totalHours, phaseCount);
  const mid = (p) => (p.fromHours + p.toHours) / 2;
  const populated = phases.filter((p) => p.samples > 0);
  const steady = populated.filter((p) => p.index >= warmupPhases);

  const rssSlope = linearSlope(steady.map((p) => ({ x: mid(p), y: p.medianRss })));
  const heapSlope = linearSlope(steady.map((p) => ({ x: mid(p), y: p.medianHeapUsed })));
  // Reported only for contrast with rssSlope — this is the figure that produced
  // the historical "+111 MB/day" false positive.
  const wholeRunRssSlope = linearSlope(populated.map((p) => ({ x: mid(p), y: p.medianRss })));

  return {
    phases,
    warmupPhases,
    rssSlopeBytesPerHour: rssSlope,
    heapSlopeBytesPerHour: heapSlope,
    wholeRunRssSlopeBytesPerHour: wholeRunRssSlope,
    steadyPhases: steady.length,
  };
}

// Discards the PCM, but counts what went past and samples memory as it does.
// Sampling here rather than on a timer ties every sample to a known position in
// the render, so phases are spans of music rather than of wall clock.
export function meteringSink() {
  const samples = [];
  let chunks = 0;
  let silentChunks = 0;
  let bytes = 0;

  const stream = new Writable({
    write(buf, _enc, cb) {
      chunks++;
      bytes += buf.length;
      // Dual-mono 16-bit LE. Any nonzero sample settles it, so a normal chunk
      // exits in the first iterations; only a truly silent chunk is scanned whole.
      let silent = true;
      for (let i = 0; i + 1 < buf.length; i += 2) {
        if (buf.readInt16LE(i) !== 0) { silent = false; break; }
      }
      if (silent) silentChunks++;
      samples.push({
        hours: bytes / BYTES_PER_SAMPLE / SR / 3600,
        rss: process.memoryUsage.rss(),
        heapUsed: process.memoryUsage().heapUsed,
      });
      cb();
    },
  });

  return {
    stream,
    samples,
    get chunks() { return chunks; },
    get silentChunks() { return silentChunks; },
    get bytes() { return bytes; },
  };
}

const fmtMb = (b) => `${(b / MB).toFixed(1)} MB`;
const fmtSlope = (b) => `${(b / MB).toFixed(3)} MB/h (${((b * 24) / MB).toFixed(1)} MB/day)`;

export function formatReport(result) {
  const lines = [];
  lines.push(`endurance: ${result.hours} simulated hours, anchor ${result.anchor}, chunk ${result.chunkCycles} cycles`);
  lines.push(`  rendered ${result.chunks} chunks (${result.renderedHours.toFixed(2)} h of audio) in ${result.wallSeconds.toFixed(1)} s wall — ${result.realtimeFactor.toFixed(0)}x realtime`);
  lines.push(`  silent chunks: ${result.silentChunks}`);
  lines.push('  phase  span (h)        samples   median RSS    min RSS     max RSS   median heap');
  for (const p of result.analysis.phases) {
    const warm = p.index < result.analysis.warmupPhases ? ' (warm-up)' : '';
    lines.push(
      `  ${String(p.index + 1).padStart(5)}  ${p.fromHours.toFixed(1).padStart(5)}–${p.toHours.toFixed(1).padEnd(5)} ` +
      `${String(p.samples).padStart(9)}  ${fmtMb(p.medianRss).padStart(11)} ${fmtMb(p.minRss).padStart(10)} ` +
      `${fmtMb(p.maxRss).padStart(11)}  ${fmtMb(p.medianHeapUsed).padStart(11)}${warm}`,
    );
  }
  lines.push(`  post-warm-up RSS slope:  ${fmtSlope(result.analysis.rssSlopeBytesPerHour)}`);
  lines.push(`  post-warm-up heap slope: ${fmtSlope(result.analysis.heapSlopeBytesPerHour)}`);
  lines.push(`  (whole-run RSS slope, warm-up included: ${fmtSlope(result.analysis.wholeRunRssSlopeBytesPerHour)} — reported for contrast, not the criterion)`);
  for (const f of result.failures) lines.push(`  FAIL: ${f}`);
  lines.push(`  verdict: ${result.passed ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

export async function endurance({
  hours = 24,
  anchor = DEFAULT_ANCHOR,
  journal = DEFAULT_JOURNAL,
  chunkCycles = 8,
  phaseCount = 8,
  warmupPhases = 1,
} = {}) {
  const sink = meteringSink();
  const startedAt = process.hrtime.bigint();
  await run({
    anchorCycle: cycleForInstant(anchor),
    chunkCycles,
    sink: sink.stream,
    seconds: hours * 3600,
    journal,
  });
  const wallSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

  const renderedHours = sink.bytes / BYTES_PER_SAMPLE / SR / 3600;
  const analysis = analyse(sink.samples, { totalHours: renderedHours, phaseCount, warmupPhases });

  const failures = [];
  if (sink.silentChunks > 0) failures.push(`${sink.silentChunks} silent chunk(s)`);
  if (renderedHours < hours) failures.push(`rendered only ${renderedHours.toFixed(2)} of ${hours} simulated hours`);
  if (!Number.isFinite(analysis.rssSlopeBytesPerHour)) {
    failures.push('post-warm-up RSS slope could not be fitted');
  } else if (analysis.rssSlopeBytesPerHour > MAX_RSS_SLOPE_BYTES_PER_HOUR) {
    failures.push(
      `post-warm-up RSS slope ${fmtSlope(analysis.rssSlopeBytesPerHour)} exceeds the ` +
      `${fmtSlope(MAX_RSS_SLOPE_BYTES_PER_HOUR)} budget`,
    );
  }

  return {
    hours,
    anchor,
    chunkCycles,
    chunks: sink.chunks,
    silentChunks: sink.silentChunks,
    renderedHours,
    wallSeconds,
    realtimeFactor: (renderedHours * 3600) / wallSeconds,
    analysis,
    failures,
    passed: failures.length === 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };

  const journalArg = arg('journal');
  if (process.argv.includes('--journal') && !journalArg) {
    console.error('--journal needs a path');
    process.exit(1);
  }

  const result = await endurance({
    hours: Number(arg('hours', 24)),
    anchor: arg('anchor', DEFAULT_ANCHOR),
    chunkCycles: Number(arg('chunk-cycles', 8)),
    phaseCount: Number(arg('phases', 8)),
    journal: journalArg ? JSON.parse(readFileSync(journalArg, 'utf8')) : DEFAULT_JOURNAL,
  });

  console.log(formatReport(result));

  const json = arg('json');
  if (json) {
    writeFileSync(json, JSON.stringify(result, null, 2) + '\n');
    console.log(`  wrote ${json}`);
  }

  if (!result.passed) process.exit(1);
}
