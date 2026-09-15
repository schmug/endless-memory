# Endless Memory — Slice 1: engine port

Date: 2026-09-10
Status: approved, not yet implemented

## Context

Project goal: a 24/7 YouTube live stream of an endless generative lo-fi
composition that preserves concentration while rewarding occasional attention.

A working composition engine already exists at `$PROTOTYPE`.
It is unversioned — not a git repo, not backed up. It came out of a prior ChatGPT
session that ran out of quota mid-answer.

What the engine is:

- `composer.mjs` — pure deterministic score model. No wall-clock reads, no network,
  no mutation during queries. Queries are side-effect free, so seeking and repeated
  scheduling produce the same score.
- 76 BPM, A minor, synthesized sources only. No samples are downloaded.
- Scene = 32 bars ≈ 101 s. Chord progression = 8 bars ≈ 25 s. Slow drift cycles:
  brightness ≈ 9 min, note release ≈ 11 min, gain ≈ 13 min at ±2.5%.
- Motif memory: one motif derived per UTC day and per weather episode. An explicit
  `remember` event makes a motif eligible for recall for 30 days. Harmony,
  percussion and motif selection use separate hash keys.
- Gentle theme handoff: a new motif replaces the previous one progressively across
  32 bars, retaining one melody voice to avoid the loudness of two overlapping
  arrangements.
- `journal.json` — append-only event log. Event types `weather` and `remember`.
  Events take effect at the first scene boundary at or after their timestamp.
- `station.mjs` — CLI. `export [ISO]`, `weather <clear|cloudy|rain|snow> [ISO]`,
  `remember <mID> [ISO]`.
- Export emits a self-contained `.strudel` file by stringifying the model's own
  functions and embedding a journal snapshot, so the browser runs the same tested code.

Verified 2026-09-10 on Node v22.22.3: 5 tests pass, 0 fail, 677 ms. Tests run the
exported code through Strudel's editor transpiler, then exercise the real Strudel
pattern engine over a 45-minute span including section crossings, remote seeks,
deterministic replay, future-event isolation and motif recall.

The sound is listener-approved. `baselines/listener-approved-v1.strudel` and
`listener-approved-v2.strudel` preserve earlier approved states.

Remaining project pieces, none of which this slice builds:

| | Piece | State |
|---|---|---|
| B | Live environment feed (NWS observations + CO-OPS tides → journal events) | raw data pulled, location undecided |
| C | Audio runtime — continuous multi-hour audio, unattended | unproven, riskiest |
| D | Visual layer — the part that rewards occasional attention | specified 2026-09-14; not built |
| E | Broadcast and ops — RTMP, levels, monitoring, restart recovery | specified 2026-09-13; not built |
| F | Listener interaction — "remember this" from chat | deferred by design |

## Problem

The approved engine exists in exactly one unversioned directory. Every later slice
will modify code that produces a sound already signed off, and nothing currently
detects an accidental change to that sound.

## Scope

In scope:

1. Copy the engine into this repository without changing its logic.
2. Publish `schmug/endless-memory` as a public repo with CI and a required-check
   ruleset on `main`.
3. Add a golden-output characterization test pinning the generated score.
4. Dependency hygiene: demote test-only AGPL packages to `devDependencies`, drop
   the unused one.
5. MIT `LICENSE`.

Out of scope, deliberately:

- Any change to the musical logic in `composer.mjs`. The sound must not move.
- Refactoring the export path in `station.mjs`. Deferred to a follow-up issue.
- Restructuring into a library with a public API. Wait until a second consumer
  exists to shape it.
- Pieces B through F above.
- Moving or deleting the prototype directory.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| First slice | Port the engine | User choice over spiking the audio runtime, designing visuals, or settling the location. |
| Port fidelity | Verbatim, then lock | Protects an approved sound. Smallest diff. Refactors wait for a consumer to shape them. |
| Repo visibility | Public, with gates | Makes the issue→PR→merge-through-a-gate loop actually work. Free on public repos. |
| Dependency hygiene | Included | Publishing correctness, not refactoring. The repo should be honest about what it links against. |
| `research/` | Committed | See D2. Two files are not reproducible. |
| `score-45min.json` fixture | Dropped | Redundant with the `.strudel` fixture. See D4. |
| License | MIT | Of the 94 repos schmug authored, 42 carry a licence; MIT leads with 26 (Apache-2.0 9, CC0 2, CC-BY 1, other 4). The remaining 52 carry none. |
| Copyright holder | `schmug` | Matches shipofclaudius, terratouch, dewpt. Never a personal legal name. |

## Design

### D1. What is copied

Verbatim from `$PROTOTYPE/`:

`composer.mjs`, `station.mjs`, `composer.test.mjs`, `journal.json`,
`baselines/listener-approved-v1.strudel`, `baselines/listener-approved-v2.strudel`,
`package.json`, `package-lock.json`, `README.md`, `.gitignore`.

