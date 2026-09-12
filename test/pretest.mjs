// Generates the repo-root `endless-memory.strudel` that composer.test.mjs:26
// reads and never creates. Wired to the `pretest` script; without it a clean
// checkout fails with ENOENT.
//
// The export goes through exportFixture, which spawns the CLI in a temp dir
// against the journal literal below, so the repo's own journal.json is never
// read. A malformed journal.json therefore cannot stop `node --test` from
// starting. See issue #6.
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportFixture } from './update-fixtures.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The anchor is explicit because `station.mjs export` with no argument reads
// the wall clock. Any valid anchor works — composer.test.mjs asserts structural
// bounds on the generated pattern, not its values.
const { strudel } = await exportFixture({
  anchor: '2026-09-11T14:00:00Z',
  journal: { version: 1, seed: 'window-seat-v1', events: [] },
});

await writeFile(join(repo, 'endless-memory.strudel'), strudel);
