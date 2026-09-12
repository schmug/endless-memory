import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES, exportFixture, exportOnce } from './test/update-fixtures.mjs';

const dir = dirname(fileURLToPath(import.meta.url));

// Characterization tests, not specification. Their job is to make an accidental
// change to a listener-approved sound impossible to merge unnoticed.
for (const fixture of FIXTURES) {
  test(`export is byte-identical to the ${fixture.name} fixture`, async () => {
    const expected = await readFile(join(dir, 'test', 'fixtures', `${fixture.name}.strudel`), 'utf8');
    const { strudel } = await exportOnce(fixture);
    assert.equal(
      strudel,
      expected,
      'Export drifted from the approved sound. If this change is intentional, run `npm run fixtures` and review the diff.',
    );
  });
}

test('the weathered-night fixture still exercises motif recall', async () => {
  const fixture = FIXTURES.find((f) => f.name === 'weathered-night');
  assert.ok(fixture, 'no fixture named weathered-night; update this test if it was renamed');
  const { score } = await exportOnce(fixture);
  const recalled = score.filter((s) => s.recalled).length;
  assert.ok(recalled > 0, `anchor ${fixture.anchor} no longer covers the recall branch`);
});

// The generated runtime decides which haps receive weather drift by comparing
// their gain to the chords voice's. That literal has to be emitted from VOICES:
// a hand-copied one desyncs the moment the chords gain changes, and nothing
// notices, because the output still parses and `npm run fixtures` would bless
// the broken version. Exporting against a patched VOICES is the only way to see
// the coupling — at the shipped gain of .14 a hardcoded marker looks correct.
test('the chords drift marker follows the chords gain in VOICES', async () => {
  const fixture = FIXTURES.find((f) => f.name === 'quiet-afternoon');
  const { strudel } = await exportFixture(fixture, {
    patchComposer: (source) => {
      const parts = source.split('gain: .14');
      assert.equal(parts.length, 2, 'expected exactly one `gain: .14` in VOICES (the chords voice)');
      return parts.join('gain: .15');
    },
  });
  const marker = strudel.match(/value\.gain===(\.\d+)/);
  assert.ok(marker, 'no `value.gain===` drift marker in the generated source');
  assert.equal(marker[1], '.15', 'drift marker did not follow the chords gain in VOICES; chords lose cutoff and release drift');
});
