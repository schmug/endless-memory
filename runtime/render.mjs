// Chunked rendering. A chunk covers exactly samples [sampleAt(start), sampleAt(start+n)).
//
// PRE_ROLL_CYCLES exists because an event beginning before a chunk can still be sounding
// inside it — a chord spans a full cycle and releases for up to ~0.6s beyond. Querying
// only the chunk's own cycles drops those tails and produces an audible discontinuity at
// every boundary. Two cycles comfortably covers the longest event plus its release.

import { createWriteStream, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { eventsForCycles } from './schedule.mjs';
import { renderEvents, sampleAt, SR, CYCLE_SECONDS } from './voices.mjs';
import { EPOCH, BAR_MS, validate } from '../composer.mjs';

export const PRE_ROLL_CYCLES = 2;

export function renderChunk(startCycle, cycleCount, journal) {
  const originSample = sampleAt(startCycle);
  const lengthSamples = sampleAt(startCycle + cycleCount) - originSample;

  const from = startCycle - PRE_ROLL_CYCLES;
  const events = eventsForCycles(from, cycleCount + PRE_ROLL_CYCLES, journal);

  return renderEvents(events, { originSample, lengthSamples });
}

export const cycleForInstant = (iso) => Math.floor((Date.parse(iso) - EPOCH) / BAR_MS);

// Dual-mono 16-bit LE. A silent chunk is a bug, not valid output. Samples are
// soft-clipped through tanh; occurrences (pre-clip |sample| > 1.0) are counted
// rather than silently swallowed, so run() can report them.
export function toPcm(samples) {
  const buf = Buffer.alloc(samples.length * 4);
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    if (a > 1.0) clipped++;
    const s = Math.max(-32768, Math.min(32767, Math.round(Math.tanh(samples[i]) * 32767)));
    buf.writeInt16LE(s, i * 4);
    buf.writeInt16LE(s, i * 4 + 2);
  }
  return { buf, peak, clipped };
}

// peak is always >= 0 (Math.abs starting from 0) and, barring a future refactor,
// can never become NaN — but the guard is written against NaN directly rather
// than against peak === 0, so a NaN peak trips it too instead of silently
// passing (NaN === 0 is false; !(NaN > 0) is true).
export const isSilent = (peak) => !(peak > 0);

// A continuous stream never leaves run()'s loop, so anything reported only after it
// is never reported at all (#12) — the summary has to come from inside. Every 12
// chunks is ~5 minutes of audio at the production chunkCycles of 8 (96 cycles, three
// scene boundaries), so a day of broadcast logs ~288 lines rather than drowning them.
export const REPORT_EVERY_CHUNKS = 12;

export async function run({ anchorCycle, chunkCycles = 8, sink, seconds = Infinity, journal }) {
  validate(journal);
  const limit = seconds === Infinity ? Infinity : Math.ceil(seconds / CYCLE_SECONDS);
  let rendered = 0;
  let totalClipped = 0;
  let maxPeak = 0;
  // Interval figures, reset at every periodic report: a peak from three days ago must
  // not go on masking the current one over a run that never ends.
  let chunks = 0;
  let sinceCycles = 0;
  let sinceClipped = 0;
  let sincePeak = 0;
  for (let cycle = anchorCycle; rendered < limit; cycle += chunkCycles) {
    const count = Math.min(chunkCycles, limit - rendered);
    const { buf, peak, clipped } = toPcm(renderChunk(cycle, count, journal));
    if (isSilent(peak)) throw new Error(`silent chunk at cycle ${cycle} — this is a bug, not valid output`);
    totalClipped += clipped;
    if (peak > maxPeak) maxPeak = peak;
    sinceClipped += clipped;
    if (peak > sincePeak) sincePeak = peak;
    if (!sink.write(buf)) await once(sink, 'drain');
    rendered += count;
    sinceCycles += count;
    // stderr, never stdout — stdout is a PCM channel (see F1/the stdout-banner incident).
    if (++chunks % REPORT_EVERY_CHUNKS === 0) {
      console.error(`render: +${sinceCycles} cycles since last report, peak ${sincePeak.toFixed(4)}, ${sinceClipped} clipped sample(s) in that span`);
      sinceCycles = 0;
      sinceClipped = 0;
      sincePeak = 0;
    }
  }
  // Whole-run totals. Only a finite run gets here; a stream is stopped, not finished.
  // stderr, never stdout — same reason as above.
  console.error(`render: ${rendered} cycles total, peak ${maxPeak.toFixed(4)}, ${totalClipped} clipped sample(s) over the whole run`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  // --journal points the renderer at another log; with no flag it reads the repo's
  // own, so the broadcast invocation is unchanged. Tests pass a fixture, so an
  // unrelated edit to journal.json can no longer turn them red (#20). A bare
  // --journal with no path is an error rather than a fall back to the repo's
  // journal, which would silently re-couple a caller that meant to opt out of it.
  const journalArg = arg('journal');
  if (process.argv.includes('--journal') && !journalArg) {
    console.error('--journal needs a path');
    process.exit(1);
  }
  const journalPath = journalArg ?? new URL('../journal.json', import.meta.url);
  const journal = validate(JSON.parse(readFileSync(journalPath, 'utf8')));

  const out = arg('out');
  if (!out) throw new Error('usage: node runtime/render.mjs --anchor <ISO> --out <path|-> [--journal <path>] [--chunk-cycles 8] [--seconds N]');

  const anchorArg = arg('anchor', new Date().toISOString());
  const anchorCycle = cycleForInstant(anchorArg);
  if (!Number.isFinite(anchorCycle)) {
    console.error(`invalid --anchor value: '${anchorArg}' does not parse as a date`);
    process.exit(1);
  }

  // Writing to stdout means writing to fd 1, never reopening the path. On Linux
  // /dev/stdout is /proc/self/fd/1, and libuv backs child stdio with a socketpair —
  // open() on a socket returns ENXIO, so `--out /dev/stdout` fails outright there
  // while passing on macOS. stdout is the production path (PCM piped to `ffmpeg -re`),
  // so it has to work on Linux; `-` is the conventional spelling for it.
  const isStdout = out === '-' || out === '/dev/stdout' || out === '/dev/fd/1';
  const sink = isStdout
    ? createWriteStream(null, { fd: 1, autoClose: false })
    : createWriteStream(out);
  await run({
    anchorCycle,
    chunkCycles: Number(arg('chunk-cycles', 8)),
    seconds: arg('seconds') ? Number(arg('seconds')) : Infinity,
    sink,
    journal,
  });
  sink.end();
}
