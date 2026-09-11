import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES, exportFixture } from './test/update-fixtures.mjs';

const dir = dirname(fileURLToPath(import.meta.url));

// Characterization tests, not specification. Their job is to make an accidental
// change to a listener-approved sound impossible to merge unnoticed.
for (const fixture of FIXTURES) {
  test(`export is byte-identical to the ${fixture.name} fixture`, async () => {
    const expected = await readFile(join(dir, 'test', 'fixtures', `${fixture.name}.strudel`), 'utf8');
    const { strudel } = await exportFixture(fixture);
    assert.equal(
      strudel,
      expected,
      'Export drifted from the approved sound. If this change is intentional, run `npm run fixtures` and review the diff.',
    );
  });
}

test('the weathered-night fixture still exercises motif recall', async () => {
  const fixture = FIXTURES.find((f) => f.name === 'weathered-night');
  const { score } = await exportFixture(fixture);
  const recalled = score.filter((s) => s.recalled).length;
  assert.ok(recalled > 0, `anchor ${fixture.anchor} no longer covers the recall branch`);
});
