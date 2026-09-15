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

**The cause is not identified and the wedge is not deterministic.** It has been seen
once. A 2-minute run, a 6-minute run, and a full 60-minute run that killed the feeder at
the same 1800s mark all recovered cleanly — the hour dipped pacing to 0.749x during the
outage and was back above the 0.97 floor by 1821s. One occurrence in three attempts at
that shape is not a reason to treat the pipeline as sound: the failure was observed, it
is invisible to process liveness, and nothing here explains it. Two
candidates, with nothing yet separating them: `-shortest`, added this session on the
strength of finding 1; and the `fps=30` filter or `-re` on `image2pipe` mishandling a gap
in frame arrivals. If `-shortest` turns out to be the cause, there is a real tension to
resolve — it is also the only thing that makes renderer death detectable.

The 120s stall threshold is borrowed from the spec's "`speed` outside band for 2 minutes"
alert. It was not derived from how long a legitimate feeder outage can freeze the clock;
the only data point is that a 5-second outage froze it for under 10 seconds.

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
