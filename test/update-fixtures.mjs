// Golden fixture definitions, the two-layer fixture format, and the export
// helper shared with export.test.mjs, runtime/schedule.test.mjs and
// test/pretest.mjs. Run directly (`npm run fixtures`) to regenerate the fixtures
// after a deliberate change to the sound. The regenerated files must be reviewed
// as a diff. An optional argument writes them somewhere else
// (`node test/update-fixtures.mjs /tmp/out`), which is how a regeneration can be
// checked against what is committed without overwriting it.
import { mkdtemp, cp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const dir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(dir, '..');

// Anchors are fixed because `station.mjs export` with no argument reads the wall
// clock. Their coverage is recorded in the implementation plan; the recall
// assertion in export.test.mjs guards it from drifting silently.
export const FIXTURES = [
  {
    name: 'quiet-afternoon',
    anchor: '2026-09-11T14:00:00Z',
    journal: { version: 1, seed: 'window-seat-v1', events: [] },
  },
  {
    name: 'weathered-night',
    anchor: '2026-09-11T02:00:00Z',
    journal: {
      version: 1,
      seed: 'window-seat-v1',
      events: [
        // m8329137 is the motif the engine derives for 2026-09-09 with no
        // weather in effect: hash('window-seat-v1:2026-09-09:quiet') % 1e8.
        { id: 'fixture-remember-1', at: '2026-09-09T12:00:00Z', type: 'remember', motif: 'm8329137' },
        { id: 'fixture-weather-1', at: '2026-09-10T18:00:00Z', type: 'weather', value: 'rain' },
      ],
    },
  },
];

// The two-layer fixture format (issue #3). Every export is one engine text with
// three per-anchor values dropped into it: the two fixtures were 107 lines each
// differing at exactly 3, so 104 of every 107 lines was a second copy of the
// engine. The lock's value is a human reading the diff to decide whether a sound
// change was intended, and that reader had two near-identical engine dumps to
// work through with nothing in either naming the music.
//
// The fixtures now store the engine once, in `fixtures/engine.strudel` with each
// per-anchor value replaced by its placeholder, plus one small
// `fixtures/<name>.json` per anchor holding the pinned text of those values and
// the 45-minute score. export.test.mjs reassembles the two and still asserts byte
// equality of the whole reconstructed source against what the exporter produces.
//
// engine.strudel is a template, not a playable score. `{{JOURNAL}}` and
// `{{START_BAR}}` sit in expression position, so pasting it into Strudel is a
// parse error rather than a quietly wrong sound.
export const ENGINE_SNAPSHOT = 'engine.strudel';

// Each value occupies one whole line of the export, located by the text around
// it. A prefix that no longer matches exactly once fails the split loudly rather
// than guessing, and confining a value to a single line is what stops engine
// source from being absorbed into the per-anchor layer by accident.
export const LAYERS = [
  {
    key: 'anchor',
    placeholder: '{{ANCHOR}}',
    prefix: '// Score anchor: ',
    suffix: '. UTC day phases. Replay starts here, not at the current clock.',
  },
  { key: 'journal', placeholder: '{{JOURNAL}}', prefix: 'const journal=', suffix: ';' },
  { key: 'startBar', placeholder: '{{START_BAR}}', prefix: 'const startBar=', suffix: ';' },
];

// Text substitution and nothing else. Nothing here recomputes a value from
// composer.mjs — a reassembly that derived startBar from the anchor, say, would
// move with an engine change that moved the real one, and the byte-identity test
// would then be comparing two things that had drifted together. The sentinel
// test in export.test.mjs is what holds this to substitution.
export function reassemble(engine, values) {
  let source = engine;
  for (const layer of LAYERS) {
    const value = values[layer.key];
    if (typeof value !== 'string') throw Error(`no pinned text for ${layer.key}`);
    // split/join rather than replace(): a replacement string containing `$&` or
    // `$'` is a substitution pattern to replace() and would be mangled.
    const parts = source.split(layer.placeholder);
    if (parts.length !== 2) {
      throw Error(`expected exactly one ${layer.placeholder} in ${ENGINE_SNAPSHOT}, found ${parts.length - 1}`);
    }
    source = parts[0] + value + parts[1];
  }
  return source;
}

// Exact inverse of reassemble(), used only when regenerating.
export function splitExport(strudel) {
  for (const layer of LAYERS) {
    if (strudel.includes(layer.placeholder)) throw Error(`the export already contains ${layer.placeholder}`);
  }
  const lines = strudel.split('\n');
  const values = {};
  for (const layer of LAYERS) {
    const hits = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) =>
        line.startsWith(layer.prefix) &&
        line.endsWith(layer.suffix) &&
        line.length > layer.prefix.length + layer.suffix.length);
    if (hits.length !== 1) {
      throw Error(`expected exactly one '${layer.prefix}…${layer.suffix}' line in the export, found ${hits.length}`);
    }
    const { line, index } = hits[0];
    values[layer.key] = line.slice(layer.prefix.length, line.length - layer.suffix.length);
    lines[index] = layer.prefix + layer.placeholder + layer.suffix;
  }
  return { engine: lines.join('\n'), values };
}

