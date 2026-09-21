# ops — the broadcast pipeline

Everything between `runtime/render.mjs --out -` and a listener. Implemented from
`docs/superpowers/specs/2026-09-13-broadcast-ops-design.md`; read that first, it is
authoritative and this file does not repeat it.

**What is built: tier 0, plus a live runner proven direct to YouTube.** Tier 0 is the
complete pipeline against a **local sink** — no RTMPS, no Cloudflare, no secrets, no
metered traffic. `ops/live.mjs` is the same pipeline pointed at an RTMPS destination, and
on 2026-09-20 it streamed to an unlisted YouTube broadcast at 1.000x with criterion 8
measured on the received stream (see below).

**That is not tier 2.** It pushed **direct to YouTube, bypassing Cloudflare**, so it
proves ingest, pacing and levels and proves nothing about spec criterion 5 — whether a
restart keeps the broadcast alive — because Cloudflare holding the YouTube connection is
the mechanism that claim rests on. Tiers 1–3 remain unrun and five acceptance criteria
remain unmet (#55). A live run today also comes off a laptop; no production host exists.

```
ops/stream.sh                         the pipeline: render.mjs | ffmpeg, the feeder, the fifo holder fd
ops/videofeed.sh                      the frame writer, started by stream.sh
ops/videofeed.mjs                     the frame policy — which frame goes out, and when
ops/placeholder.mjs                   generates ops/placeholder.png
ops/placeholder.png                   the launch picture, 1280x720
ops/measure.mjs                       level, pacing, A/V-sync and stall parsers and verdicts
ops/tier0.mjs                         the local-sink proof run (`npm run tier0`)
ops/live.mjs                          the same pipeline against RTMPS (`npm run live`)
ops/endless-memory-stream.service     systemd unit: render -> ffmpeg -> and the feeder
```

## Run tier 0

```sh
npm run tier0 -- --minutes 60 --kill-feeder-at 600 --out /tmp/tier0.flv
```

It runs `ops/stream.sh` and `ops/videofeed.sh` — the production scripts, not a copy of
their flags — with `SINK` set instead of `CF_STREAM_KEY`. `stream.sh` refuses both at
once, so a tier-0 run has no code path to a network destination.

Verdicts, each a gate: both tracks present at the right size and sample rate; drift
inside the bound `runtime/realtime.mjs`'s `driftTolerance()` derives; no silent stretch;
no interval below the 0.97 pacing floor; `ebur128` levels inside −22…−18 LUFS with true
peak at or below −1 dBTP; A/V skew not growing past GOP quantisation; the feeder kill
survived; the output clock never frozen for 120s; ffmpeg's RSS flat. A clean exit and a
large file are not a pass, and neither is a run that never exited at all.

Every flag change gets validated here first. It costs nothing.

## Run a live one

`ops/live.mjs` is the same `stream.sh` against a **network** destination. Tier 0 sets
`SINK` and never `CF_STREAM_KEY`; this sets `CF_STREAM_KEY` and never `SINK`. `stream.sh`
refuses both at once, so the two runners cannot be mistaken for one another at runtime.

```sh
npm run live -- --key-file ~/.config/endless-memory/youtube.key --minutes 25
```

`--destination youtube` (the default) or `cloudflare`, or `--rtmps-base <url>` for
anything else. `--kill-feeder-at N` and `--anchor <ISO>` behave as in tier 0; with no
anchor the renderer reads the wall clock, which is what production does.

**The key is never an argument.** It is read from the file named by `--key-file`, put in
the child's environment, and scrubbed out of everything the harness writes down —
`ps` shows an argv to every local user, and ffmpeg echoes its output URL on a connect
error, which is exactly when a log gets pasted somewhere. The file must live **outside
this repository**; `readKey` refuses one inside the worktree rather than trusting the
`.gitignore` pattern. It also refuses an env assignment (`CF_STREAM_KEY=abc`, which trims
clean and would otherwise be used verbatim as the key) and a pasted URL. The run reports
`key in output: absent` as a measurement, which is spec criterion 10 made mechanical.

**Three verdicts tier 0 gives you are unreachable here**, and the report names them
rather than omitting them: track layout, `silencedetect` and A/V skew all need an output
file to probe, and there is no container on this side of the socket. A fourth,
criterion 8's loudness **on the received stream**, has to be measured at the destination;
what `levels` reports is the source figure off the in-graph `ebur128`, the same one tier 0
reports. What this run *does* cover that tier 0 cannot: RTMPS auth, a real uplink, and
whether the encoder holds 1x with a socket rather than a file absorbing its output.

`assertRtmpsSupport` runs before the fifo is made: an ffmpeg built without TLS has no
`rtmps` protocol, and finding that out from a connect error 40 minutes in is the
avoidable version of that discovery.

### Direct to YouTube versus through Cloudflare

`--destination youtube` pushes straight from this host to
`rtmps://a.rtmps.youtube.com:443/live2`, skipping Cloudflare entirely. That is **not the
adopted design** and it cannot test the claim the adopted design rests on.

The spec's topology exists so that **Cloudflare holds the YouTube connection** — the
renderer restarts underneath it and the broadcast does not notice, which is what makes
"restart to apply a journal change" cheap (spec criterion 5). Pushing direct, every
restart ends the YouTube broadcast and starts a new one. A direct run therefore proves
ingest, auth, pacing and levels, and proves **nothing** about restart transparency.

Current Cloudflare Stream pricing, re-read 2026-09-20 rather than trusted from the spec's
2026-09-13 figures (`developers.cloudflare.com/stream/pricing`): **$5 per 1,000 minutes
stored**, **$1 per 1,000 minutes delivered**, and simulcasting via RTMP live outputs
counts as delivery. With `recording.mode: off` there is no storage charge, so a 24/7
station is 43,200 delivered minutes ≈ **$43.20/month**, which matches the spec's $43
baseline. Testing is not the cost: a 30-minute tier-1 run with zero outputs is $0, and a
30-minute tier-2 run with one output is about $0.03. The $43.20 is what restart
transparency costs per month, and deferring it until the pipeline has survived a real
network at all is a reasonable order to do things in.

## Three mechanics that are load-bearing

**The fifo is held open read-write on fd 3.** A fifo returns EOF to its reader when the
last writer closes, so without `exec 3<>"$VIDEO_FIFO"` in `stream.sh`, restarting the
video feeder ends the broadcast. Opening `O_RDWR` does not block, and the descriptor is
never written to.

**`videofeed` writes faster than the framerate ffmpeg declares** — `TARGET_FPS` 4
against `DECLARED_FPS` 2 — so `-re` throttles it through pipe backpressure. A writer
slower than nominal starves the muxer, and a starved muxer stalls the *audio*: the one
way a picture problem takes the station off the air. `ops/videofeed.test.mjs` pins the
declared rate to what `stream.sh` actually hands ffmpeg.

**`videofeed` is started by `stream.sh`, never supervised separately** — see "The wedge"
below; a feeder-only restart wedges ffmpeg.

**`videofeed` emits a frame regardless of piece D's state.** Missing, stale, empty,
truncated, unreadable — something goes out. Piece D (#38) becomes a frame *source* that
`videofeed` reads, never a process in the broadcast path. The contract piece D must meet
is the whole of it: hand `videofeed` a 1280x720 PNG whenever you have a new one.

## Findings from tier 0, 2026-09-14

Three things the spec's invocation did not account for. All measured on this worktree
against ffmpeg 8.0.

### 1. Without `-shortest`, the renderer dying leaves a green unit over permanent dead air

The spec says "if the renderer exits, ffmpeg sees EOF". It does — but the **video** input
is infinite, so ffmpeg does not exit. Observed: renderer `kill -9`'d 25 s into a run,
ffmpeg still encoding silent video 60 s later, with no sign of stopping. The pipeline
never exits, so `pipefail` never fires, so `Restart=always` never fires. systemd holds a
healthy unit over a stream with no sound in it.

With `-shortest` the same kill ended the pipeline in 2 s. `-shortest` is therefore in
`stream.sh` and asserted by `ops/stream.test.mjs`. It alters no samples: it decides when
ffmpeg stops, not what it encodes.

### 2. ffmpeg's `speed=` is cumulative, and reads far below 1.0 for minutes after a restart

ffmpeg takes a fixed ~8 s to bring the `image2pipe` input up. The renderer is not the
cause — a cold `render.mjs` produces its first 8-cycle chunk in 0.18 s — and no audio is
lost, because the renderer blocks on a full pipe. It is one-time latency.

But the `speed=` figure ffmpeg prints is cumulative, so an 8 s offset reads as 0.13x at
10 s, 0.79x at 40 s, 0.94x at two minutes, on a run pacing at exactly 1.000x throughout.
The spec's alert condition — "`speed` outside 0.97–1.03 for 2 minutes" — would therefore
fire on **every restart**, which is every journal change.

The starvation signal has to be the *interval* speed between consecutive progress
records, which `ops/measure.mjs`'s `intervalSpeeds()` computes and `assessStarvation()`
judges. The monitoring design in the spec needs the same correction before tier 2.

### 3. The in-graph `ebur128` produces no continuous loudness signal as specified

`ebur128` prints its Summary **once, at the end of a run**, at `AV_LOG_INFO`. A 24/7
stream has no end, and the spec's production `-loglevel warning` suppresses the block
anyway. `framelog=verbose` does not mean "log verbosely" — it means "log at
`AV_LOG_VERBOSE`", one level below info, so the per-frame lines are suppressed too.

So the monitoring table's "integrated loudness | in-graph `ebur128`" row is currently
unobtainable. Tier 0 works around it by running at `-loglevel info` and reading the
end-of-run Summary, which a bounded run has. A continuous signal would need
`ametadata=print` at a sane interval, or an out-of-band measurement. Unresolved; it is
a monitoring gap, not a pipeline defect, and it does not block tier 0.

### 4. ffmpeg can deadlock with every process alive — the worst failure mode here

Observed 2026-09-14, 31 minutes into a 60-minute run and 90 seconds after the video
feeder was SIGKILLed and restarted: ffmpeg's output clock froze at 1791s and never moved
again. `sample` showed every ffmpeg thread — `dmx0:image2pipe`, `dmx1:s16le`, `fc0`,
`enc0:0:libx264`, `enc0:1:aac`, `mux0:flv` and the main thread — parked in
`__psynch_cvwait`. Nothing was blocked on a pipe read; the video feeder was writing
normally and ffmpeg had consumed everything it wrote. RSS crept 350.3 → 352.2 MB as
buffers filled behind the wedge. Renderer, ffmpeg, `stream.sh` and `videofeed` all
stayed alive.

**That state is worse than a crash.** Nothing exits, so `pipefail` never fires,
`-shortest` never fires, and `Restart=always` never fires. A supervisor watching process
liveness reports a healthy unit over dead air, indefinitely.

Two consequences:

- **The off-host watchdog is load-bearing, not a refinement.** The spec describes
  host-local signals as answering *why* after the Cloudflare watchdog answers *whether*.
  Against a wedge, the off-host watchdog is the only thing that answers *whether* at all,
  because every host-local liveness check says healthy. A host-local check on **output
  progress** — ffmpeg's `time=` advancing, or renderer progress lines arriving — catches
  it; a check on process liveness never does.
- **`npm run tier0` now fails a wedged run instead of hanging on it.** `detectStall()`
  watches the output clock; 120s frozen ends the run with a `DEAD AIR` verdict naming the
  frozen timestamp. Before that fix the harness waited on process exit, so the one
  failure that mattered most was the one it could not report.

**The cause was chased on 2026-09-15 and is now understood.** It is reproducible in about
a minute, and it is not what it looked like. See "The wedge: what triggers it" below. Two
candidates, with nothing yet separating them: `-shortest`, added this session on the
strength of finding 1; and the `fps=30` filter or `-re` on `image2pipe` mishandling a gap
in frame arrivals. If `-shortest` turns out to be the cause, there is a real tension to
resolve — it is also the only thing that makes renderer death detectable.

The 120s stall threshold is borrowed from the spec's "`speed` outside band for 2 minutes"
alert. It was not derived from how long a legitimate feeder outage can freeze the clock;
the only data point is that a 5-second outage froze it for under 10 seconds.

## The wedge: what triggers it, 2026-09-15

Reproduced with a stress harness that kills and restarts `videofeed` every 15-20 s
instead of waiting an hour per data point. The baseline wedges within about a minute,
which is what made any of the rest of this measurable.

### The signature

Always identical, measured at the boundary with dense sampling:

| | feeder writes | ffmpeg reads | output clock |
|---|---|---|---|
| before | 2.00 fps | 2.00 fps | 1.00 s/s |
| after, sustained | 4.00 fps | 4.00 fps | **0.00 s/s** |

On the far side of a feeder replacement, ffmpeg stops pacing the video input and reads
at whatever rate the writer supplies. Video PTS then advances at 2x realtime, runs away
from audio (`pts 39.500` against audio's `pts 31.915`), the muxer cannot interleave, the
audio demuxer stalls behind a full queue with a lag that grows every cycle, and every
thread ends in `__psynch_cvwait`.

### What it is NOT

Each of these was ablated, not reasoned about. Trial number is where the wedge appeared;
all six configurations wedge.

| variant | result |
|---|---|
| baseline | trial 3 |
| `-use_wallclock_as_timestamps 1` on the video input | trial 7 |
| wallclock timestamps AND no `-re` on the video input | trial 11 |
| `-shortest` removed | trial 2 |
| restart gap cut from 5 s to 0.5 s | trial 2 |
| **`SIGSTOP`/`SIGCONT` the same feeder process** | **15 trials, no wedge** |

So it is not `-shortest`; not `-re` on the video input; not index-derived versus
wallclock timestamps; not the length of the gap; and not a truncated PNG — `videofeed`
was measured writing complete frames even when told to stop at a frame boundary, and
those clean exits wedge too.

### What it IS

**Replacing the process that writes the fifo.** Pausing the same process and resuming it
never wedges, across 15 trials; replacing it wedges within one or two, whatever the gap
length and whatever the flags. Both disturbances starve ffmpeg identically during the
outage (read drops to 0.50 fps in each). The difference is entirely on the far side: a
paused writer's return leaves `-re` throttling at 2 fps, a replaced writer's return
leaves it reading flat out at 4.

### What that means for the design

**`Restart=always` on `endless-memory-videofeed.service` is actively harmful.** The
holder fd stops ffmpeg seeing EOF, which is what keeps the broadcast alive across a
feeder restart — but the restart then wedges the pipeline into dead air that no
host-local liveness check can see. A unit that restarts a crashed feeder is a unit that
converts a recoverable fault into an unrecoverable one.

The spec's criterion 6 — "videofeed is killed during the run and the broadcast does not
end ... and the unit restarts and resumes feeding" — is **not achievable with this seam
as designed**, and the hour-long run that appeared to pass it passed by luck.

Note what this does *not* threaten: piece D is decoupled by the **file interface**
(`videofeed` reads a path), not by `videofeed` being its own systemd unit. Piece D can
crash, stall, or write rubbish without the fifo's writer ever being replaced. The
separate unit buys nothing for piece D and costs this failure mode.

### What was done about it

**`videofeed` is no longer a unit. `stream.sh` starts it and the two die together.**
Decided 2026-09-15. A feeder fault now fails the unit, and systemd restarts renderer,
ffmpeg and feeder as one — which is cheap, because scene index is derived from absolute
time, so the music resumes at the correct moment rather than replaying or skipping.

The rule this enforces: **never replace the fifo's writer under a live ffmpeg.**

`ops/supervision.test.mjs` holds it in place, against the real `stream.sh` with the two
heavy binaries stubbed so it runs in seconds: the feeder is a child of the pipeline,
killing it ends the pipeline within a grace window, and there is no separate
always-restarting feeder unit. `npm run tier0 -- --kill-feeder-at N` is the same check
against real ffmpeg — measured 2026-09-15: *feeder killed at 90.1s; the pipeline ended
1.0s later*.

Piece D is unaffected. It is decoupled by the **file interface** `videofeed` reads, and
always was; the separate unit never bought anything for piece D and cost this failure
mode.

## Two things verified rather than asserted, 2026-09-14

### The fifo holder fd is what keeps a feeder restart from ending the broadcast

Not inference from the spec — the ablation was run. A scratch copy of `stream.sh` with
**only** `exec 3<>"$VIDEO_FIFO"` removed, against the same `videofeed.sh`, same kill at
30 s:

```
[noholder] killing the video feeder at 30s
[noholder] PIPELINE ENDED 33s after start — the feeder took the broadcast with it
[holder]   killing the video feeder at 30s
[holder]   PIPELINE STILL RUNNING 75s after start — the broadcast survived the feeder dying
```

ffmpeg's own account of the no-holder run:

```
[png @ ...] chunk too big
[vist#0:0/png @ ...] [dec:png @ ...] Decoding error: Invalid data found when processing input
[out#0/flv @ ...] Output file is empty, nothing was encoded
```

Two things in that: the SIGKILL left a truncated PNG in the fifo, which ffmpeg logged and
survived; and then the last writer closing delivered EOF, which it did not. Reproduce by
removing the one line.

### `systemd-analyze verify` found a bug the text tests could not

The units were checked against real systemd (252) in a Debian container, and it reported:

```
endless-memory-stream.service:30: Unknown key 'StartLimitIntervalSec' in section [Service], ignoring.
```

`StartLimitIntervalSec` moved from `[Service]` to `[Unit]` in systemd v229. In `[Service]`
it is **ignored**, and the unit silently falls back to the default limit — five restarts
in ten seconds, then systemd gives up. Both units carried it in the wrong section, and
`ops/units.test.mjs` passed the whole time because it asserted the line existed without
asserting which section it was in. The unit would have looked correct in every text
assertion while doing the one thing this design forbids: giving up, into permanent dead
air.

Fixed, and the test is now section-aware and was watched failing against the old
placement. Both units now verify clean. Re-check with:

```sh
docker run --rm -v "$PWD/ops:/units:ro" node:22-slim bash -c \
  'apt-get -qq update >/dev/null && apt-get -qq install -y systemd >/dev/null &&
   systemd-analyze verify /units/endless-memory-stream.service /units/endless-memory-videofeed.service'
```

A text assertion over a config file is a proxy for the parser that actually reads it. Where
the real parser can be run, run it.

## ffmpeg's RSS, characterised — 2026-09-16

Four clean runs, and the gate that kept firing was measuring the wrong thing.

| run | length | step | linear fit |
|---|---|---|---|
| hour2 | 1 h | ~43 min | 3.293 MB/h **FAIL** |
| hour3 | 1 h | none | 1.304 MB/h pass |
| hour4 | 1 h | ~28-33 min | 3.516 MB/h **FAIL** |
| rss4h | 4 h | 25 min | **0.094 MB/h** pass (0.70 MB/h counting the step) |

**ffmpeg takes ONE ~1.5 MB allocation in the first three quarters of an hour and is flat
either side of it.** Over four hours: 351.8 → 354.6 MB, one step, nothing else. That is
~1.5 MB per process lifetime, not a leak — the 24/7 concern this gate exists for does not
materialise.

One step dominates a one-hour linear fit and washes out of a four-hour one, so whether a
one-hour run passed depended on when the step happened to land relative to the warm-up
phase. That is arbitrary, and it is the metric's fault rather than the pipeline's.

`ops/measure.mjs`'s `assessFfmpegRss()` therefore refuses to judge a run shorter than four
hours, and reports the figure instead. **The 2.0 MB/h threshold is unchanged** and still
imported from the renderer's harness rather than restated; what changed is declining to
fit a trend to a run too short for the number to mean anything, which is the defence
`runtime/realtime.mjs` already built for the renderer at one hour. The rule is theirs; the
duration is ffmpeg's.

**Consequence for the spec.** Criterion 2 asks for "ffmpeg RSS flat" on a **one-hour** run.
A one-hour run cannot assess that. Either the criterion wants four hours, or its RSS term
should be read as "reported, and judged separately" — a decision for whoever provisions
the production host, where criterion 1's long run has to happen anyway.

```sh
npm run tier0 -- --minutes 240 --log-every 300     # the run that characterised this
```

## The first live run to YouTube failed on TLS — measured, 2026-09-20

A 25-minute run to an unlisted YouTube broadcast died after 36 seconds having delivered
nothing. YouTube's Stream health said **"No data"** the whole time. The cause was not in
this repo, and the sequence is worth keeping because almost every signal pointed the
wrong way.

**What the run looked like.** ffmpeg connected, printed its full
`Output #0, flv, to 'rtmps://a.rtmps.youtube.com:443/live2/...'` header — so TLS
handshake, RTMP connect, createStream and **publish all succeeded** — then encoded four
frames, froze at `time=00:00:00.10`, and stayed frozen for thirty seconds before dying
with `[tls] IO Error: -9806`. Total bytes out: 31 KiB, about one socket buffer. The
renderer's `EPIPE` at the end is the designed consequence of ffmpeg dying, not a cause.

The `Resumed reading ... after a lag of 20.360s` lines on both inputs are **backpressure
propagating backwards** from a blocked muxer, not a slow renderer. Reading them as
renderer starvation sends you upstream, which is the wrong direction.

**Three destinations, same flags, same machine, minutes apart.** This is what located it:

| destination | result |
|---|---|
| local file (`npm run tier0`) | PASS — 2.0 min produced, slowest interval 0.997x |
| local RTMP socket, flv muxer over a real socket | PASS — 2.0 min produced, slowest 0.987x |
| RTMPS to YouTube | FAIL at 36s, 31 KiB, output clock frozen |

The middle row is the one that matters: it exonerates the flv muxer, socket backpressure,
`-re` on both inputs, `-shortest`, the fifo holder fd and the feeder. Nothing in the flag
set needed changing, and changing flags would have been the expensive mistake here.

**The cause: an ffmpeg with no TLS library.** `/Users/cory/.local/bin/ffmpeg` 8.0 lists
`rtmps`, `rtmpts` and `tls` in `-protocols`, and its `-buildconf` contains **no TLS
library at all** — no `--enable-openssl`, `--enable-gnutls` or `--enable-mbedtls`. It
falls back to Apple's Secure Transport, and `-9806` is `errSSLClosedAbort`, a Secure
Transport code rather than an OpenSSL one. That backend completes the handshake and then
does not carry the session. Google's RTMPS guide requires SNI in the handshake
(`developers.google.com/youtube/v3/live/guides/rtmps-ingestion`).

**`rtmps` in `-protocols` is true and meaningless**, and it was the false reassurance that
let the run start: the old `assertRtmpsSupport` checked exactly that. It now checks
`-buildconf` for a real TLS library and names the override in the failure message.
`ops/live.test.mjs` pins the regression with a stub whose `-protocols` lists `rtmps` and
whose `-buildconf` has no TLS library.

**The fix is `--ffmpeg /opt/homebrew/bin/ffmpeg`** (8.1.2, `--enable-openssl`).
`stream.sh` already honoured `FFMPEG`; `live.mjs` now threads it and reports which binary
and which TLS library produced the run. A production host needs a TLS-capable ffmpeg
regardless, so this is a requirement rather than a workaround.

### Changing the ffmpeg binary is a sound change, and it was measured

The 2026-09-19 listen (#14's successor, `endless-memory-encoded-stream-listened`) went
through ffmpeg **8.0**'s AAC encoder. Moving the live path to 8.1.2 changes the encoder.
Measured on the same 60-second render, anchor `2026-09-11T12:00:00Z`, identical
`-c:a aac -b:a 192k` settings:

| | md5 of the ADTS stream | decoded integrated |
|---|---|---|
| ffmpeg 8.0 | `93ac7ab7741a2f3ee2d53a3446142215` | −19.9 LUFS |
| ffmpeg 8.1.2 | `32c9c6d6e78c9a9b731c358c9d43ba2e` | −19.9 LUFS |

Not bit-identical. Decoded loudness is unchanged. Nulling the two decodes against each
other gives **−51.9 dB RMS**, roughly 32 dB below programme — but that figure is **not
corrected for AAC priming delay**, which would inflate it, so treat it as an upper bound
rather than a measurement of audible difference.

Almost certainly inaudible, and still a sound change by this repo's rule, so it got a
listening pass rather than an argument.

**Listened to and approved on 2026-09-20.** Cory listened to the 25-minute live run
(unlisted broadcast `jFvbZwi_-uQ`), encoded by ffmpeg 8.1.2 and played back **through
YouTube** rather than locally. Verdict: approved.

That is a stronger listen than 2026-09-19's, which was local playback of an encode. This
one covers the whole delivered chain — renderer, the 8.1.2 AAC encoder, RTMPS, YouTube's
transcode, and the **44.1 kHz AAC-LC at 130 kbps** rendition a real listener is served,
resampled from the 48 kHz / 192 kbps source. The resample is now inside what has been
approved, where before it was only inferred from an upload's player config.

**The approved encoder is therefore ffmpeg 8.1.2 at the flags in `ops/stream.sh` as of
2026-09-20**, superseding 8.0 for the live path. A further change to the codec, bitrate
or filter graph is a new sound change needing its own listen, governed the same way as
`npm run fixtures`.

### What the harness got wrong

`detectStall` needs 120 s of frozen output clock, borrowed from the spec's "`speed`
outside band for 2 minutes" alert. This run's clock was frozen for 30 of its 36 seconds
and the report still said *"output clock advanced throughout"*. Against a file that
threshold is right; against a live ingest that hangs up first, it can never fire. The
live path needs its own, shorter threshold — unresolved, and tracked separately.

## The live path works — measured 2026-09-20, same evening

The TLS diagnosis above was inferred when it was written. It is now confirmed, and
criterion 8 has a number for the first time.

**Same command, same key, same destination, only the encoder binary changed** — the
retry passed `--ffmpeg /opt/homebrew/bin/ffmpeg` (8.1.2, `--enable-openssl`) and ran
25 minutes to an unlisted broadcast. **Verdict PASS**, and it ended by reaching its own
`--minutes 25` limit rather than by failing:

```
produced 25.0 min of audio in 25.2 min wall
drift: -13.42s vs realtime, bound +/-25.60s
startup offset: 8.77s
pacing: 149 interval(s) past warm-up, slowest 0.977x, floor 0.97
levels (source): -19.8 LUFS, LRA 1.0 LU, true peak -4.4 dBFS
stall: output clock advanced throughout
encoder: /opt/homebrew/bin/ffmpeg, TLS via --enable-openssl
key in output: absent
render: 475 cycles total, peak 0.6944, 0 clipped sample(s)
ffmpeg RSS 346.0 -> 346.7 MB over 8 phases, 1.381 MB/h reported, not judged under 4 h
```

**The pacing floor has less headroom over a real uplink.** Slowest interval was 0.977x
against the 0.97 floor, where the local-file and local-socket controls the same evening
managed 0.997x and 0.987x. It passed, and 25 minutes is not long enough to say whether
that margin is stable — it is the margin a network hiccup eats into, so it is the thing
to watch on the first long run rather than the RSS figure.

The cumulative figure climbing is the startup offset washing out, exactly as finding 2
above describes. It is not a pacing problem, and this run is the clearest demonstration
of that: interval speed was 1.000x from the first post-warm-up sample while the
cumulative number still read 0.56x.

**So the RTMPS failure was the TLS backend, confirmed by swapping only the binary.**

### Criterion 8, measured on the received stream

Pulled the 720p rendition back down off YouTube while the run was live and measured what
a listener actually receives:

| | measured | spec band |
|---|---|---|
| integrated | **−19.4 LUFS** | −22 … −18 |
| true peak | **−4.4 dBFS** | at or below −1 dBTP |
| LRA | 1.0 LU | — |

The whole chain holds: renderer PCM at −20.0 LUFS, through the encoder, through YouTube's
transcode, back down at −19.4. 0.6 LU across the entire path and no boost applied. This
is the one verdict `ops/live.mjs` reports as unreachable, and it is unreachable **from the
sending side** rather than in principle — pulling the stream back down recovers it, and
recovers track layout and A/V skew with it.

Reproduce (needs a live stream and an ffmpeg with TLS):

```sh
U=$(yt-dlp --no-warnings -f 95 -g "<watch url>" | head -1)
/opt/homebrew/bin/ffmpeg -user_agent "Mozilla/5.0" -i "$U" -t 30 -vn -c:a copy -y /tmp/recv.aac
/opt/homebrew/bin/ffmpeg -i /tmp/recv.aac -af ebur128=peak=true -f null -
```

**What comes back is 44.1 kHz AAC-LC at 130 kbps**, resampled from the 48 kHz / 192 kbps
source — matching the 2026-09-19 upload's renditions. Apple players get that path, so what
most listeners hear is not what `runtime/fixtures/golden-quiet.json` pins.

### YouTube's low-bitrate warning is expected and costs nothing

The Live Control Room reports *"current bitrate (220.34 Kbps) is lower than the
recommended bitrate. We recommend 2500 Kbps."* That is arithmetic, not a fault: x264 runs
with `nal_hrd=none filler=0`, so `-b:v 800k` is a ceiling and nothing pads it, and a
static 1280x720 PNG encodes to about 33 kbps (`kb/s:32.88` in the tier-0 log). 33 + 192
≈ 225 kbps.

**Nothing was lost to it.** With the stream at 220 kbps, YouTube served every rendition
through 720p:

```
91  256x144    269k      93  640x360   962k      95  1280x720  2448k
92  426x240    507k      94  854x480  1283k
```

Raising the video bitrate to 2500 kbps would pad roughly 2.3 Mbps of filler 24/7 to
transmit a still image — about 810 GB/month of uplink against 71 GB at the measured rate.
Leave it. When piece D (#38) puts moving content in the frame the rate will rise toward
the 800k ceiling on its own, and that is the point to revisit it.

### A trap on this machine

`/Users/cory/.local/bin/ffmpeg` precedes `/opt/homebrew/bin` on PATH, so **anything that
shells out to `ffmpeg` gets the TLS-less build** — `yt-dlp` hit it too while capturing the
stream above and failed with the same opaque exit code. `--ffmpeg-location
/opt/homebrew/bin` works around it per-invocation; reordering PATH or removing the
TLS-less build retires the whole class.

## An 11.9-hour live run — measured 2026-09-21

The longest run so far, and the first long enough for the RSS gate to return a judgement
instead of declining to. It ended when the **host lost its network connection**, not when
anything in the pipeline gave way.

`verdict: FAIL`, and that is the correct verdict — the run really did end in starvation.
But all three FAIL lines describe the same ~170 seconds at the very end:

```
produced 709.4 min of audio in 712.3 min wall
drift: -172.38s vs realtime, bound +/-25.60s
pacing: video starvation: below the 0.97 floor for 169s, from 42566s to 42735s (worst 0.000x)
stream.sh exited 224
```

42566 s is 709.4 min. The starvation window, the drift and the shortfall in produced audio
are one event, not three findings. The two progress samples either side of it show output
advancing 42557 s -> 42566 s across 90 s of wall: that is the connection dying, and the
renderer blocking behind a muxer that could no longer write.

**Everything before it was clean:** cumulative speed 1.00x, holding.

### The RSS question is answered

```
ffmpeg RSS verdict: -0.006 MB/h is within the 2.0 MB/h endurance threshold
```

`assessFfmpegRss` refuses to judge a run under four hours, because one ~1.5 MB allocation
dominates a shorter fit (see "ffmpeg's RSS, characterised" above). At 11.87 h it judged,
and the answer is essentially zero drift per hour.

| phase | span (h) | median RSS | min | max |
|---|---|---|---|---|
| 1 | 0.00-1.48 | 346.5 MB | 68.1 MB | 346.8 MB (warm-up) |
| 2-7 | 1.48-10.39 | **346.8 MB** | 346.8 MB | 346.8 MB |
| 8 | 10.39-11.87 | 346.7 MB | 346.0 MB | **353.4 MB** |

Phases 2 through 7 are flat to a tenth of a megabyte across ten hours. Phase 8's 353.4 MB
maximum is the outage, not a leak: buffers filling behind an output that had stopped
draining, the same signature the 2026-09-14 wedge produced (350.3 -> 352.2 MB). It appears
in the max and not the median, which is why the median-based fit is the one to trust.

**The 24/7 memory concern this gate exists for does not materialise.** That is now measured
over half a day rather than extrapolated from an hour.

### It also retires the pacing-margin worry

The 25-minute run's slowest interval was 0.977x against a 0.97 floor, recorded above as
thin margin worth watching on a long run. Across 11.9 hours the run held 1.00x. The margin
was not the beginning of a trend.

### The stall detector still did not fire — and did not need to

`detectStall` requires 120 s of an output clock that does not move at all. Here it kept
creeping (42557 -> 42566), so the test never tripped, while `assessStarvation` caught the
same event as 169 s below the pacing floor.

That is worth recording precisely, because it narrows #54: on the live path **pacing is the
sharper instrument, not stall**. A frozen clock is the wedge's signature; a *crawling* clock
is what a network outage produces, and only the pacing verdict sees it. Whatever threshold
#54 settles on, the starvation check is what actually caught the one real live failure so
far.

### Incidental: it would have archived

11.87 h is inside YouTube's 12-hour auto-archive limit (see "YouTube's 12-hour ceiling"
above), with about eight minutes to spare. A continuous station will not produce a VOD; a
run of this length does.

## Levels: measured, not corrected

Reproduce rather than trust:

```sh
node runtime/render.mjs --anchor 2026-09-11T12:00:00Z --out /tmp/m.pcm --seconds 300
ffmpeg -f s16le -ar 48000 -ac 2 -i /tmp/m.pcm -af ebur128=peak=true -f null -
```

`loudnorm`, `alimiter`, `acompressor`, `aresample=async` and `atempo` are **permanently
forbidden** in this graph. They alter samples, and the sound is listener-approved.
`ops/stream.test.mjs` asserts none of them appears in the argv or anywhere in
`stream.sh` outside a comment. If one ever becomes necessary it is a sound change with a
listening pass, governed by the same rule as `npm run fixtures`.

If true peak is ever above −1 dBTP, or `render.mjs`'s clipped counter is ever nonzero,
that is a **renderer bug to investigate**, not a level to correct downstream.

## YouTube's 12-hour ceiling — measured, 2026-09-19

A 12-hour test upload was removed by YouTube: *"This video was removed because it was
too long."* The documented cap is **256 GB or 12 hours, whichever is less**
(`support.google.com/youtube/answer/71673`). Size was never close: the file was 1.20 GB
at 222 kbps. Duration was the whole story, and it had **zero margin**.

`ffprobe` on the rejected file:

| track | measured | seconds |
|---|---|---|
| container | `format=duration` | 43200.000000 |
| video | 1,296,000 frames @ 30 fps | 43200.000000 |
| audio | 2,025,001 AAC frames x 1024 / 48000 | 43200.021333 |

The coded audio is **one AAC frame longer than 12 hours**; the container's edit list
trims it back to exactly 43200.000. Which of the two numbers YouTube's ingest read was
not observed — 43200.000 taken as at-the-limit, or 43200.021 taken as over it. Either
way a run aimed at exactly the cap has nothing to spare, so the mechanism does not need
to be settled to fix it.

**The render grid does not save you.** `runtime/render.mjs` renders
`ceil(seconds / BAR_MS)` cycles, and 43,200,000 ms / (240000/76) is **13680 exactly**, so
`--seconds 43200` is exactly 12 hours — the boundary, not a value near it.

**Rule: a file destined for upload gets `--seconds 42900`** (11h55m, exactly 13585
cycles). This is an upload constraint only; nothing in `ops/` reads it, because tier 0
writes to a local sink and tiers 1-3 push RTMPS.

**The rule's upload half is confirmed; its render half is not.** A lossless trim of the
rejected file — `ffmpeg -i endless-memory-test-12h-2026-09-19.mp4 -t 42900 -c copy
endless-memory-test-11h55m-2026-09-19.mp4` — was uploaded and watched through:
`https://www.youtube.com/watch?v=Azwsgt_H3Rs`. `ffprobe` reads that file at **42900.066667
s** (1,287,002 video frames at 30 fps), 1.19 GB. Because `-c copy` re-encodes nothing, what
was watched is bit-identical to the listener-approved encode, which is why the listen
carries over.

What it does **not** establish is the rule as written. `render.mjs --seconds 42900` has
never been run. That 42,900,000 ms / (240000/76) is exactly 13585 cycles is arithmetic, not
an observation, and a real render lands at 42900.000 where this trim landed at 42900.067 —
`-c copy` cuts on a packet boundary, not at the requested time. The upload was made outside
any recorded session, so the only account of it is this paragraph.

**It reaches the live path as a different limit.** YouTube auto-archives a stream only
if it ran **under 12 hours**; a longer one may not be captured at all
(`support.google.com/youtube/answer/6247592`). A continuous station therefore produces
**no VOD** — the broadcast is unaffected, the replay does not exist. If tier 2's
end-to-end run is ever wanted as a reviewable artifact, it has to stay under 12 hours or
be recorded locally.

## Install (not yet exercised — no host exists)

```sh
sudo useradd --system --home /opt/endless-memory --shell /usr/sbin/nologin endless
sudo install -d -o endless -g endless /opt/endless-memory
sudo rsync -a --delete ./ /opt/endless-memory/
sudo install -d -m 0700 -o endless -g endless /etc/endless-memory
sudo install -m 0600 -o endless -g endless /dev/null /etc/endless-memory/stream.env
# then write CF_STREAM_KEY=... into that file, and nowhere else
sudo cp ops/endless-memory-stream.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now endless-memory-stream
```

The host must run NTP: the anchor **is** the wall clock. An unsynced clock is an
alertable condition.

## Apply a journal change

```sh
node station.mjs weather rain
sudo systemctl restart endless-memory-stream
```

Events take effect at the first scene boundary at or after their timestamp — 32 bars,
about 101 s — so restarting at a convenient moment is fine. Restart is the mechanism;
there is no live reload by design.

## Rotate the stream key

The key lives in `/etc/endless-memory/stream.env`, mode 0600, and nowhere else. Rotate
it in the Cloudflare Stream API, write the new value into that file, then
`sudo systemctl restart endless-memory-stream`. The YouTube key is held by Cloudflare's
Live Output, not by this host: rotating it means updating the Live Output.

The assembled RTMPS URL is visible to `ps` for any local user, which is accepted only
because the host is single-tenant with one service account and no other logins. If that
stops being true, this stops being accepted. `DRY_RUN=1 ops/stream.sh` redacts the key.

## Kill the stream

```sh
sudo systemctl stop endless-memory-stream
```

For a live broadcast, disable or delete the Cloudflare Live Output **first** — that
stops the simulcast without tearing down the input — then stop the unit.
