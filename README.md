# Endless Memory — composition prototype

A 76 BPM, synthesized lo-fi Strudel composition with a dated event journal. Generate `endless-memory.strudel` with `node station.mjs export` (see Try it below), paste its contents into https://strudel.cc/ and press Play. Start your volume low and adjust by ear. No samples are downloaded by this score.

The score continues generating scenes indefinitely. Every 32 bars (about 101 seconds), it derives a scene from the original UTC score anchor and journal. It repeats and varies a motif, follows one of three related A-minor progressions, and thins the hats slightly near scene endings while keeping the backbeat. Night arrangements are sparser. Chord brightness and release drift over roughly 9–13 minutes, with only ±2.5% gain modulation. Occasional eight-bar phrases change their final melody note. Weather tone changes ease in over roughly 12 minutes. No finite playlist is looped, although musical material deliberately repeats.

This repository is the canonical home for the engine. The original working
directory it was developed in remains untouched as a frozen reference.

## Try it

Requires Node 18 or newer. Run these commands from this folder:

```
node station.mjs export
node station.mjs weather rain
node station.mjs export
```

Each export prints the current motif ID. To retain that theme:

```
node station.mjs remember m76552251
node station.mjs export
```

Use the actual ID printed by your export. To replay from a particular score date:

```
node station.mjs export 2026-09-11T00:00:00Z
```

The generated score embeds a snapshot of `journal.json`. Re-export and re-evaluate in Strudel after recording events. Events become eligible at the first scene boundary at or after their timestamp. Backdating an event intentionally changes subsequent history. Use one writer at a time.

`score-45min.json` lists the scenes for the next 45 minutes; it is a score inspection artifact, not an audio recording. `listen.url` holds a Strudel URL with the full composition encoded. Sharing that URL shares the embedded journal.

## What memory means here

One motif is derived for each UTC day and weather episode. An explicit remember event makes a motif eligible for occasional recall for 30 days. It retains its pitch/rhythm identity while following the current harmony. Harmony, percussion, and motif choices use separate hash keys. Queries have no state-changing side effects, so seeking and repeated scheduling queries produce the same score.

Weather is a manual scenario input in this version. With no observation the score uses a neutral clear palette and marks `weatherKnown: false`. The last entered weather persists until replaced. All day phases use UTC. No location or real weather is inferred.

## Verification

```
npm ci
npm test
```

Tests run the exported code through Strudel’s editor transpiler, then exercise the real Strudel pattern engine over a 45-minute span, including section crossings, remote seeks, deterministic replay, future-event isolation, and motif recall. Strudel core is pinned to 1.2.5 for the Node verification harness because 1.2.6's published browser dependency fails to import under Node. The corrected export was also started in the Strudel browser REPL without the original parse error. Subjective sound quality still needs a listening pass.

The suite also pins the generated score byte-for-byte at two fixed anchors: a quiet afternoon (28 scenes, clear, no motif recall) and a rainy night (27 scenes, 8 recalled scenes, 15 motif handoffs). Those fixtures exist because the older tests assert structural bounds rather than values — they pass unchanged against an altered engine, so they cannot detect a change to the approved sound. Run `npm run fixtures` to regenerate the fixtures after a deliberate change, and review the result as a diff.

The Strudel packages are test-harness only. `composer.mjs` and `station.mjs` import nothing outside Node's standard library, so the project has no runtime dependencies.

## Next listening and development pass

1. Audition 45 minutes; mark repetitive melodies, abrupt scene changes, and frequency balance problems.
2. Select a weather location and musical timezone. Add a collector that records normalized observations with source and observation time, handles stale observations, and applies them at musical boundaries.
3. Add an in-player “remember this” control with the currently audible motif, rather than requiring a command.
4. Extend memory to spontaneous callbacks to prior weather themes, gradual forgetting, annual themes, and smoother chord voice leading.
5. Add continuous journal delivery, output limiting and level measurement, recording, then broadcast monitoring and restart recovery.

This is a composition-engine prototype, not a running YouTube station. It has no RSS, listener counts, comments, followers, live weather polling, or automatic audio restart. Synthesized percussion avoids reliance on the prior projects' sample recordings; dependency licenses remain listed in their packages.

The listener-approved v1 score is preserved in `baselines/listener-approved-v1.strudel` for comparison. V2 preserves the tempo and sound palette. Day changes and motif replacement still occur at scene boundaries; continuous live weather delivery and smooth theme handoffs remain future work.

## V3: gentle theme handoffs

When a remembered theme, weather episode, or new day selects a different motif, its notes replace the previous motif progressively across the next 32 bars (about 101 seconds). One melody voice is retained, avoiding the extra loudness of overlapping two full arrangements. Harmony and day/night density still follow scene boundaries. The approved V2 score is saved in `baselines/listener-approved-v2.strudel`.

Weather connection preparation: the journal accepts timestamped `weather` events with `clear`, `cloudy`, `rain`, or `snow`. A future collector should retain source, observation time, and receipt time; only received observations should affect the forward score. Repeated identical observations should not create new musical episodes. City and timezone are still awaiting selection; there is no live weather connection yet.
