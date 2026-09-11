// Chunked rendering. A chunk covers exactly samples [sampleAt(start), sampleAt(start+n)).
//
// PRE_ROLL_CYCLES exists because an event beginning before a chunk can still be sounding
// inside it — a chord spans a full cycle and releases for up to ~0.6s beyond. Querying
// only the chunk's own cycles drops those tails and produces an audible discontinuity at
// every boundary. Two cycles comfortably covers the longest event plus its release.

import { eventsForCycles } from './schedule.mjs';
import { renderEvents, sampleAt } from './voices.mjs';

export const PRE_ROLL_CYCLES = 2;

export function renderChunk(startCycle, cycleCount, journal) {
  const originSample = sampleAt(startCycle);
  const lengthSamples = sampleAt(startCycle + cycleCount) - originSample;

  const from = startCycle - PRE_ROLL_CYCLES;
  const events = eventsForCycles(from, cycleCount + PRE_ROLL_CYCLES, journal);

  return renderEvents(events, { originSample, lengthSamples });
}
