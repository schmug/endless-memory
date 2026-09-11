# Endless Memory

A generative lo-fi composition engine with motif memory. Intended to become a
continuous YouTube stream that preserves concentration while rewarding
occasional attention.

## Invariants

**The sound is listener-approved. Do not change it.** `composer.mjs` is
byte-identical to the original prototype and carries the whole musical model.
Edits that move the output fail `export.test.mjs`.

**`npm run fixtures` blesses a sound change.** It is the documented escape
hatch from a failing golden test, which makes it the easiest way to destroy the
thing those tests protect. Run it only when a sound change is deliberate, and
review the regenerated fixtures as a diff.

**The five engine tests in `composer.test.mjs` cannot detect a sound change.**
They assert structural bounds — event counts, finite pitches, deterministic
replay — not values. All five pass against an altered engine. Only the
byte-identity fixtures catch one. Do not treat a green `composer.test.mjs` as
evidence the sound is intact.

**`@strudel/core` is pinned to exactly `1.2.5`.** 1.2.6's published browser
dependency fails to import under Node. The `overrides` block enforces this
against `@strudel/mini`, which requests 1.2.6.

**No runtime dependencies.** `composer.mjs` and `station.mjs` import nothing
outside Node's standard library. The Strudel packages are `devDependencies`
because `composer.test.mjs` is their only importer.

**Do not remove the `pretest` script.** `composer.test.mjs:26` reads
`endless-memory.strudel` from disk and never generates it. Without `pretest` a
clean checkout fails with `ENOENT`.

**Fixture anchors are fixed.** `station.mjs export` with no argument reads the
wall clock, so every fixture passes an explicit anchor.

**`main` is gated** by a required `test` check with no bypass actors. The check
context is the bare job id `test` — adding a CI matrix renames it to
`test (18)` etc. and blocks every PR permanently. Change the ruleset first if
the matrix is ever needed.

## Layout

- `composer.mjs` — pure score model. No wall-clock reads, no network, no
  mutation during queries.
- `station.mjs` — CLI: `export [ISO]`, `weather <clear|cloudy|rain|snow> [ISO]`,
  `remember <mID> [ISO]`. Builds the exported source by stringifying the model's
  own functions, so the browser runs the same tested code.
- `journal.json` — append-only event log. Events take effect at the next scene
  boundary (32 bars, about 101 seconds).
- `test/fixtures/` — pinned exports. `test/update-fixtures.mjs` regenerates them.
- `research/` — raw NWS and CO-OPS pulls. `KBOS-observations.json` and
  `KBVY-observations.json` are point-in-time snapshots that cannot be re-fetched.
- `docs/superpowers/` — the spec and plan this repo was built from.

## Verification

`npm test` — expect 8 passing, 0 failing. Report counts, not "tests pass".

## Not built yet

Live weather feed, audio runtime, visuals, broadcast, listener interaction.
Each needs its own spec. The location for the weather feed is still undecided
between Boston, Winthrop and Marblehead; `research/` holds the evidence.
