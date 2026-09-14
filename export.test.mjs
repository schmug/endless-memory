import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURES, LAYERS, exportFixture, exportOnce, readFixture, reassemble, splitExport } from './test/update-fixtures.mjs';

// Characterization tests, not specification. Their job is to make an accidental
// change to a listener-approved sound impossible to merge unnoticed.
//
// Each fixture is two layers now (issue #3): the shared engine snapshot plus a
// small per-anchor file. readFixture() reassembles them; what is compared here is
// still the whole source, byte for byte, because whole-file byte identity is the
// only value-level guard the sound has — composer.test.mjs asserts structural
// bounds and cannot see a changed number.
for (const fixture of FIXTURES) {
  test(`export is byte-identical to the ${fixture.name} fixture`, async () => {
    const expected = readFixture(fixture.name).strudel;
    const { strudel } = await exportOnce(fixture);
    assert.equal(
      strudel,
      expected,
      'Export drifted from the approved sound. If this change is intentional, run `npm run fixtures` and review the diff.',
    );
  });

  // The engine snapshot locks the mix; this locks the music. A changed motif,
  // handoff or phase shows up here as one readable line naming the scene it
  // belongs to, which is what the whole reshape was for.
  test(`the ${fixture.name} fixture pins its 45-minute score`, async () => {
    const { score } = await exportOnce(fixture);
    assert.deepEqual(
      score,
      readFixture(fixture.name).score,
      'The 45-minute score drifted from the approved one. If this change is intentional, run `npm run fixtures` and review the diff.',
    );
  });
}

// The byte-identity test above is only worth anything if reassembly is text
// substitution and nothing else. A reassembly that derived a value instead —
// startBar from the anchor, say — would move with an engine change that moved the
// real one, and the test would then compare two things that had drifted together
// and pass. Sentinels no exporter could produce are the only way to see the
// difference: substitution hands them back untouched, derivation cannot.
test('reassembly substitutes pinned text and derives nothing', () => {
  const { engine } = readFixture(FIXTURES[0].name);
  const sentinels = Object.fromEntries(LAYERS.map((layer) => [layer.key, `<<${layer.key}>>`]));
  const source = reassemble(engine, sentinels);
  for (const layer of LAYERS) {
    assert.ok(!source.includes(layer.placeholder), `${layer.placeholder} survived reassembly`);
    assert.equal(source.split(sentinels[layer.key]).length - 1, 1, `${layer.key} was not substituted exactly once`);
  }
  // Total substitution: the length moved by exactly what the three swaps cost,
  // so nothing outside the placeholders was rewritten, dropped or generated.
  const delta = LAYERS.reduce((n, layer) => n + sentinels[layer.key].length - layer.placeholder.length, 0);
  assert.equal(source.length, engine.length + delta, 'reassembly changed text outside the placeholders');
});

// The split is lossless either way, but an over-capturing one — a pinned value
// that swallowed the lines around it — would put the engine back into both
// per-anchor files and the byte test would still pass. Every pinned value covering
// part of one line is what keeps the shared layer shared.
test('every per-anchor value is part of a single line', () => {
  for (const fixture of FIXTURES) {
    const { values } = readFixture(fixture.name);
    for (const layer of LAYERS) {
      const value = values[layer.key];
      assert.equal(typeof value, 'string', `${fixture.name} pins no text for ${layer.key}`);
      assert.ok(!value.includes('\n'), `${fixture.name}'s ${layer.key} spans lines: ${JSON.stringify(value.slice(0, 120))}`);
    }
  }
});

// Issue #3 asks for a one-value change to composer.mjs to produce a diff about
// the music rather than the engine body, and #1's constraint is that the lock
// still fails on any such change. Both are claims about a file layout, so this
// makes the edit and reads where it lands: the melody gain is a mix-level value,
// so it has to break the byte lock and show up in the engine snapshot alone,
// leaving both anchors' pinned values untouched.
test('a mix-level change to composer.mjs lands in the engine snapshot alone', async () => {
  const fixture = FIXTURES.find((f) => f.name === 'quiet-afternoon');
  const { strudel } = await exportFixture(fixture, {
    patchComposer: (source) => {
      const parts = source.split('gain: .09');
      assert.equal(parts.length, 2, 'expected exactly one `gain: .09` in VOICES (the melody voice)');
      return parts.join('gain: .095');
    },
  });
  const pinned = readFixture(fixture.name);
  assert.notEqual(strudel, pinned.strudel, 'the melody gain edit never reached the export, so this proves nothing about the lock');
  const { engine, values } = splitExport(strudel);
  assert.notEqual(engine, pinned.engine, 'a changed gain did not reach the engine snapshot; the shared layer no longer carries the mix');
  assert.deepEqual(values, pinned.values, 'a mix-level change moved a per-anchor value: the split no longer separates the engine from the anchor');
});

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