// Reads the committed two-layer fixture and hands back the same shape
// exportFixture() returns, so a caller comparing the two compares whole sources.
// Memoized for the same reason exportOnce() is: several tests want the same one.
const loaded = new Map();
export function readFixture(name) {
  if (!loaded.has(name)) {
    const engine = readFileSync(join(dir, 'fixtures', ENGINE_SNAPSHOT), 'utf8');
    const pinned = JSON.parse(readFileSync(join(dir, 'fixtures', `${name}.json`), 'utf8'));
    const values = Object.fromEntries(LAYERS.map((layer) => [layer.key, pinned[layer.key]]));
    loaded.set(name, { engine, values, score: pinned.score, strudel: reassemble(engine, values) });
  }
  return loaded.get(name);
}

// One scene per line. JSON.stringify's own indentation puts each of the nine
// fields on its own line, which turns a single changed motif into an eleven-line
// diff hunk and buries the scene it belongs to.
function anchorFixtureText({ values, score }) {
  const fields = LAYERS.map((layer) => `  ${JSON.stringify(layer.key)}: ${JSON.stringify(values[layer.key])},`);
  const scenes = score.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n');
  return ['{', ...fields, '  "score": [', scenes, '  ]', '}', ''].join('\n');
}

// Spawns the real CLI in a throwaway directory. station.mjs resolves its paths
// from its own file location, so the copy reads and writes only inside `work`
// and never touches the repo or its journal.
// `patchComposer` rewrites the copied composer.mjs before the export runs. It
// exists so a test can prove the generated source tracks the VOICES table
// rather than restating it; the fixture path never passes it.
export async function exportFixture(fixture, { patchComposer } = {}) {
  const work = await mkdtemp(join(tmpdir(), 'endless-memory-'));
  try {
    const composer = await readFile(join(repo, 'composer.mjs'), 'utf8');
    await writeFile(join(work, 'composer.mjs'), patchComposer ? patchComposer(composer) : composer);
    await cp(join(repo, 'station.mjs'), join(work, 'station.mjs'));
    await writeFile(join(work, 'journal.json'), JSON.stringify(fixture.journal, null, 2) + '\n');
    await run(process.execPath, ['station.mjs', 'export', fixture.anchor], { cwd: work });
    return {
      strudel: await readFile(join(work, 'endless-memory.strudel'), 'utf8'),
      score: JSON.parse(await readFile(join(work, 'score-45min.json'), 'utf8')),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// One export per fixture per process. The byte-identity test and the recall
// assertion both need weathered-night; without this they spawn the CLI twice.
const exported = new Map();
export function exportOnce(fixture) {
  if (!exported.has(fixture.name)) exported.set(fixture.name, exportFixture(fixture));
  return exported.get(fixture.name);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = resolve(process.argv[2] ?? join(dir, 'fixtures'));
  await mkdir(out, { recursive: true });
  let snapshot = null;
  for (const fixture of FIXTURES) {
    const { strudel, score } = await exportFixture(fixture);
    const { engine, values } = splitExport(strudel);
    // The shared layer only works because every anchor produces the same engine
    // text. If that ever stops being true, writing one snapshot would silently
    // drop whatever else varies, so refuse here rather than leave export.test.mjs
    // to report it as a mismatch with no explanation.
    if (snapshot === null) snapshot = engine;
    else if (engine !== snapshot) throw Error(`${fixture.name} produced different engine text; something outside the pinned layers now varies per anchor`);
    await writeFile(join(out, `${fixture.name}.json`), anchorFixtureText({ values, score }));
    const recalled = score.filter((s) => s.recalled).length;
    const handoffs = score.filter((s) => s.transitioning).length;
    console.log(`${fixture.name}: ${Buffer.byteLength(strudel)} bytes reassembled, ${score.length} scenes, ${recalled} recalled, ${handoffs} handoffs`);
  }
  await writeFile(join(out, ENGINE_SNAPSHOT), snapshot);
  console.log(`${ENGINE_SNAPSHOT}: ${Buffer.byteLength(snapshot)} bytes shared by ${FIXTURES.length} anchors`);
}
