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

// Strudel's transpiler reads double-quoted strings as mini-notation, so a stray
// `"` anywhere in the export silently changes what the source means. station.mjs
// applies the single-quote rule as it builds each literal, which covers the
// journal but not the five composer.mjs functions the prelude embeds via
// `.toString()`. Those are single-quoted today; this is what keeps them that
// way, including across a deliberate `npm run fixtures`. (Backticks are
// mini-notation too, but nothing emits one, so they are not checked here.)
test('the generated source is single-quoted throughout', async () => {
  for (const fixture of FIXTURES) {
    const { strudel } = await exportOnce(fixture);
    const lines = strudel.split('\n');
    const index = lines.findIndex((line) => line.includes('"'));
    assert.equal(
      index,
      -1,
      `${fixture.name} line ${index + 1} contains a double quote, which Strudel's transpiler reads as mini-notation rather than a string: ${JSON.stringify(lines[index]?.slice(0, 120))}`,
    );
  }
});

// The assertion above cannot fail today: nothing in the real export contains a
// double quote, so its failure path never runs and a refactor could reduce it to
// `assert.ok(true)` with the suite staying green. This is the inverse
// demonstration. Patching identity()'s weather default from `?? 'clear'` to
// `?? "clear"` changes no behaviour — the export still succeeds — but the quote
// lands inside one of the five functions the prelude embeds via `.toString()`,
// which is the region station.mjs's own single-quote rule does not cover. This
// tests the generator, not the test above: if the embedded functions ever stop
// reaching the output verbatim, there is nothing left for that scan to catch.
test('a double quote injected into an embedded function reaches the generated source', async () => {
  const fixture = FIXTURES.find((f) => f.name === 'quiet-afternoon');
  const { strudel } = await exportFixture(fixture, {
    patchComposer: (source) => {
      const parts = source.split("?? 'clear';");
      assert.equal(parts.length, 2, "expected exactly one `?? 'clear';` in composer.mjs (the identity() weather default)");
      return parts.join('?? "clear";');
    },
  });
  assert.ok(
    strudel.includes('?? "clear"'),
    'the injected double quote never reached the export: the generated source no longer carries the embedded functions verbatim, so the scan above has nothing it could catch',
  );
});
