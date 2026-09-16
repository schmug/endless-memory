#!/usr/bin/env bash
#
# The broadcast pipeline: runtime/render.mjs -> ffmpeg -> a destination.
#
# The renderer and ffmpeg are ONE unit, never two. The pipe couples their lifetimes: if
# the renderer exits, ffmpeg sees EOF; if ffmpeg exits, the renderer takes EPIPE.
# Supervising them separately would produce a half-dead pipeline systemd believes is
# healthy.
#
# Destination is exactly one of:
#   CF_STREAM_KEY  production — RTMPS into the Cloudflare live input. The URL is
#                  assembled HERE, so unit files and journald never carry the key.
#   SINK           tier 0 — a local file or `-` with -f null. No network, no metered
#                  traffic, and no way for a test to reach the production input.
#
# DRY_RUN=1 prints the argv this would exec, one argument per line, with the key
# redacted, and exits. ops/stream.test.mjs asserts against that rather than against this
# file's text, so a flag inside a comment cannot pass for a flag that runs.
#
# Written to bash 3.2, because that is what /bin/bash is on macOS and the tier-0 harness
# runs there.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

VIDEO_FIFO="${VIDEO_FIFO:-/run/endless-memory/video.fifo}"
# Declared to ffmpeg. videofeed writes FASTER than this on purpose, so -re throttles it
# through pipe backpressure; ops/videofeed.mjs holds the matching DECLARED_FPS and
# ops/videofeed.test.mjs pins the two together.
VIDEO_FPS="${VIDEO_FPS:-2}"
RENDER="${RENDER:-$HERE/../runtime/render.mjs}"
# Overridable so ops/supervision.test.mjs can exercise the supervision logic in seconds
# with a stub, instead of only inside a long run against the real encoder.
FFMPEG="${FFMPEG:-ffmpeg}"
CHUNK_CYCLES="${CHUNK_CYCLES:-8}"
LOGLEVEL="${LOGLEVEL:-warning}"
# Default -stats emits continuously and would flood journald; 60 keeps it to ~1,440
# lines a day.
STATS_PERIOD="${STATS_PERIOD:-60}"
VIDEO_BITRATE="${VIDEO_BITRATE:-800k}"
RTMPS_BASE="${RTMPS_BASE:-rtmps://live.cloudflare.com:443/live}"

if [ -n "${SINK:-}" ] && [ -n "${CF_STREAM_KEY:-}" ]; then
  echo "stream.sh: set SINK (tier 0) or CF_STREAM_KEY (production), not both" >&2
  exit 64
fi
if [ -n "${SINK:-}" ]; then
  DEST="$SINK"
  DEST_SHOWN="$SINK"
elif [ -n "${CF_STREAM_KEY:-}" ]; then
  DEST="$RTMPS_BASE/$CF_STREAM_KEY"
  DEST_SHOWN="$RTMPS_BASE/REDACTED"
else
  echo "stream.sh: no destination — set CF_STREAM_KEY for RTMPS or SINK for a local file" >&2
  exit 64
fi

# The renderer's own arguments. Production passes NO --anchor: this is the one caller
# that should let it default to new Date(), so a restart resumes at the correct musical
# moment. Fixtures and the tier-0 harness pass one explicitly.
# SECONDS_LIMIT, not SECONDS: bash's SECONDS is a magic variable that counts wall time.
RENDER_ARGS=(--out - --chunk-cycles "$CHUNK_CYCLES")
if [ -n "${ANCHOR:-}" ]; then RENDER_ARGS=("${RENDER_ARGS[@]}" --anchor "$ANCHOR"); fi
if [ -n "${JOURNAL:-}" ]; then RENDER_ARGS=("${RENDER_ARGS[@]}" --journal "$JOURNAL"); fi
if [ -n "${SECONDS_LIMIT:-}" ]; then RENDER_ARGS=("${RENDER_ARGS[@]}" --seconds "$SECONDS_LIMIT"); fi

