# Broadcast and ops (piece E) — design

Date: 2026-09-13
Status: specified, not implemented

## Problem

The renderer produces correct PCM on stdout forever. Nothing encodes it, nothing
carries it to a listener, nothing notices when it stops. Piece E is everything
between `render.mjs --out -` and a stranger hearing the station, plus the parts that
keep it running at 3am with nobody watching.

The failure modes here are operational rather than musical: dead air, a burned quota,
a leaked key, an unnoticed crash. None of them are detectable by any test in this
repository, so this spec is mostly about what gets measured and who gets told.

## Scope

**In scope.** The encode-and-push pipeline, the placeholder video track, process
supervision and restart recovery, level measurement, monitoring and alerting, secret
storage, the metered-spend cap, and the staged test path that ends in a public stream.

**Out of scope.** The visual layer (piece D, #38) — this spec deliberately does not
wait for it, and the seam it substitutes into is specified below. The live weather
feed (piece B, #39). Listener interaction (piece F, #40). Any change to the renderer,
the engine, or the sound: piece E consumes `render.mjs`'s stdout and modifies nothing
upstream of it.

**Recording, VOD, clipping, and a Cloudflare-hosted player** are also out of scope,
and not merely unbuilt — recording is switched off deliberately, for a reason that is
a spend cap rather than a preference. See "Metered resources".

## Decisions adopted, not reopened

Decided 2026-09-11 and recorded at
`docs/superpowers/specs/2026-09-11-audio-runtime-design.md:287-301`. This spec adopts
them as given:

- The renderer runs on an **always-on host** and pushes **RTMPS into a Cloudflare
  Stream Live Input**, which **simulcasts to YouTube Live**.
- **Cloudflare Containers were evaluated and rejected** for the renderer. The platform
  documents them as unsuitable for continuous 24/7 operation: a 10-minute default idle
  sleep, ephemeral disk, and 1–3 second cold starts that would be audible holes.
- Because **Cloudflare holds the YouTube connection**, the renderer can restart without
  YouTube noticing. This is what makes "restart to apply journal changes" cheap.
- **YouTube Live requires a video track**, so whatever pushes RTMP must produce picture
  as well as sound.

The Containers rejection applies to the renderer, which must never sleep. It does not
apply to a Worker on a cron trigger that polls a status endpoint once a minute, and the
monitoring design below uses one.

Also adopted from piece C, and load-bearing here: **journal changes are applied by
restarting the renderer, not by watching the file**
(`2026-09-11-audio-runtime-design.md:32-36`). Nothing in this spec invents live reload.

## What this design depends on, and what is not yet proven

**The whole pipeline rests on `render.mjs --out -` sustaining exactly 1x through a
consuming pipe.** Every figure this project has about the renderer comes from
`runtime/endurance.mjs`, which consumes chunks as fast as they are produced (~109x).
Realtime is a different regime.

Status as of 2026-09-13: **measured promising, not proven.** The realtime proof harness
(#36, PR #41) piped `render.mjs --out -` into `ffmpeg -re` and a 3-minute validation
against ffmpeg 8.0 reported:

```
produced 0.050 h of audio in 0.050 h wall — final speed 1.000x
drift: +0.35s vs realtime, bound ±25.60s (one 8-cycle chunk + a 64 KiB pipe)
silence: no silent stretches
verdict: PASS
```

A 3-hour run was still running when this spec was written. Three minutes is not
evidence that a 24/7 stream holds, and PR #41 is a draft for exactly that reason.

What this spec does with that:

- It **does not assume realtime works.** Acceptance criterion 1 is `npm run realtime`
  for at least 3 hours **on the production host**, not on the dev machine. The harness
  already exists; ops re-runs it rather than inventing a new check.
- If the renderer proves unable to hold 1x on the chosen host, **the encoder flags do
  not change.** The contingency is a buffer between renderer and encoder — render ahead
  into a ring buffer or a rolling file and have ffmpeg read that — which the drift
  tolerance in `driftTolerance()` already models as "one chunk plus the pipe". A larger
  in-flight allowance is a bigger number in the same formula, not a different design.
- Sustained `speed` **above** 1.0 is also a failure, and the harness already fails on
  it. It means backpressure never engaged, and a clean exit with a large file proves
  nothing on its own.

## Architecture

Everything piece E adds lives **outside** the no-runtime-dependencies boundary. That
guard covers `composer.mjs`, `station.mjs` and `runtime/`
(`runtime/render.test.mjs`), and none of them are touched. Ops files land in a new
top-level `ops/` directory, which the guard does not and should not cover.

```
ops/endless-memory-stream.service     systemd unit: the render → ffmpeg pipeline
ops/endless-memory-videofeed.service  systemd unit: the frame writer
ops/stream.sh                         the pipeline, including the fifo holder fd
ops/videofeed.sh                      writes PNG frames to the fifo, forever
ops/placeholder.png                   the launch picture
ops/README.md                         install, rotate a key, kill the stream
```

Process tree on the host:

| process | supervised by | job |
|---|---|---|
| `node runtime/render.mjs --out -` | `endless-memory-stream.service` | PCM to stdout, paced by the pipe |
| `ffmpeg` | same unit, same pipeline | encode, mux, push RTMPS |
| `videofeed` | `endless-memory-videofeed.service` | one PNG frame into the fifo, forever |
| Cloudflare Stream Live Input | Cloudflare | ingest, hold the YouTube connection |
| Cloudflare Live Output | Cloudflare | simulcast to YouTube Live |
| watchdog Worker (cron) | Cloudflare | poll live-input status, alert |

The renderer and ffmpeg are **one unit**, never two. The pipe couples their lifetimes:
if the renderer exits, ffmpeg sees EOF; if ffmpeg exits, the renderer takes EPIPE.
Supervising them separately would produce a half-dead pipeline that systemd believes is
healthy.

`videofeed` is a **separate** unit, and that separation is the whole decoupling from
piece D. See "The video seam".

### The ffmpeg invocation

```sh
ffmpeg -hide_banner -loglevel warning -stats -stats_period 60 \
  -re -f image2pipe -framerate 2 -i "$VIDEO_FIFO" \
  -re -f s16le -ar 48000 -ac 2 -i - \
  -filter_complex "\
    [0:v]fps=30,format=yuv420p[v]; \
    [1:a]asplit=2[aout][ameter]; \
    [ameter]ebur128=peak=true:framelog=verbose[m]; \
    [m]anullsink" \
  -map "[v]" -map "[aout]" \
  -c:v libx264 -preset veryfast -tune stillimage -profile:v high -pix_fmt yuv420p \
    -b:v 800k -maxrate 800k -bufsize 1600k -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a aac -b:a 192k -ar 48000 -ac 2 \
  -f flv "$RTMPS_URL"
```

Why each part is what it is:

- `-f s16le -ar 48000 -ac 2` matches `runtime/voices.mjs:9` (`SR = 48000`) and
  `toPcm`'s dual-mono 16-bit LE output exactly. These three flags are not tunable; they
  are a restatement of the renderer's output format, and getting one wrong produces
  audio that plays at the wrong speed while passing every structural check.
- `-re` on **both** inputs. The audio side is the mechanism the realtime proof
  exercised. The video side is there because an unpaced infinite source races ahead and
  ffmpeg buffers it, which on a 24/7 run is a slow leak.
- `fps=30` on the video path. The fifo carries a nominal 2 fps; the encoder emits 30 fps
  CFR. YouTube's documented recommendation is 30 or 60 fps, and whether it accepts less
  is untested — 30 is chosen so nobody has to find out. A static frame at 30 fps costs
  almost nothing: every frame after a keyframe is a skip.
- `-g 60 -keyint_min 60 -sc_threshold 0` gives a fixed 2-second closed GOP, which is
  YouTube's requirement.
- `-b:v 800k` is far below YouTube's recommended range for 720p30. That is correct for a
  static frame and, later, for ASCII art. **YouTube will warn that the bitrate is below
  recommended; that warning is expected and is not a fault.** Record it in the runbook so
  the next person does not chase it.
- `ebur128` hangs off an `asplit` and feeds `anullsink`. This **measures without
  processing** — the branch that reaches the encoder is a bit-exact copy. See "Levels".
- `-stats_period 60` keeps ffmpeg's progress records to roughly 1,440 lines a day.
  Default `-stats` emits continuously and would flood journald.

**Forbidden in this graph, permanently:** `loudnorm`, `alimiter`, `acompressor`,
`aresample=async`, `atempo`, and anything else that alters samples. They change a
listener-approved sound. If one ever becomes necessary it is a sound change with a
listening pass, governed by the same rule as `npm run fixtures`.

**Audio is the clock.** Video is fitted to audio; audio is never resampled, stretched,
or dropped to fit video. Two independent `-re` pacers can drift against each other over
a long run, and the mechanism above (CFR `fps=30` regenerating video timestamps) is
**believed** to absorb it but has not been measured over 24 hours. That measurement is
acceptance criterion 2. If drift proves unbounded, the fix is on the video side —
pacing `videofeed` off the audio byte count — never on the audio side.

### The destination

Ingest, verified from Cloudflare's live-input documentation on 2026-09-13:

```
rtmps://live.cloudflare.com:443/live/$CF_STREAM_KEY
```

The Live Input holds one **Live Output** pointed at YouTube
(`rtmp://a.rtmp.youtube.com/live2` plus the YouTube stream key). Cloudflare supports up
to 50 concurrent destinations per live input and outputs can be added or removed
mid-broadcast, which is what makes the test path below cheap: the same input can be
pointed at an unlisted broadcast first and the public one later, without restarting
anything on the host.

## The video seam: how piece E ships without piece D

This is the part of the spec that exists to prevent a dependency. YouTube needs a video
track; the visual layer is undesigned. If piece E waits for piece D, piece E has failed.

**The seam is a named pipe carrying PNG frames.** ffmpeg reads
`-f image2pipe -framerate 2 -i /run/endless-memory/video.fifo` and knows nothing about
what writes it. `videofeed` writes it.

```
                 ┌─────────────┐
piece D (later) →│  videofeed  │→ /run/endless-memory/video.fifo → ffmpeg
   (a source)    └─────────────┘
                        ↑
                 ops/placeholder.png  (always available, always the fallback)
```

**At launch (P0).** `videofeed` emits `ops/placeholder.png` on a loop. The picture is a
still frame: the station name, small, on the dark ground the eventual visuals will use.
Nothing else exists and nothing else is needed.

**Later (P1).** Piece D becomes a *source that `videofeed` reads*, never a process that
ffmpeg depends on. `videofeed` emits D's latest frame when one is fresh and the last good
frame, or the placeholder, when it is not. Substituting the real visual layer therefore
changes:

- the ffmpeg invocation: **nothing**
- the encoder settings, bitrate, GOP, or RTMPS URL: **nothing**
- the systemd units or supervision shape: **nothing**
- the level measurement or alerting: **nothing**
- `videofeed`'s frame source: **everything**

Three properties make this hold, and each is a requirement on the implementation rather
than a hope:

1. **ffmpeg must never see EOF on the video input.** A fifo returns EOF to its reader
   when the last writer closes. `ops/stream.sh` therefore opens the fifo read-write on a
   spare descriptor (`exec 3<>"$VIDEO_FIFO"`) and never writes to it. Opening a fifo
   `O_RDWR` does not block, and holding that descriptor means writers can start, crash,
   and be replaced without the reader ever seeing the end of the stream. Without this,
   a `videofeed` restart ends the broadcast.
2. **`videofeed` must produce frames faster than the declared input rate.** `-re` then
   throttles it through pipe backpressure, exactly as it throttles the renderer. A writer
   slower than nominal starves the muxer, and a starved muxer stalls the *audio* — which
   is the one way a video problem can take the station off the air. Target 4 fps against
   a declared 2.
3. **`videofeed` is owned by piece E, and must emit a frame regardless of piece D's
   state.** Piece D's own unreachable-feed fallback (#38, step 4) is a separate, softer
   concern about picture quality. This one is about whether the station is on the air.

The contract piece D must meet is therefore small: hand `videofeed` a PNG, 1280x720,
whenever you have a new one. Everything about rate, timing, failure, and encoding stays
on this side of the seam.

## Supervision and restart recovery

`endless-memory-stream.service`, on the always-on host:

- `ExecStart=/bin/bash -o pipefail /usr/local/bin/stream.sh` — `pipefail` so a renderer
  failure fails the unit even though ffmpeg exits 0 on EOF.
- `Restart=always`, `RestartSec=2`.
- **No start limit.** `StartLimitIntervalSec=0`. A start limit makes systemd *give up*
  after a burst, and for a 24/7 station permanent dead air is strictly worse than a
  restart loop. Crash-looping is caught by alerting, not by refusing to restart.
- `EnvironmentFile=/etc/endless-memory/stream.env` (mode 0600). See "Secrets".
- A dedicated unprivileged service user; `ProtectSystem=strict`, `NoNewPrivileges=yes`,
  `PrivateTmp=yes`.

`endless-memory-videofeed.service`: same shape, `Restart=always`, no start limit,
independent of the audio unit.

**Why a restart is cheap, and the one thing that has not been observed.** Scene index is
derived from absolute time, so a restarted renderer resumes at the correct musical
moment rather than replaying or skipping
(`2026-09-11-audio-runtime-design.md:32-36`). The production invocation passes **no**
`--anchor` — this is the one caller that should let it default to `new Date()`, and the
reason fixtures must always pass one explicitly does not apply here.

Sequence and cost of a restart:

| step | cost |
|---|---|
| Node boot + journal read and `validate()` | ~0.1 s |
| first chunk: 8 cycles ≈ 25.3 s of audio at ~109x | ~0.25 s |
| ffmpeg start, RTMPS connect and handshake | ~1–2 s |
| **total gap at Cloudflare ingest** | **~2–3 s, estimated, not measured** |

`cycleForInstant` floors to `BAR_MS` (240000/76 = 3157.9 ms), so a restart resumes from
the start of the unit already in progress and the listener hears up to 3.16 s of music
they have already heard. That roughly cancels the connect gap. Neither figure has been
observed on air.

**The unobserved claim.** "Cloudflare holds the YouTube connection, so the renderer can
restart without YouTube noticing" is an inference from Cloudflare's architecture, not
something this project has watched happen. Whether a brief RTMPS ingest disconnect
leaves the YouTube Live Output intact — or ends the YouTube broadcast — is the single
most important unknown in this spec, because the cheap-restart property is what the
journal workflow is built on. It is acceptance criterion 5, and it must be observed on
an unlisted broadcast before anything public.

**Applying a journal change** is `station.mjs weather …` or `station.mjs remember …`,
then `systemctl restart endless-memory-stream`. Note the engine's own semantics soften
the urgency: events take effect at the first scene boundary at or after their timestamp
(32 bars, ~101 s), so an immediate restart does not make the change immediately audible
anyway. Restarting at a convenient moment is fine.

**Clock.** The anchor *is* the wall clock, so the host must run NTP (chrony or
`systemd-timesyncd`), and an unsynced clock is an alertable condition. A clock step
mid-run does not disturb the music — the anchor is read once at boot — but it silently
moves where the next restart lands.

## Levels: measured, not corrected

The renderer soft-clips through `tanh` and counts every pre-clip excursion past 1.0
(`runtime/render.mjs:29-45`), so the signal cannot exceed digital full scale by
construction and a limiter has nothing to do.

Measured 2026-09-13 on this worktree, ffmpeg 8.0, five minutes rendered at each anchor
and analysed with `ebur128=peak=true`:

| anchor | integrated | LRA | true peak | renderer's pre-clip peak | clipped |
|---|---|---|---|---|---|
| `2026-09-11T12:00:00Z` (day) | −20.0 LUFS | 1.0 LU | −4.3 dBFS | 0.7100 | 0 |
| `2026-09-11T02:00:00Z` (night) | −19.7 LUFS | 1.0 LU | −4.1 dBFS | 0.7330 | 0 |

Reproduce rather than trust the table:

```sh
node runtime/render.mjs --anchor 2026-09-11T12:00:00Z --out /tmp/m.pcm --seconds 300
ffmpeg -f s16le -ar 48000 -ac 2 -i /tmp/m.pcm -af ebur128=peak=true -f null -
```

Three things follow, and they settle the level policy without touching the sound:

1. **The station sits at about −20 LUFS with a 1.0 LU range, day and night.** It is
   extremely consistent, which makes a loudness alert a tight, useful signal rather than
   a noisy one.
2. **True peak is −4.3 dBFS, not −3.0.** The renderer reports a pre-clip peak of 0.71,
   but `tanh(0.71) = 0.611`, which is −4.3 dBFS — the two figures are the same
   observation on either side of the soft clip. There is over 4 dB of headroom before
   anything is at risk, and AAC intersample peaks have nowhere near that much room to
   find.
3. **No limiter, no normalizer, in the live path.** YouTube normalizes playback toward
   about −14 LUFS and only turns content *down*, so a −20 LUFS stream is left alone and
   will sound quieter than most of YouTube. That is a property of a concentration stream,
   and changing it means changing the approved sound: a listening pass, not an ffmpeg
   flag.

If true peak is ever observed above −1 dBTP, or the clipped counter is ever nonzero,
**that is a renderer bug to investigate**, not a level to correct downstream.

## Monitoring and alerts

Two separate questions: what is continuously observable, and what is worth waking
someone for.

### Signals

| signal | source | normal | alert condition |
|---|---|---|---|
| renderer progress line | `render.mjs` stderr → journald | one line per ~303 s (12 chunks × 8 cycles) | none for 7 minutes |
| clipped sample count | same line | `0` | any nonzero |
| chunk peak | same line | ≈0.71–0.74 | > 0.95, or < 0.2 |
| ffmpeg `speed` | ffmpeg stderr, `-stats_period 60` | `1.00x` | outside 0.97–1.03 for 2 minutes |
| integrated loudness | in-graph `ebur128` | −20 ± 1 LUFS | outside −22…−18 over 10 minutes |
| true peak | in-graph `ebur128` | ≈ −4.2 dBFS | above −1.0 dBTP |
| unit restarts | systemd / journald | rare | more than 3 in 15 minutes |
| live input connection | Cloudflare API, `GET /accounts/{id}/stream/live_inputs/{uid}` | connected | disconnected > 60 s |
| live output health | same API | enabled, no error | errored or disabled unexpectedly |
| host clock sync | `timedatectl` | synchronized | not synchronized |
| Stream spend | Cloudflare billing notifications | ≤ cap | 50% and 90% of cap |

`speed` below 1.0 while renderer progress lines keep arriving points at **video
starvation**, not the renderer. That is the diagnostic the seam design makes possible,
and it belongs in the runbook.

### Where the watchdog runs

**Off-host, deliberately.** A watchdog co-located with the thing it watches cannot
report the host being dead, which is the failure that matters most. The primary watchdog
is a **Cloudflare Worker on a cron trigger**, polling the live-input status endpoint
every minute and alerting when the input has been disconnected for more than 60 seconds.
Nothing about the Containers rejection applies to it: it sleeps between runs by design,
which is exactly what the renderer must never do.

Host-local signals (renderer lines, ffmpeg speed, loudness, restarts) are secondary and
faster. A systemd `OnFailure=` unit is fine for those. They are a refinement of *why*,
after the Worker has already answered *whether*.

### The alert set

Only four things are worth an interruption:

1. **Dead air** — live input disconnected > 60 s, or no renderer progress line for 7
   minutes, or `speed` outside band for 2 minutes.
2. **Crash loop** — more than 3 restarts in 15 minutes. The unit will keep trying
   forever by design, so this is the only thing that notices.
3. **Spend** — the metered cap crossed at 50% and 90%.
4. **A sound-integrity signal** — nonzero clipped count, or loudness out of band.

Everything else is a log line. The alert channel is an open question (below); the
default is Cloudflare's own notification system to email, because it is already
authenticated and off-host.

## Secrets

Three, and none of them ever enter this repository.

| secret | what it opens | where it lives |
|---|---|---|
| `CF_STREAM_KEY` | RTMPS ingest into the live input | `/etc/endless-memory/stream.env` on the host, mode 0600, service user, loaded by systemd `EnvironmentFile=` |
| `CF_API_TOKEN` | reading live-input status, managing outputs | Cloudflare Workers secret (`wrangler secret put`) for the watchdog; the host copy, if any, in the same env file |
| `YT_STREAM_KEY` | publishing to the YouTube channel | given to Cloudflare **once** when the Live Output is created; it lives in Cloudflare's configuration, not on the host |

Rules:

- **Nothing in the repo.** `ops/` carries unit files and scripts that *reference*
  `$CF_STREAM_KEY`; it never carries a value. Add `*.env`, `.env*` and `ops/secrets/` to
  `.gitignore` as a backstop, not as the reason.
- **Never in the unit file.** Unit files are world-readable. The secret is loaded via
  `EnvironmentFile=`, and the RTMPS URL is assembled **inside** `stream.sh` so the
  journal records `$RTMPS_URL`, not its expansion.
- **Scope the API token.** Account-scoped, `Stream:Read` — and `Stream:Edit` only if the
  watchdog is ever given the ability to re-create an output. Never a Global API Key.
- **Residual exposure, stated rather than hidden.** The assembled RTMPS URL still appears
  in ffmpeg's `argv` and is therefore visible to `ps` for any local user. This is accepted
  because the host is single-tenant with one service account and no other logins. It is
  not accepted if that ever stops being true. Both keys are rotatable: the Cloudflare
  stream key from the Stream API, the YouTube key from YouTube Studio, and rotating the
  YouTube key means updating the Cloudflare Live Output, not the host.
- **This repository is public.** A key committed here is public within seconds. Before
  the first `ops/` commit, grep the tree; before the first launch, grep the journald
  output for both key prefixes and confirm neither appears.

## Metered resources and the cap

Cloudflare Stream is metered. Figures below were read from
`developers.cloudflare.com/stream/pricing` on **2026-09-13**; prices change and this
paragraph will go on asserting an old one, so re-read it before launch rather than
trusting the table.

- **$5 per month per 1,000 minutes of video storage capacity.**
- **$1 per 1,000 minutes delivered.**
- **Simulcasting counts toward delivery minutes** at the standard rate, with no separate
  simulcast charge.

### Expected consumption

Continuous operation is 60 × 24 × 30 = **43,200 minutes per 30-day month**.

| line | calculation | monthly |
|---|---|---|
| simulcast to YouTube (delivery) | 43,200 / 1,000 × $1 | **$43.20** |
| Cloudflare-side playback | no player is published; expected 0 viewer-minutes | $0 |
| recording storage | **switched off** — see below | $0 |
| **expected total** | | **~$43/month** |

### The thing that would blow the budget

If the live input's `recording.mode` is `automatic`, a 24/7 stream generates 43,200
minutes of recordings a month. At $5 per 1,000 minutes of capacity that is **$216 in the
first month and it accrues again every month the recordings are retained**, against a
$43 baseline. **`recording.mode` must be `off`.**

There is a documentation conflict here and it must be settled by observation, not by
reading. On 2026-09-13 the live-inputs API documentation stated the default is `off`,
while the Stream Live overview stated that all Stream Live videos are automatically
recorded. Neither is evidence about this account. Before any run longer than a test:

1. Read the input back — `GET /accounts/{account_id}/stream/live_inputs/{uid}` — and
   confirm `recording.mode === "off"`.
2. After the first tier-1 run, check the Stream dashboard and confirm **zero stored
   minutes**, rather than assuming the setting held.

### The cap

- **Hard monthly cap: $75** for Cloudflare Stream. That is the $43 baseline plus enough
  headroom to absorb a test month, and little enough that recording-left-on or an
  unexpected embed crosses it within days instead of at the invoice.
- **Cloudflare billing notifications at 50% ($37) and 90% ($67).** Configured before the
  first byte is sent, not after.
- **Kill action, written in `ops/README.md` so it is executable at 3am by someone
  half-awake:** disable or delete the Live Output, then `systemctl stop
  endless-memory-stream`. Disabling the output stops the simulcast without tearing down
  the input.
- **Pre-launch test budget: $5 total, all tiers.** The end-to-end test is ~2 hours ≈ 120
  delivered minutes ≈ $0.12. The test path is not the spend risk; unattended running is,
  which is the point of capping the thing that runs unattended.

### The test path: never the public destination

Self-test traffic never goes to the public YouTube destination. Three tiers, each of
which must pass before the next is attempted:

**Tier 0 — local, zero metered traffic.** The complete ffmpeg invocation, including the
video fifo, the filter graph and both encoders, writing to `-f flv /tmp/out.flv` or
`-f null -` instead of the RTMPS URL. Every flag change is validated here first. This
exercises everything except the network and costs nothing, so there is no excuse for
changing a flag without it.

**Tier 1 — a dedicated test live input, no outputs.** A **second** live input named
`endless-memory-test`, with zero Live Outputs attached and `recording.mode: off`. Proves
RTMPS auth, ingest, and the connection-status endpoint the watchdog polls. A separate
input is not fussiness: a second RTMP connection to the *production* input would fight
the live broadcast, so a test must never be able to reach it.

**Tier 2 — an unlisted YouTube broadcast.** The test live input plus one Live Output
pointed at an **unlisted** YouTube broadcast on a test stream key. This is the
end-to-end acceptance test, and the only tier where YouTube is involved at all.

Only after tier 2 passes does a Live Output pointed at the public destination get
attached — to the production input, which by then has never carried a test frame.

## Constraints

- Node 22 and ffmpeg on an always-on Linux host. The realtime harness parses ffmpeg 8.0's
  progress format specifically (`elapsed=`, a unit on `size=`), so ffmpeg 8.0 or later.
- **Nothing in `composer.mjs`, `station.mjs` or `runtime/` changes.** Piece E consumes
  stdout. The no-runtime-dependencies guard in `runtime/render.test.mjs` binds, and
  `ops/` sits outside it.
- **No live journal reload.** Restart is the mechanism, by design.
- The sound does not move. No fixture and no golden is regenerated by this piece, and any
  ffmpeg filter that alters samples is forbidden (see "Levels").
- Sustained egress is roughly 1 Mbps (800k video + 192k audio) ≈ **324 GB/month**, which
  is a host-selection constraint, not an incidental figure.
- Host sizing: the renderer plateaus around 180 MB RSS with a +7.3 MB/day post-warm-up
  creep (`2026-09-11-audio-runtime-design.md:243-283`), and x264 `veryfast` on a static
  720p30 frame is close to free. 2 vCPU and 1 GB RAM is the floor; the renderer needs
  ~1% of a core at 1x, having measured 109x.

## Open questions

1. ~~**Which always-on host.**~~ **DECIDED 2026-09-14: a small VPS.** The criteria stand
   as the shopping list — Linux, 2 vCPU, 1 GB RAM, ≥ 500 GB/month egress, stable upstream,
   and uptime that is somebody's job — and the reasoning that carried it was that a home
   upstream and its power are the station's availability floor and neither is monitored.
   Budget context: roughly $5–10/month for the box, on top of the ~$43/month Cloudflare
   estimate below (hard cap $75). The specific provider and instance are not chosen yet,
   but that is a purchase, not a design question. **Implementation is no longer blocked on
   this.**
2. **Alert channel.** Default is Cloudflare notifications to email. A push channel is
   better at 3am and needs an owner decision about what is worth waking up for.
3. **Does Cloudflare re-encode the simulcast, or pass the source through?** Unverified as
   of 2026-09-13. It determines whether the encoder settings above are what YouTube
   actually receives. Answerable by observation during tier 2: compare the YouTube
   player's reported resolution, frame rate and bitrate against what ffmpeg sent.
4. **The YouTube channel itself** — which account, and whether the stream is ever
   monetized. Not a technical blocker for E, but #38's webcam-rights question depends on
   the answer.

## Acceptance criteria

1. `npm run realtime` completes a run of at least 3 hours **on the production host**,
   verdict PASS, with speed, drift and RSS slope recorded here alongside the figures in
   `2026-09-11-audio-runtime-design.md`.
2. **Tier 0** runs the complete ffmpeg invocation for at least 1 hour to a local sink,
   with: A/V sync drift measured at the start and at the end and stated, ffmpeg RSS flat,
   and no video starvation (`speed` never below 0.97).
3. **Tier 1** pushes RTMPS to the dedicated test live input for at least 30 minutes; the
   API reports the input connected; `recording.mode` is read back as `off`; and the Stream
   dashboard afterwards shows **zero stored minutes**.
4. **Tier 2, the end-to-end test:** at least 2 hours to an **unlisted** YouTube broadcast
   through a Cloudflare Live Output, watched and listened to for at least 10 continuous
   minutes. No public stream happens before this passes.
5. **Restart recovery is observed, not inferred.** During the tier-2 run,
   `systemctl restart endless-memory-stream` is issued and the unlisted YouTube broadcast
   **stays live**. The gap is measured and recorded. If the YouTube broadcast ends
   instead, the cheap-restart premise is wrong and the journal workflow needs rethinking
   before launch.
6. `videofeed` is killed during the tier-2 run and the broadcast **does not end** — the
   picture freezes, the audio continues, and the unit restarts and resumes feeding. This
   is the criterion that proves piece D cannot take the station off the air.
7. A journal event appended with `station.mjs` and applied by restart is audible on the
   unlisted stream at the following scene boundary.
8. Loudness measured **on the received stream** is within −22…−18 LUFS integrated with
   true peak at or below −1 dBTP, consistent with the −20.0/−19.7 LUFS source figures
   above.
9. Stopping the unit ends ingest and the dead-air alert fires within its stated window,
   observed by actually stopping it.
10. **No secret in the repository, the unit files, or the logs.** Verified by grepping
    the tree and the journald output for both key prefixes, not by having been careful.
11. Total Cloudflare spend across all pre-launch testing is at or below $5, read from the
    dashboard rather than estimated, and the $75 cap with its 50%/90% notifications is
    configured and observed to exist.
12. `npm test` counts are unchanged and `composer.mjs`, `station.mjs` and `runtime/` are
    untouched by this piece.

Criteria 5 and 6 matter most. Both are claims this design rests on — that a restart is
cheap, and that the visual layer is not load-bearing — and neither has ever been watched
happen.

## Risks

| Risk | Mitigation |
|---|---|
| The renderer cannot hold 1x on the production host | Criterion 1 runs the existing harness there before launch; contingency is a buffer between renderer and encoder, not a redesign. |
| A restart ends the YouTube broadcast, making journal changes expensive | Criterion 5 observes it on an unlisted stream. If it fails, the workflow changes before launch, not after. |
| Piece D arrives and destabilises a working stream | The fifo holder fd and `videofeed`'s always-emit contract mean D is a frame *source*, never a process in the broadcast path. Criterion 6 proves it by killing the feeder. |
| Video starvation stalls the audio | `videofeed` targets 4 fps against a declared 2, and `-re` throttles it; `speed` below 1.0 with healthy renderer lines is the diagnostic. |
| Recording left on: $216/month instead of $43 | `recording.mode` read back from the API, zero stored minutes confirmed on the dashboard after tier 1, spend notifications at 50%/90% of a $75 cap. |
| A key reaches the public repo | Never in `ops/`, `EnvironmentFile` only, URL assembled inside the script, grep of tree and journal as criterion 10. |
| An overnight crash nobody notices | Off-host Worker watchdog polling live-input status every minute; no systemd start limit, so the unit never gives up quietly. |
| ffmpeg flags drift without validation | Tier 0 costs nothing and exercises everything but the network; no flag change ships without it. |
| Cloudflare prices or defaults change under a stale spec | Every Cloudflare figure here is dated 2026-09-13 with the page it came from; re-read rather than trust. |
