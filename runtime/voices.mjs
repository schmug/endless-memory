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

// Seeding the noise. The seed is a pure function of absolute sample position and voice
// identity — never chunk offset, never a counter, never the wall clock — which is what
// keeps chunked output bit-identical to one-pass.
//
// The previous expression, `(startAbs * 2654435761) ^ Math.round(freq * 1000)`, was pure
// in exactly that way and still collapsed (#11). Two defects:
//
//   1. The multiply overflowed float64. At broadcast-era positions startAbs * 2654435761
//      is ~2.8e21, where the ulp is 524288, so the low 19 bits were always zero before
//      ToInt32 ever saw them: 8192 reachable seeds across 24 h of hat onsets (212,040
//      events). Worse, the ulp doubles each time startAbs crosses a power of two, so the
//      pool halved as the stream aged — measured 4096 in 2027, 1024 in 2031.
//   2. The freq term carried no identity. Both white-noise voices are triggers with no
//      freq of their own, so schedule.mjs's 440 fallback made the term a constant, and a
//      snare and a hat landing on the same onset got a bit-identical noise realization.
//
// Math.imul is exact over the full 32-bit range, so the mixing below loses nothing.

// murmur3's finalizer: avalanches a 32-bit word, so onsets one sample apart seed
// unrelated noise rather than near-neighbour streams.
function fmix32(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// FNV-1a over the voice's name. Voice identity is a name ('snares', 'hats') rather than
// a number because the parameters that would otherwise stand in for it — freq, gain,
// cutoff — are either shared or free to be retuned.
function hashName(name) {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// startAbs outgrew 2^32 long before the broadcast era (~1.05e12 in 2026), so both halves
// have to be mixed in. ToUint32 is exact for integers below 2^53, so neither half of the
// split loses a bit the way the old float multiply did.
export function noiseSeed(startAbs, voiceId) {
  const lo = startAbs >>> 0;
  const hi = Math.floor(startAbs / 4294967296) >>> 0;
  return fmix32(fmix32(hashName(voiceId) ^ lo) ^ hi);
}

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
    // schedule.mjs stamps every event with its voice's name; a synthetic event without
    // one still seeds deterministically, it just shares the unnamed voice's stream.
    const noise = evt.wave === 'white' ? makeNoise(noiseSeed(startAbs, evt.voice ?? '')) : null;

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
