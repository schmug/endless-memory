# ops — the broadcast pipeline

Everything between `runtime/render.mjs --out -` and a listener. Implemented from
`docs/superpowers/specs/2026-09-13-broadcast-ops-design.md`; read that first, it is
authoritative and this file does not repeat it.

**What is built: tier 0 only** — the complete pipeline against a **local sink**. No
RTMPS, no Cloudflare, no YouTube, no secrets, no metered traffic. Tiers 1–3 of the
spec's test path (a test live input, an unlisted YouTube broadcast, the public stream)
need a host that does not exist yet.

```
ops/stream.sh                         the pipeline: render.mjs | ffmpeg, and the fifo holder fd
ops/videofeed.sh                      the frame writer, as systemd runs it
ops/videofeed.mjs                     the frame policy — which frame goes out, and when
ops/placeholder.mjs                   generates ops/placeholder.png
ops/placeholder.png                   the launch picture, 1280x720
ops/measure.mjs                       level, pacing, A/V-sync and stall parsers and verdicts
ops/tier0.mjs                         the local-sink proof run (`npm run tier0`)
ops/endless-memory-stream.service     systemd unit: render -> ffmpeg
ops/endless-memory-videofeed.service  systemd unit: the frame writer
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

Unresolved, and left for a decision rather than guessed at: whether to fold `videofeed`
into the stream unit so a feeder fault restarts the whole pipeline (cheap: the spec puts
a restart at ~2-3 s, and scene index is derived from absolute time so the music resumes
in the right place), or to keep two units and have a feeder failure trigger a stream
restart. Either way the rule is the same: **never replace the fifo's writer under a live
ffmpeg.**

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

## Install (not yet exercised — no host exists)

```sh
sudo useradd --system --home /opt/endless-memory --shell /usr/sbin/nologin endless
sudo install -d -o endless -g endless /opt/endless-memory
sudo rsync -a --delete ./ /opt/endless-memory/
sudo install -d -m 0700 -o endless -g endless /etc/endless-memory
sudo install -m 0600 -o endless -g endless /dev/null /etc/endless-memory/stream.env
# then write CF_STREAM_KEY=... into that file, and nowhere else
sudo cp ops/endless-memory-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now endless-memory-videofeed endless-memory-stream
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
