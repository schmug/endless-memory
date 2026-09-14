// The video feeder. It writes PNG frames into the fifo that ffmpeg reads, forever.
//
// This process is the whole decoupling from piece D (#38). Piece D is a frame SOURCE
// that videofeed reads; it is never a process in the broadcast path. Three properties
// hold that seam together, and two of them live here:
//
//   - videofeed emits a frame regardless of piece D's state. Missing, stale, empty,
//     truncated, unreadable: something goes out. This is about whether the station is
//     on the air, not about picture quality.
//   - videofeed writes FASTER than the framerate ffmpeg declares (TARGET_FPS against
//     DECLARED_FPS), so `-re` throttles it through pipe backpressure. A writer slower
//     than nominal starves the muxer, and a starved muxer stalls the AUDIO.
//
// The third lives in ops/stream.sh: the fifo is held open read-write on fd 3, so this
// process can crash and be restarted without ffmpeg ever seeing EOF.

import { statSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Declared to ffmpeg as `-framerate`; ops/videofeed.test.mjs pins stream.sh to it.
export const DECLARED_FPS = 2;
// What this process aims for. Higher than declared on purpose — see the header.
export const TARGET_FPS = 4;

// How old piece D's frame may be before videofeed stops believing it. Generous next to
// a 2 fps nominal: the point is to notice a source that has STOPPED, not to police
// jitter. Piece D can tighten it when it exists and has a rate of its own.
export const MAX_FRAME_AGE_MS = 5000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from('IEND');

// A frame caught mid-write has a plausible size and no tail. ffmpeg's decoder would
// reject it and the fifo would carry a hole instead of a picture, so the tail is
// checked here rather than discovered on air.
export function isCompletePng(buf) {
  if (!buf || buf.length < 20) return false;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  return buf.subarray(buf.length - 8, buf.length - 4).equals(IEND);
}

// Which of the three frame sources to use. Pure, so the policy can be tested without a
// filesystem, a clock or a running ffmpeg. `source` is a stat result or null.
export function chooseFrame({ source, hasLastGood, nowMs, maxAgeMs = MAX_FRAME_AGE_MS }) {
  if (source && source.size > 0 && nowMs - source.mtimeMs <= maxAgeMs) {
    return { use: 'source', reason: 'piece D frame is current' };
  }
  const why = !source ? 'no frame from piece D' : source.size === 0 ? 'piece D frame is empty' : 'piece D frame is stale';
  if (hasLastGood) return { use: 'last-good', reason: `${why}; holding the last good frame` };
  return { use: 'placeholder', reason: `${why}; no frame held, falling back to the placeholder` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function feed({ sourcePath, placeholder, out, fps = TARGET_FPS, maxAgeMs = MAX_FRAME_AGE_MS, frames = Infinity, now = Date.now } = {}) {
  const interval = 1000 / fps;
  let lastGood = null;
  let lastReason = null;
  let written = 0;

  while (written < frames) {
    const started = now();
    // Every read is inside a try: a frame source that throws must not be able to end
    // the feed, which is the same rule as a frame source that is missing.
    let stat = null;
    if (sourcePath) {
      try { stat = statSync(sourcePath, { throwIfNoEntry: false }) || null; } catch { stat = null; }
    }
    let { use, reason } = chooseFrame({ source: stat, hasLastGood: lastGood !== null, nowMs: started, maxAgeMs });

    let frame = null;
    if (use === 'source') {
      let bytes = null;
      try { bytes = readFileSync(sourcePath); } catch { bytes = null; }
      if (isCompletePng(bytes)) {
        lastGood = bytes;
        frame = bytes;
      } else {
        // Fall through exactly as a stale frame would: a half-written PNG is not a
        // reason to stop, only a reason not to send this one. The reason is rewritten
        // rather than reused from chooseFrame, because "piece D is writing frames I
        // cannot use" and "piece D is gone" call for different things at 3am.
        use = lastGood !== null ? 'last-good' : 'placeholder';
        reason = `piece D frame is truncated or not a PNG; ${use === 'last-good' ? 'holding the last good frame' : 'no frame held, falling back to the placeholder'}`;
      }
    }
    if (frame === null) frame = use === 'last-good' ? lastGood : placeholder;

    if (reason !== lastReason) {
      // stderr, never stdout — stdout is the frame channel.
      console.error(`videofeed: ${reason}`);
      lastReason = reason;
    }

    // write() returning false is the backpressure that paces this loop to ffmpeg's
    // -re, and is the normal state rather than an error.
    if (!out.write(frame)) await new Promise((r) => out.once('drain', r));
    written++;

    const spent = now() - started;
    if (spent < interval) await sleep(interval - spent);
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const placeholderPath = arg('placeholder', new URL('./placeholder.png', import.meta.url).pathname);
  const placeholder = readFileSync(placeholderPath);
  if (!isCompletePng(placeholder)) throw new Error(`${placeholderPath} is not a complete PNG — videofeed has no fallback frame`);

  // EPIPE when the reader goes away is a shutdown, not a crash to log a stack for.
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });

  await feed({
    sourcePath: arg('source', process.env.FRAME_SOURCE || null),
    placeholder,
    out: process.stdout,
    fps: Number(arg('fps', process.env.VIDEO_TARGET_FPS || TARGET_FPS)),
    maxAgeMs: Number(arg('max-frame-age-ms', MAX_FRAME_AGE_MS)),
    frames: arg('frames') ? Number(arg('frames')) : Infinity,
  });
}
