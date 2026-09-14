// Pure score model. No wall-clock reads, network access, or mutation during queries.
export const BPM = 76;
export const BARS = 32;
export const BAR_MS = 240000 / BPM;
export const EPOCH = Date.parse('2026-01-01T00:00:00Z');
export function hash(value) {
  let h = 2166136261;
  for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
export function pick(key, values) { return values[hash(key) % values.length]; }
// Sample at each event's onset so scheduler query sizes cannot change the sound.
export function atmosphere(bar, journal) {
  const at = EPOCH + bar * BAR_MS;
  const settle = 240000; // Four-minute time constant; mostly settled after 12 minutes.
  let cutoff = 1800, target = 1800, previous = EPOCH;
  const observations = journal.events.filter(e => e.type === 'weather')
    .map(e => ({...e, boundary:EPOCH + Math.ceil((Date.parse(e.at)-EPOCH)/(BARS*BAR_MS))*BARS*BAR_MS}))
    .filter(e => e.boundary <= at)
    .sort((a,b) => a.boundary-b.boundary || Date.parse(a.at)-Date.parse(b.at) || a.id.localeCompare(b.id));
  for (const e of observations) {
    cutoff = target + (cutoff-target)*Math.exp(-(e.boundary-previous)/settle);
    previous = e.boundary;
    target = e.value === 'rain' ? 1100 : e.value === 'snow' ? 850 : e.value === 'cloudy' ? 1500 : 1800;
  }
  cutoff = target + (cutoff-target)*Math.exp(-(at-previous)/settle);
  const offset = (hash(journal.seed) % 1000)/1000 * Math.PI*2;
  return {
    cutoff: cutoff * (1 + .07*Math.sin(bar*2*Math.PI/173+offset)),
    gain: 1 + .025*Math.sin(bar*2*Math.PI/251+offset),
    release: .6 + .045*Math.sin(bar*2*Math.PI/211+offset),
  };
}
export function validate(journal) {
  if (journal.version !== 1 || !Array.isArray(journal.events)) throw Error('Unsupported journal');
  const ids = new Set();
  for (const e of journal.events) {
    if (!e.id || ids.has(e.id) || !Number.isFinite(Date.parse(e.at))) throw Error('Invalid or duplicate event');
    ids.add(e.id);
    if (e.type === 'weather' && !['clear','cloudy','rain','snow'].includes(e.value)) throw Error('Unknown weather');
    if (e.type === 'remember' && !/^m[0-9]{1,8}$/.test(e.motif)) throw Error('Invalid motif');
    if (!['weather','remember'].includes(e.type)) throw Error('Unknown event');
  }
  return journal;
}
export function identity(index, journal) {
  const at = EPOCH + index * BARS * BAR_MS;
  // Events only take effect at scene boundaries. Stable tie ordering is part of v1.
  const events = journal.events.filter(e => Date.parse(e.at) <= at)
    .sort((a,b) => Date.parse(a.at)-Date.parse(b.at) || a.id.localeCompare(b.id));
  const weatherEvent = events.filter(e => e.type === 'weather').at(-1);
  const weather = weatherEvent?.value ?? 'clear';
  const weatherKnown = !!weatherEvent;
  const day = new Date(at).toISOString().slice(0,10);
  const hour = new Date(at).getUTCHours();
  const phase = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 19 ? 'afternoon' : 'evening';
  const seed = journal.seed + ':' + day + ':' + (weatherEvent?.id ?? 'quiet');
  const born = 'm' + (hash(seed) % 100000000);
  // Recent remembered themes gradually lose influence; explicit favorites recur longer.
  const remembered = events.filter(e => e.type === 'remember' && at-Date.parse(e.at) < 30*86400000);
  const candidates = [...new Set(remembered.map(e => e.motif))];
  const recall = candidates.length > 0 && hash(index + ':recall') % 4 === 0;
  const motif = recall ? pick(index + ':memory', candidates) : born;
  const progressions = [[0,5,3,4],[0,3,5,4],[0,5,1,4]];
  const progression = pick(day + ':harmony', progressions);
  return {at, motif, recalled:recall, weather, weatherKnown, phase, progression};
}
export function scene(index, journal) {
  const current = identity(index,journal);
  const previous = identity(index-1,journal);
  const {at,motif,recalled,weather,weatherKnown,phase,progression} = current;
  const degrees = Array.from({length:8},(_,i)=>pick(motif + ':pitch:' + i,[0,2,4,6,7,9,11]));
  const oldDegrees = Array.from({length:8},(_,i)=>pick(previous.motif + ':pitch:' + i,[0,2,4,6,7,9,11]));
  const transitioning = previous.motif !== motif;
  const scale = [0,2,3,5,7,8,10]; // A minor, shared by every remembered theme.
  const pitch = d => 57 + scale[((d%7)+7)%7] + 12*Math.floor(d/7);
  const chords = [], bass = [], melody = [], hats = [], kicks = [], snares = [];
  for (let bar=0; bar<BARS; bar++) {
    const root = progression[Math.floor(bar/2)%4];
    const breakBar = bar >= 28; // Thin hats slightly; preserve the backbeat.
    const phrase = Math.floor((index*BARS+bar)/8);
    const variation = hash((transitioning && bar<28 ? previous.motif : motif) + ':variation:' + phrase)%4 === 0;
    chords.push('[' + [0,2,4,6].map(d=>pitch(root+d)).join(',') + ']');
    bass.push('[' + (pitch(root)-24) + ' ~ ' + (pitch(root)-12) + ' ~]');
    // A recognizable rhythmic signature repeats; each fourth phrase leaves room.
    const active = bar%8 < 6 && !(phase==='night' && bar%2);
    melody.push(active ? '[' + degrees.map((target,i) => { const d = transitioning && i >= Math.floor(bar/4) ? oldDegrees[i] : target; return i===1 || i===4 || (bar%4===3 && i>5) ? '~' : pitch(root+((d+(variation && i===7 ? 1 : 0))%7))+12; }).join(' ') + ']' : '~');
    hats.push(breakBar ? '[1 ~ 1 1 1 ~ 1 1]' : '[1 1 1 1 1 1 1 1]');
    kicks.push(breakBar ? '[1 ~ ~ ~]' : pick(index + ':kick:' + (bar%4), ['[1 ~ ~ ~]','[1 ~ ~ 1]']));
    snares.push('[~ 1 ~ 1]');
  }
  const wrap = a => '<' + a.join(' ') + '>';
  return {index, at:new Date(at).toISOString(), motif, previousMotif:previous.motif, transitioning, recalled, weather, weatherKnown, phase,
    cutoff: 1800,
    chords:wrap(chords), bass:wrap(bass), melody:wrap(melody), hats:wrap(hats), kicks:wrap(kicks), snares:wrap(snares)};
}
// One source of truth for every voice's synthesis parameters. patternSource()
// assembles the generated string from this table instead of a template literal
// so the audio runtime can import the same data. A filter's `dynamic` field
// names a scene property the generated source reads at render time (the chords'
// cutoff drifts with weather); a `value` field is a fixed constant instead.
export const VOICES = [
  { field: 'chords', kind: 'note', wave: 'triangle',
    attack: .06, decay: .7, sustain: .25, release: .6,
    filters: [{ type: 'lpf', dynamic: 'cutoff' }], gain: .14 },
  { field: 'bass', kind: 'note', wave: 'sine',
    attack: .012, decay: .25, sustain: .15, release: .15,
    filters: [], gain: .26 },
  { field: 'melody', kind: 'note', wave: 'triangle',
    attack: .01, decay: .16, sustain: 0, release: .18,
    filters: [{ type: 'lpf', value: 2300 }], gain: .09 },
  { field: 'kicks', kind: 's', wave: 'sine', freq: 52,
    attack: .002, decay: .13, sustain: 0, release: .04,
    filters: [], gain: .32 },
  { field: 'snares', kind: 's', wave: 'white',
    attack: .001, decay: .08, sustain: 0, release: .025,
    filters: [{ type: 'hpf', value: 1100 }, { type: 'lpf', value: 4200 }], gain: .07 },
  { field: 'hats', kind: 's', wave: 'white',
    attack: .001, decay: .018, sustain: 0, release: .008,
    filters: [{ type: 'hpf', value: 6500 }], gain: .025 },
];
// The generated source strips leading zeros from decimals (.06, not 0.06).
function fmt(n) {
  const str = String(n);
  return str.startsWith('0.') ? str.slice(1) : str;
}
// Emits an expression, not a rendered scene. Every scene-dependent value is a
// property read off a `part` variable at render time, so the voice's field name
// and its dynamic filter are taken straight from VOICES and never have to be
// recovered from the generated text.
function voiceSource(voice) {
  const pattern = `mini(part.${voice.field})`;
  let out = voice.kind === 'note'
    ? `note(${pattern}).s('${voice.wave}')`
    : `s('${voice.wave}').struct(${pattern})`;
  if (voice.freq !== undefined) out += `.freq(${fmt(voice.freq)})`;
  out += `.attack(${fmt(voice.attack)}).decay(${fmt(voice.decay)}).sustain(${fmt(voice.sustain)}).release(${fmt(voice.release)})`;
  for (const filter of voice.filters) out += `.${filter.type}(${filter.dynamic ? `part.${filter.dynamic}` : fmt(filter.value)})`;
  out += `.gain(${fmt(voice.gain)})`;
  return out;
}
// Valid only where `part` is a scene in scope. station.mjs's export embeds this
// inside the per-scene cache that binds it.
export function patternSource() {
  return `stack(\n  ${VOICES.map(voice => voiceSource(voice)).join(',\n  ')}\n)`;
}
// One voice's gain, formatted as it appears in the generated source. The
// generated runtime has no voice labels on its haps, so it tells them apart by
// gain; that literal comes from here rather than being restated, because a
// hand-synced copy desyncs silently — the export still parses and the sound
// quietly loses its weather response. This discriminates only while the voices'
// gains stay distinct, so emitting a gain that is not unique across VOICES
// throws rather than producing an export that routes one voice's weather drift
// to another. The gains are distinct today; the check is a gate on future edits
// and never fires on the shipped table, so it moves no generated bytes.
export function gainSource(field) {
  const voice = VOICES.find(v => v.field === field);
  if (!voice) throw Error(`No voice named ${field} in VOICES`);
  const sharing = VOICES.filter(v => v.gain === voice.gain).map(v => v.field);
  if (sharing.length > 1) {
    throw Error(`Voices ${sharing.join(', ')} all have gain ${fmt(voice.gain)} in VOICES. The generated source tells voices apart by gain, so they would share the chords' weather drift. Give each voice a distinct gain.`);
  }
  return fmt(voice.gain);
}
