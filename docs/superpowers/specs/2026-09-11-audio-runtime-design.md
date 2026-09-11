# Audio Runtime (piece C) — design

## Problem

The engine can compute any scene of the composition from a timestamp, but nothing
turns those scenes into audio. Piece C is the component that produces continuous,
correct PCM samples forever, so that something downstream can encode and broadcast
them.

## Scope

**In scope.** Synthesis, event scheduling, chunked rendering, restart-resume, and the
tests that prove the audio is right.

**Out of scope.** ffmpeg, encoding, HLS, RTMP, Cloudflare Stream, YouTube, monitoring,
process supervision, stereo width, live journal reloading, and visuals. Those belong
to pieces D and E.

The boundary is deliberate: piece C is pure computation and can be tested completely
offline with no broadcast stack present.

## Decisions already made

**Node synthesis, not superdough** (issue #7, closed 2026-09-11). Both paths were
built and measured during the overnight spike. Cory listened to five minutes of each,
level-matched, and judged them interchangeable — he did not notice the switches in a
30-second alternating A/B. With fidelity neutral, Node won on operational cost: 109x
realtime versus 64x, no browser process, no dependence on substituting
`window.AudioContext` before superdough imports, and flat memory across a completed
7-day continuous render.

**Read the journal once at boot.** Journal changes are applied by restarting the
process, not by watching the file. This is cheap because scene index is derived from
absolute time, so a restart resumes at the correct musical moment rather than
replaying or skipping. It removes file watching, journal cache invalidation, and the
conflict between render-ahead depth and event responsiveness.

**Call `scene()` directly; do not run Strudel at runtime.** The spike's renderer loaded
the exported `.strudel` text, transpiled it, and `eval`'d it back into a pattern. That
works but makes `@strudel/core`, `@strudel/mini` and `@strudel/transpiler` runtime
dependencies — all AGPL-3.0, in an MIT repo — which breaks the "no runtime
dependencies" invariant in CLAUDE.md and puts `new Function()` over generated source in
the production path. Instead the runtime imports `composer.mjs` and parses the
mini-notation itself.

This is safe because the grammar is tiny and frozen. Measured across 600 consecutive
scenes (~17 hours of music) on 2026-09-11, `scene()` emits only:

- characters: space, comma, digits, `<`, `>`, `[`, `]`, `~`
- maximum nesting depth: 2
- 8 distinct structural shapes

`composer.mjs` cannot grow that grammar without changing its output, which fails
`export.test.mjs`. A pleasant side effect: with Strudel gone from the runtime, the
`@strudel/core` stdout-banner hazard disappears at the root, because nothing that
prints on import is loaded.

**Dual-mono output.** The Node synthesiser is mono, and the audio Cory approved was
that mono signal duplicated across two channels. Real stereo width would change an
approved sound, so it is a separate later change with its own listening pass.

## Architecture

Root stays the frozen engine. Piece C lands in a new `runtime/` directory.

| module | responsibility | depends on |
|---|---|---|
| `runtime/mini.mjs` | Parse one mini-notation string into `[{value, begin, end}]` in cycle-relative time `[0,1)` | nothing |
| `runtime/voices.mjs` | Render one parameterised event into samples: triangle/sine/white sources, ADSR, one-pole low-pass and high-pass | nothing |
| `runtime/schedule.mjs` | Turn `scene(index, journal)` into timed, parameterised events for a cycle range; apply `atmosphere()` drift | `composer.mjs`, `mini.mjs` |
| `runtime/render.mjs` | Chunk loop and CLI: render N cycles, hand the buffer to a sink, advance | `voices.mjs`, `schedule.mjs` |

Each module is independently testable. `mini.mjs` and `voices.mjs` are pure functions
over plain data with no imports at all.

### Event shape

`schedule.mjs` produces events in the shape the spike's synthesiser already consumed,
so `voices.mjs` is a promotion of proven code rather than a rewrite:

```
{ s: 'triangle' | 'sine' | 'white',
  note?: number,        // MIDI, for pitched voices
  freq?: number,        // Hz, for the kick
  attack, decay, sustain, release: number,
  cutoff?: number,      // low-pass Hz
  hcutoff?: number,     // high-pass Hz
  gain: number,
  begin, end: number }  // absolute cycles
```

### The voice-table problem

`patternSource()` in `composer.mjs` holds each voice's parameters — `s`, `attack`,
`decay`, `sustain`, `release`, `lpf`, `gain` — only inside a JavaScript template
string. The runtime needs them structurally, and `composer.mjs` must not be edited.

`schedule.mjs` therefore carries an explicit voice table, and a test parses
`patternSource()`'s output and asserts the table matches it. Drift becomes a test
failure rather than a silent change to the sound. Parsing happens in the test, never at
runtime.

The same treatment applies to a wart recorded in issue #2: the exported score applies
atmosphere drift by matching `value.gain === .14` to identify the chord voice. The
runtime targets the chord voice by name, and the differential test proves the output is
identical.

## Verification

Three layers, because the spike produced three separate cases where structurally valid
output was completely wrong — noise that encoded to correct-looking HLS, silent renders
reported as successful, and a memory watchdog measuring the wrong process.

**1. Differential against Strudel.** `mini.mjs` and `schedule.mjs` must produce events
identical to Strudel's `queryArc` across thousands of scenes, including scenes with
weather events, remembered motifs, and motif handoffs. `@strudel/mini`,
`@strudel/core` and `@strudel/transpiler` stay `devDependencies` purely to act as the
oracle. This is the test that makes the re-implementation safe rather than hopeful.

**2. Golden audio.** Render a fixed anchor to PCM and assert both a content hash and
level/spectral bounds. The hash catches any change at all; the bounds make a failure
readable by saying how the sound moved. Regenerating the fixture must be a deliberate,
reviewable diff, exactly as `npm run fixtures` is for the score.

**3. Voice table.** As described above.

## Interfaces

```
// runtime/render.mjs
renderChunk(startCycle, cycleCount, journal) -> Float32Array   // pure, deterministic
run({ anchor, sink, chunkCycles })                             // loop until stopped
```

`renderChunk` is pure and is what the tests exercise. `run` is a thin loop around it.

CLI: `node runtime/render.mjs --anchor <ISO> --out <path|fd> [--chunk-cycles 8]`

Chunk size defaults to 8 cycles (about 25 seconds), matching what the 7-day endurance
run exercised.

**Pacing is not piece C's job.** The renderer produces samples as fast as the sink
accepts them — measured at 109x realtime — and the consumer throttles. In the spike
that was `ffmpeg -re` applying backpressure through a pipe.

Output defaults to a file path or an explicit file descriptor. Writing to stdout is
permitted but a test asserts that no bytes precede the PCM, because a library printing
a banner on import silently corrupts the stream in a way every structural check passes.

## Error handling

- An invalid journal fails fast at boot. `composer.mjs` already exports `validate()`;
  `run` must call it on the loaded journal before rendering anything.
- A silent chunk is a bug, not valid output. The 7-day run produced zero silent chunks,
  so `run` asserts peak > 0 for every chunk and exits non-zero otherwise.
- Samples are soft-clipped through `tanh`; occurrences are counted and reported rather
  than silently swallowed.

## Constraints

- Node 22.
- No runtime dependencies. `runtime/` may import only Node built-ins and
  `composer.mjs`.
- `composer.mjs` is not edited. It carries the listener-approved musical model and the
  golden fixtures protect it.
- Output is 48 kHz, 16-bit, dual-mono, matching what the spike produced and what was
  approved.

## Acceptance criteria

1. `npm test` passes with counts reported, including the three new test layers.
2. The differential test compares `runtime/` output against Strudel over at least 1,000
   scenes spanning quiet, weathered, recall and handoff cases, with zero mismatches.
3. A deliberate one-value edit to a voice parameter makes the golden audio test fail,
   verified by making the edit and watching it fail, then reverting.
4. A continuous render of at least 24 simulated hours completes with zero silent chunks
   and no memory growth beyond warm-up.
5. `runtime/` imports nothing outside Node built-ins and `composer.mjs`, asserted by a
   test.
6. `test/fixtures/*.strudel` are unchanged — piece C does not touch the score.

## Deployment context (not this spec's work)

Decided 2026-09-11: the renderer runs on an always-on host and pushes RTMPS into a
Cloudflare Stream Live Input, which simulcasts to YouTube Live. Cloudflare Containers
were evaluated and rejected for the renderer — the platform documents them as not
suitable for continuous 24/7 operation, with a 10-minute default idle sleep, ephemeral
disk, and 1-3 second cold starts that would be audible holes in a live stream.
Cloudflare Stream simulcasting supports up to 50 concurrent destinations and outputs
can be changed mid-broadcast.

Two consequences worth recording, both for piece E rather than here:

- YouTube Live requires a video track, so whatever pushes RTMP must produce picture as
  well as sound. That couples piece E to the still-undesigned visual layer.
- Because Cloudflare holds the YouTube connection, the renderer can restart without
  YouTube noticing, which is what makes the restart-to-apply decision cheap.
