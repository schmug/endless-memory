// Renders parameterised events to PCM. No dependencies.
//
// Every sample position and every noise seed derives from ABSOLUTE musical time. This is
// deliberate and load-bearing: it is what lets a span be rendered in chunks and come out
// bit-identical to rendering it in one pass (see runtime/render.test.mjs). An earlier
// version positioned events and seeded noise relative to the chunk, and chunked output
// differed from one-pass by -23.5 dB at every boundary.

export const SR = 48000;
export const CYCLE_SECONDS = 240 / 76; // setcps(76/60/4)

export const sampleAt = (absCycle, sampleRate = SR, cycleSeconds = CYCLE_SECONDS) =>
  Math.round(absCycle * cycleSeconds * sampleRate);

const midiToHz = (n) => 440 * Math.pow(2, (n - 69) / 12);
export { midiToHz };

// xorshift32 — deterministic, seeded per event from its absolute sample position.
function makeNoise(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s / 4294967296) * 2 - 1;
  };
}

function envelope(t, dur, { attack = 0.001, decay = 0.05, sustain = 0, release = 0.01 }) {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  if (t < attack + decay) return 1 + (sustain - 1) * ((t - attack) / decay);
  if (t < dur) return sustain;
  const r = t - dur;
  return r < release ? sustain * (1 - r / release) : 0;
}

export function renderEvents(events, { sampleRate = SR, cycleSeconds = CYCLE_SECONDS, originSample = 0, lengthSamples }) {
  const out = new Float32Array(lengthSamples);

  for (const evt of events) {
    const startAbs = sampleAt(evt.begin, sampleRate, cycleSeconds);
    const endAbs = sampleAt(evt.end, sampleRate, cycleSeconds);
    const dur = (endAbs - startAbs) / sampleRate;
    const release = evt.release ?? 0.01;
    const start = startAbs - originSample;
    const total = Math.ceil((dur + release) * sampleRate);
    if (start + total < 0 || start >= lengthSamples) continue;

    const gain = evt.gain ?? 0.2;
    const freq = evt.freq;
    const noise = evt.wave === 'white' ? makeNoise((startAbs * 2654435761) ^ Math.round(freq * 1000)) : null;

    const lpA = evt.cutoff ? 1 - Math.exp((-2 * Math.PI * evt.cutoff) / sampleRate) : null;
    const hpA = evt.hcutoff ? 1 / (1 + (2 * Math.PI * evt.hcutoff) / sampleRate) : null;
    let lpZ = 0, hpY = 0, hpX = 0, phase = 0;
    const increment = freq / sampleRate;

    for (let i = 0; i < total; i++) {
      const t = i / sampleRate;
      const env = envelope(t, dur, evt);

      let x;
      if (noise) x = noise();
      else if (evt.wave === 'triangle') { const p = phase % 1; x = 4 * Math.abs(p - 0.5) - 1; }
      else x = Math.sin(2 * Math.PI * phase);
      phase += increment;

      if (hpA !== null) { const y = hpA * (hpY + x - hpX); hpX = x; hpY = y; x = y; }
      if (lpA !== null) { lpZ += lpA * (x - lpZ); x = lpZ; }

      if (env === 0 && t > dur) break;

      const idx = start + i;
      if (idx >= 0 && idx < lengthSamples) out[idx] += x * env * gain;
    }
  }

  return out;
}
