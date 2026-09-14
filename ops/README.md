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
ops/measure.mjs                       level, pacing and A/V-sync parsers and verdicts
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
survived; ffmpeg's RSS flat. A clean exit and a large file are not a pass.

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
