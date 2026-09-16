#!/usr/bin/env bash
#
# The frame writer, as systemd runs it. A separate unit from the stream, and that
# separation is the whole decoupling from piece D: this process can crash, be restarted,
# or be replaced wholesale by one that reads piece D's frames, and ffmpeg never notices,
# because ops/stream.sh holds the fifo open read-write on fd 3.
#
# All the policy is in ops/videofeed.mjs, which is testable. This file exists only to
# own the fifo plumbing.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIDEO_FIFO="${VIDEO_FIFO:-/run/endless-memory/video.fifo}"

[ -p "$VIDEO_FIFO" ] || mkfifo -m 600 "$VIDEO_FIFO"

# Opening a fifo write-only blocks until a reader exists. Under systemd that reader is
# stream.sh's fd 3, which is held open across this unit's whole lifetime — so this
# blocks only if the stream unit is genuinely down, which is the correct thing to do.
exec node "$HERE/videofeed.mjs" "$@" > "$VIDEO_FIFO"