# -f s16le -ar 48000 -ac 2 is a restatement of the renderer's output format, not a
# tuning choice. ops/stream.test.mjs imports SR from runtime/voices.mjs and checks it.
#
# ebur128 hangs off an asplit and feeds anullsink: it MEASURES without processing, and
# the leg that reaches the encoder is a bit-exact copy. loudnorm, alimiter, acompressor,
# aresample=async and atempo are permanently forbidden here — they alter samples, and
# the sound is listener-approved.
#
# -shortest, added 2026-09-14 after observing the alternative: with an infinite video
# input and no -shortest, killing the renderer left ffmpeg encoding silent video
# indefinitely. The pipeline never exited, so Restart=always never fired and systemd
# held a green unit over permanent dead air. See ops/README.md.
FFMPEG_ARGS=(
  -hide_banner -loglevel "$LOGLEVEL" -stats -stats_period "$STATS_PERIOD"
  -re -f image2pipe -framerate "$VIDEO_FPS" -i "$VIDEO_FIFO"
  -re -f s16le -ar 48000 -ac 2 -i -
  -filter_complex "[0:v]fps=30,format=yuv420p[v];[1:a]asplit=2[aout][ameter];[ameter]ebur128=peak=true:framelog=verbose[m];[m]anullsink"
  -map "[v]" -map "[aout]"
  -c:v libx264 -preset veryfast -tune stillimage -profile:v high -pix_fmt yuv420p
  -b:v "$VIDEO_BITRATE" -maxrate "$VIDEO_BITRATE" -bufsize 1600k
  -g 60 -keyint_min 60 -sc_threshold 0
  -c:a aac -b:a 192k -ar 48000 -ac 2
  -shortest
  -f flv -y "$DEST"
)

if [ -n "${DRY_RUN:-}" ]; then
  for arg in "${FFMPEG_ARGS[@]}"; do
    if [ "$arg" = "$DEST" ]; then echo "$DEST_SHOWN"; else echo "$arg"; fi
  done
  exit 0
fi

[ -p "$VIDEO_FIFO" ] || mkfifo -m 600 "$VIDEO_FIFO"

# A fifo returns EOF to its reader when the last writer closes. Holding it open
# read-write on a spare descriptor means the feeder and ffmpeg can be started in either
# order without one blocking on the other, and a feeder that exits during shutdown does
# not deliver EOF mid-teardown. Opening O_RDWR does not block.
exec 3<>"$VIDEO_FIFO"

# THE FEEDER IS A CHILD OF THIS UNIT, NOT A UNIT OF ITS OWN.
#
# Measured 2026-09-15: replacing the process that writes the video fifo wedges ffmpeg —
# it stops pacing the video input, reads at the writer's full rate, video PTS runs away
# from audio, and every thread parks in __psynch_cvwait with the output clock frozen.
# Six configurations were ablated (with and without -shortest, with and without -re on
# the video input, index versus wallclock timestamps, a 0.5s restart gap versus 5s) and
# every one of them wedges. Only pausing and resuming the SAME process is safe.
#
# So the fifo's writer is never replaced under a live ffmpeg. The feeder lives and dies
# with the pipeline, and systemd restarts all three together. See ops/README.md.
#
# Piece D is unaffected by this: it is decoupled by the file interface videofeed reads,
# never by videofeed being separately supervised.
bash "$HERE/videofeed.sh" &
VIDEOFEED=$!

# pipefail (set above) so a renderer failure fails the unit even though ffmpeg exits 0
# on EOF.
node "$RENDER" "${RENDER_ARGS[@]}" | "$FFMPEG" "${FFMPEG_ARGS[@]}" &
PIPELINE=$!

# Whichever dies first takes the other with it. A feeder-only restart is the failure
# this whole arrangement exists to prevent, so a dead feeder must fail the unit.
while kill -0 "$VIDEOFEED" 2>/dev/null && kill -0 "$PIPELINE" 2>/dev/null; do
  sleep 1
done

if ! kill -0 "$VIDEOFEED" 2>/dev/null && kill -0 "$PIPELINE" 2>/dev/null; then
  echo "stream.sh: the video feeder exited — ending the pipeline so systemd restarts both rather than handing a live ffmpeg a new writer" >&2
  kill -TERM "$PIPELINE" 2>/dev/null
  wait "$PIPELINE" 2>/dev/null
  exit 75
fi

kill -TERM "$VIDEOFEED" 2>/dev/null
wait "$PIPELINE"