Also copied: `research/` — 19 files, ~1.1 MB of raw NWS and NOAA CO-OPS pulls for
Boston, Winthrop and Marblehead.

`research/` is committed because `KBOS-observations.json` and `KBVY-observations.json`
are point-in-time observation snapshots. NWS observation endpoints do not retain
history indefinitely, so re-running the same call later does not reproduce them.
The forecast and station-metadata files are reproducible; the observation snapshots
are not, and they are the evidence base for slice B's location decision.

Never touched: the prototype directory itself, and the unrelated `audition/`,
`claude-podcast-music-handoff/` and `claude-frontier-commits-music-handoff/`
projects beside it. Copy, never move — the prototype is the only existing copy and
stays as a frozen reference.

### D2. What is not committed

`endless-memory.strudel`, `score-45min.json` and `listen.url` are all derived from
an export and embed the anchor timestamp they were generated with. They churn on
every run. All three are added to `.gitignore`.

This does not break the README. Its "Try it" section already begins with
`node station.mjs export`, so a fresh clone generates its own.

`node_modules/` stays ignored, as it already is.

### D3. Layout

Flat, mirroring the prototype. New directories arrive when pieces B–E do, not in
anticipation of them.

```
composer.mjs              pure score model (verbatim)
station.mjs               CLI: export | weather | remember (verbatim)
composer.test.mjs         5 existing tests (verbatim)
export.test.mjs           NEW — golden fixture test
test/fixtures/            NEW — pinned exports at fixed anchors
test/update-fixtures.mjs  NEW — regenerates fixtures deliberately
journal.json              the station's event log
baselines/                listener-approved v1, v2
research/                 NWS + CO-OPS raw pulls (evidence for slice B)
docs/superpowers/specs/   this document
.github/workflows/ci.yml  NEW
LICENSE                   NEW — MIT
README.md
package.json
```

### D4. The lock

A golden-output characterization test. It is not TDD. Its job is regression
detection on a sound already approved, not specification of new behaviour. Calling
it a characterization test keeps that honest.

Two fixtures, each at a fixed anchor so output is deterministic. `station.mjs export`
with no argument uses `new Date()`, so every fixture must pass an explicit anchor.

**quiet** — anchor `2026-09-11T14:00:00Z` (UTC afternoon phase), journal as shipped
(`version 1`, `seed: window-seat-v1`, no events). Pins the baseline daytime
arrangement.

**weathered** — anchor `2026-09-11T02:00:00Z` (UTC night phase), journal seeded with:

- a `weather` event, value `rain`, at `2026-09-10T18:00:00Z`
- a `remember` event at `2026-09-09T12:00:00Z`, motif derived (not invented) during
  fixture generation from `identity()` for an earlier day

Pins night sparseness, the weather easing curve, and the motif-recall branch with
candidates present.

Fixture ids are readable strings such as `fixture-weather-1`. `validate()` requires
only that `id` is truthy and unique and that `at` parses, so UUIDs are unnecessary.

Recall fires when `hash(index + ':recall') % 4 === 0`, roughly one scene in four.
The fixture pins whatever the engine actually does at that anchor. The fixture
generator must report whether `recalled` is true for any scene in the exported
45-minute score; if it never fires, choose a different anchor so the fixture
genuinely covers the recall branch, and record the chosen anchor here.

Mechanics: the test copies `composer.mjs`, `station.mjs` and the fixture journal
into a `mkdtemp` directory, spawns `node station.mjs export <anchor>` for real, and
asserts the written `.strudel` is byte-identical to the fixture. `station.mjs`
resolves paths from its own file location, so a copied CLI reads and writes inside
the temp directory and never touches the repo.

Spawning the real CLI is deliberate. Asserting against `patternSource()` directly
would duplicate station.mjs's string-assembly logic inside the test and miss exactly
the regressions this exists to catch.

`score-45min.json` is not pinned. The `.strudel` fixture already embeds the entire
engine including `scene()`, so a change that moved the score JSON without moving the
`.strudel` output is very nearly impossible. A second fixture would be churn that
makes real diffs harder to read.

`npm run fixtures` runs `test/update-fixtures.mjs` to regenerate fixtures
deliberately, so an intentional sound change appears as a reviewable diff rather
than a hand-edit.

### D5. Dependency hygiene

Only `composer.test.mjs` imports Strudel. `composer.mjs` and `station.mjs` import
nothing outside Node's standard library.

All four Strudel-family packages are AGPL-3.0-or-later. They are currently listed
as runtime `dependencies`, which misrepresents what the project links against at
runtime — which is nothing.

- `@strudel/core` (pinned 1.2.5), `@strudel/mini` → move to `devDependencies`.
- `@strudel/transpiler` → already a `devDependency`, unchanged.
- `@kabelsalat/web` → not imported by any source file. Remove, and confirm the test
  suite still passes. If removal breaks the suite it is a transitive requirement and
  moves to `devDependencies` instead.

