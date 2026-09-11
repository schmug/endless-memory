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

// Dual-mono 16-bit LE. A silent chunk is a bug, not valid output.
function toPcm(samples) {
  const buf = Buffer.alloc(samples.length * 4);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    const s = Math.max(-32768, Math.min(32767, Math.round(Math.tanh(samples[i]) * 32767)));
    buf.writeInt16LE(s, i * 4);
    buf.writeInt16LE(s, i * 4 + 2);
  }
  return { buf, peak };
}

export async function run({ anchorCycle, chunkCycles = 8, sink, seconds = Infinity, journal }) {
  const limit = seconds === Infinity ? Infinity : Math.ceil(seconds / CYCLE_SECONDS);
  let rendered = 0;
  for (let cycle = anchorCycle; rendered < limit; cycle += chunkCycles) {
    const count = Math.min(chunkCycles, limit - rendered);
    const { buf, peak } = toPcm(renderChunk(cycle, count, journal));
    if (peak === 0) throw new Error(`silent chunk at cycle ${cycle} — this is a bug, not valid output`);
    if (!sink.write(buf)) await once(sink, 'drain');
    rendered += count;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const journalPath = new URL('../journal.json', import.meta.url);
  const journal = validate(JSON.parse(readFileSync(journalPath, 'utf8')));

  const out = arg('out');
  if (!out) throw new Error('usage: node runtime/render.mjs --anchor <ISO> --out <path> [--chunk-cycles 8] [--seconds N]');
  const sink = createWriteStream(out);
  await run({
    anchorCycle: cycleForInstant(arg('anchor', new Date().toISOString())),
    chunkCycles: Number(arg('chunk-cycles', 8)),
    seconds: arg('seconds') ? Number(arg('seconds')) : Infinity,
    sink,
    journal,
  });
  sink.end();
}
