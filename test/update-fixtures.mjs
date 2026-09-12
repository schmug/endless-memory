// Golden fixture definitions and the export helper shared with export.test.mjs
// and test/pretest.mjs. Run directly (`npm run fixtures`) to regenerate the
// fixtures after a deliberate change to the sound. The regenerated files must
// be reviewed as a diff.
import { mkdtemp, cp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
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

// Spawns the real CLI in a throwaway directory. station.mjs resolves its paths
// from its own file location, so the copy reads and writes only inside `work`
// and never touches the repo or its journal.
export async function exportFixture(fixture) {
  const work = await mkdtemp(join(tmpdir(), 'endless-memory-'));
  try {
    await cp(join(repo, 'composer.mjs'), join(work, 'composer.mjs'));
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
  await mkdir(join(dir, 'fixtures'), { recursive: true });
  for (const fixture of FIXTURES) {
    const { strudel, score } = await exportFixture(fixture);
    await writeFile(join(dir, 'fixtures', `${fixture.name}.strudel`), strudel);
    const recalled = score.filter((s) => s.recalled).length;
    const handoffs = score.filter((s) => s.transitioning).length;
    console.log(`${fixture.name}: ${Buffer.byteLength(strudel)} bytes, ${score.length} scenes, ${recalled} recalled, ${handoffs} handoffs`);
  }
}