The `@strudel/core` 1.2.5 pin and the `overrides` block must survive. Version 1.2.6's
published browser dependency fails to import under Node, which is why the Node
verification harness is pinned.

### D6. Gates, and the ordering they force

A status check cannot be required until it has run at least once. That constrains
the sequence:

1. Commit the spec to `main`. The repo has zero commits, so this is the first.
2. Commit the verbatim engine, `research/`, `.gitignore` additions and
   `.github/workflows/ci.yml` to `main`. The workflow is not engine code, so
   verbatim fidelity of the engine is intact. It must land here, not later, so the
   check exists to be required.
3. Create `schmug/endless-memory` public. Push `main`. CI runs once.
4. Create the `main` ruleset: require a pull request before merging, require the CI
   status check to pass.
5. Branch. Second change set: golden fixtures, `export.test.mjs`,
   `test/update-fixtures.mjs`, dependency cleanup, `LICENSE`, README update. Open a
   PR. Merge through the gate once green.

CI: `ubuntu-latest`, `actions/setup-node@v4` with Node 22 and npm cache, then
`npm ci` and `npm test`. Node 22 matches the verified v22.22.3. `npm ci` inherits
the lockfile's `@strudel/core` 1.2.5 pin and must not drift off it.

Before the first push, scan the tree for secrets. `journal.json` is empty and
`research/` is public government API data, but look rather than assume.

### D7. README

The README is copied verbatim in step 2 and edited minimally in step 5. Preserve
its existing technical content — the loop timings, the memory semantics, the
weather-connection notes, the listening-pass roadmap. Add only what this slice
changes: the fixture workflow, the dependency split, and that the repo is now the
canonical home while the prototype directory is a frozen reference.

It is a public-repo README, so it is product output with a human audience. That
loosens no quality gate.

### D8. License

MIT, `Copyright (c) 2026 schmug`.

The AGPL question is separate and unaffected. The Strudel packages are test-only,
which is why D5's demotion keeps the dependency story clean regardless of the
licence chosen for this repo's own code. The generated `.strudel` file contains this
project's own functions plus calls to Strudel's public API names.

## Verification

Every claim below must be an observation, not a configuration assertion.

- `npm ci && npm test` run locally. Report pass and fail counts as numbers.
- Both fixtures byte-identical on a clean run.
- CI green on the PR, observed in the run, not inferred from the workflow file.
- The ruleset verified two independent ways: read it back with
  `gh api repos/schmug/endless-memory/rulesets/<id>`, and observe the PR's
  `mergeStateStatus` move from blocked to clean as checks complete
  (`gh pr view --json mergeStateStatus,statusCheckRollup`).
  A direct `git push origin main` is not a valid test here — with `main` already up
  to date it reports "Everything up-to-date" and proves nothing.
- Prototype directory unchanged. Verify by diffing it against the copy.

## Acceptance criteria

1. This repository contains the engine, tests pass, counts reported.
2. `composer.mjs` is byte-identical to the prototype's.
3. `github.com/schmug/endless-memory` exists, is public, and `main` carries the work.
4. A required-check ruleset on `main` is verified by observation.
5. The golden fixture test fails if `composer.mjs` changes. Demonstrate this by
   making a throwaway edit, watching the test fail, and reverting it.
6. The prototype directory is unchanged.
7. A follow-up issue exists for the `station.mjs` export-path refactor.

Criterion 5 matters most. A golden test that has never been seen to fail is not
known to work.

## Deferred work

Filed as a follow-up issue during this slice:

- **Export-path refactor.** `station.mjs` builds its output by rendering a template
  through `patternSource()`, then regex-matching each rendered token back to its
  scene key by comparing `JSON.stringify` output. It then rewrites every double-quoted
  string to single quotes because Strudel's transpiler reads double quotes and
  backticks as mini-notation. This is the most fragile code in the project and three
  more subsystems are about to build on it. Rewrite it to assemble source from
  structured parts. The golden fixtures make the rewrite provably output-identical.

Not filed, because they are undesigned rather than deferred: pieces B through F.
Each gets its own spec.

## Risks

| Risk | Mitigation |
|---|---|
| The port silently changes the approved sound | Verbatim copy, byte-identical check on `composer.mjs`, plus the golden fixtures. |
| Removing `@kabelsalat/web` breaks a transitive need | Test suite run after removal; fall back to `devDependencies`. |
| Fixture anchors do not exercise the recall branch | Generator reports whether `recalled` fires; change anchor if not. |
| The ruleset is created but does not actually gate | Verified by reading it back and observing PR mergeability, not by having configured it. |
| `npm ci` drifts off the `@strudel/core` 1.2.5 pin | Lockfile committed; `npm ci` respects it; the pin's reason is recorded in D5. |
