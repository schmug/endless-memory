// Joins the score model, the voice table and atmosphere drift into timed events.
// Imports only Node built-ins and ../composer.mjs — never Strudel.

import { scene, atmosphere, VOICES, BARS } from '../composer.mjs';
import { parseCycle } from './mini.mjs';
import { midiToHz } from './voices.mjs';

// One cycle is one bar; scene i covers cycles [i*BARS, (i+1)*BARS).
export const sceneIndexForCycle = (cycle) => Math.floor(cycle / BARS);

function build(voice, parsed, sceneData, drift) {
  const evt = {
    wave: voice.wave,
    attack: voice.attack,
    decay: voice.decay,
    sustain: voice.sustain,
    release: voice.release,
    gain: voice.gain * drift.gain,
    begin: parsed.begin,
    end: parsed.end,
  };

  // 'note' voices carry a MIDI pitch; 's' voices are triggers with a fixed frequency.
  evt.freq = voice.kind === 'note' ? midiToHz(parsed.value) : voice.freq ?? 440;

  let isChords = false;
  for (const filter of voice.filters) {
    const value = filter.dynamic ? sceneData[filter.dynamic] : filter.value;
    if (filter.dynamic) isChords = true;
    if (filter.type === 'lpf') evt.cutoff = value;
    else evt.hcutoff = value;
  }

  // The exported score replaces the chords voice's cutoff and release with the drifting
  // values. Every voice's gain is scaled by drift.gain, applied above.
  if (isChords) {
    evt.cutoff = drift.cutoff;
    evt.release = drift.release;
  }

  return evt;
}

export function eventsForCycles(startCycle, cycleCount, journal) {
  const events = [];
  for (let cycle = startCycle; cycle < startCycle + cycleCount; cycle++) {
    const sceneData = scene(sceneIndexForCycle(cycle), journal);
    for (const voice of VOICES) {
      for (const parsed of parseCycle(sceneData[voice.field], cycle)) {
        const drift = atmosphere(parsed.begin, journal);
        events.push(build(voice, parsed, sceneData, drift));
      }
    }
  }
  return events;
}