// Strudel's transpiler reads double-quoted strings and backticks alike as
// mini-notation, so a stray delimiter anywhere in the export silently changes
// what the source means. station.mjs applies the single-quote rule as it builds
// each literal, which covers the journal but not the five composer.mjs
// functions the prelude embeds via `.toString()`, nor the text voiceSource()
// (composer.mjs:131-140) returns into the output verbatim. Those are
// single-quoted today; this is what keeps them that way, including across a
// deliberate `npm run fixtures`.
//
// The backtick half of the scan is deliberately naive. A backtick inside a
// single-quoted string is only a character to the transpiler, not a delimiter,
// and jsString (station.mjs:12-13) escapes `\`, `'`, `\n` and `\r` but not
// backticks — so a journal string carrying one would trip this check with no
// defect behind it. None does today, and a false positive a maintainer can read
// beats a span-aware scanner subtle enough to need tests of its own.
const MINI_NOTATION_DELIMITERS = [
  { char: '"', label: 'a double quote' },
  { char: '`', label: 'a backtick' },
];

// Read-only inspection of already-generated text; nothing here rewrites it.
// Returns a message naming which delimiter was found and why it is forbidden,
// or null when the source is clean. Kept separate so the demonstration below
// runs the real scan rather than restating it.
function miniNotationDelimiter(name, strudel) {
  const lines = strudel.split('\n');
  for (const [index, line] of lines.entries()) {
    const hit = MINI_NOTATION_DELIMITERS.find(({ char }) => line.includes(char));
    if (hit) {
      return `${name} line ${index + 1} contains ${hit.label}, which Strudel's transpiler reads as mini-notation rather than a string: ${JSON.stringify(line.slice(0, 120))}`;
    }
  }
  return null;
}

test('the generated source is single-quoted throughout', async () => {
  for (const fixture of FIXTURES) {
    const { strudel } = await exportOnce(fixture);
    const found = miniNotationDelimiter(fixture.name, strudel);
    assert.equal(found, null, found);
  }
});

// The scan above cannot fail today: the real export carries neither delimiter,
// so its backtick path never runs against real output. This is the inverse
// demonstration for that half. voiceSource() (composer.mjs:131-140) is written
// in template literals and its return value lands in the export verbatim, so
// emitting a backtick there is a one-character slip inside an existing
// backtick-delimited string rather than a hypothetical. The patched export
// still succeeds and still parses; only the scan can tell it apart.
test('a backtick emitted by voiceSource is reported as mini-notation', async () => {
  const fixture = FIXTURES.find((f) => f.name === 'quiet-afternoon');
  const { strudel } = await exportFixture(fixture, {
    patchComposer: (source) => {
      const parts = source.split(".s('${voice.wave}')");
      assert.equal(parts.length, 2, "expected exactly one `.s('${voice.wave}')` in composer.mjs (voiceSource's note branch)");
      // The replacement lands inside composer.mjs's own template literal, so
      // the backticks it emits have to be written escaped: `\` + backtick`.
      return parts.join('.s(\\`${voice.wave}\\`)');
    },
  });
  const found = miniNotationDelimiter(fixture.name, strudel);
  assert.ok(
    found,
    'the scan reported nothing: either the injected backtick never reached the export, or the scan does not look for backticks',
  );
  assert.match(found, /a backtick/, `the scan named the wrong delimiter: ${found}`);
  assert.match(found, /mini-notation/, `the scan did not say why a backtick is forbidden: ${found}`);
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

// The generated runtime carries no voice labels: it decides which haps receive
// weather drift by comparing gain against the chords' (station.mjs:44). That
// discriminates only while every voice's gain is distinct, and that precondition
// was a comment on gainSource() rather than a gate. Patching the bass onto the
// chords' .14 is the collision the comment warns about — the bass would take a
// cutoff sweep it was never meant to have and a fourfold longer release, while
// the export still parses and composer.test.mjs's structural bounds stay green.
// The export has to refuse instead, naming both voices.
test('two voices sharing a gain fails the export', async () => {
  const fixture = FIXTURES.find((f) => f.name === 'quiet-afternoon');
  await assert.rejects(
    exportFixture(fixture, {
      patchComposer: (source) => {
        const parts = source.split('gain: .26');
        assert.equal(parts.length, 2, 'expected exactly one `gain: .26` in VOICES (the bass voice)');
        return parts.join('gain: .14');
      },
    }),
    (err) => {
      assert.ok(
        err.stderr !== undefined,
        `the export did not fail inside the spawned CLI, so this proves nothing about the guard: ${err.message}`,
      );
      const stderr = String(err.stderr);
      assert.match(stderr, /chords/, `the failure did not name the chords voice: ${stderr}`);
      assert.match(stderr, /bass/, `the failure did not name the bass voice: ${stderr}`);
      return true;
    },
    'the export succeeded with bass and chords both at gain .14: a gain collision still reaches the generated source with nothing failing',
  );
});
