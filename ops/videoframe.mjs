// Piece D's process: poll the NPS Boston Light west camera, decode and crop each new
// frame, render it as ASCII, and keep a 1280x720 PNG on disk for videofeed to read.
//
// Specified in docs/superpowers/specs/2026-09-14-visual-layer-design.md. Three rules
// from it shape this file more than anything else:
//
//   - THE CROP HAPPENS IN decodeCropped() AND NOWHERE ELSE. It is the only function in
//     piece D that hands JPEG bytes to a decoder, the crop is in the same ffmpeg filter
//     chain as the decode, and nothing but the 160x35 cropped, downscaled grid comes out.
//     The uncropped bytes are never written to disk. Three trademarks are burned into
//     the top band of every live frame; there is no code path that renders it.
//   - It refuses any frame that is not 3840x2160 rather than cropping by ratio. The crop
//     is a fixed rectangle against an overlay somebody else controls.
//   - It keeps rewriting its PNG while the camera is down. If it stopped, videofeed
//     would time it out and the station would fall back to the placeholder on exactly
//     the failure piece D exists to absorb. liveness.mjs decides what the picture is.
//
// Piece D is a file writer. It is never in the broadcast path: videofeed reads the PNG
// and owns its own fallback, and this process can die at any moment without the
// broadcast noticing.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLiveness, ARCHIVE } from './liveness.mjs';
import {
  COLS, ROWS, autoLevel, smooth, toGlyphs, churn, renderPng, captionLine,
} from './asciiframe.mjs';

export const SOURCE_URL = 'https://www.nps.gov/webcams-boha/west-001.jpeg';
// The overlay-free still. Fetched once with `fetch-archive` and committed; never
// fetched at runtime, because it is what renders when the network is the problem.
export const ARCHIVE_URL = 'https://www.nps.gov/webcams-boha/west-002.jpeg';

export const EXPECTED_WIDTH = 3840;
export const EXPECTED_HEIGHT = 2160;
// Drop the top 360 rows (trademark block ends at y ~ 305) and the bottom 100 (tide
// overlay starts at y ~ 2087), keep full width. Measured 2026-09-14 on west-001.
export const CROP = 'crop=3840:1700:0:360';

export const USER_AGENT =
  'endless-memory/1.0 (generative radio station; +https://github.com/schmug/endless-memory; contact via GitHub issues)';

// The source's own cadence, and the floor. Never poll faster.
export const POLL_MS = 60_000;
export const MAX_BACKOFF_MS = 15 * 60_000;
export const FETCH_TIMEOUT_MS = 30_000;

// How often the PNG is rewritten, whatever the camera is doing. Inside videofeed's
// MAX_FRAME_AGE_MS (5 s) with room to spare.
export const REPUBLISH_MS = 2_000;

const ROOT = new URL('./frames/', import.meta.url);
export const DEFAULT_OUT = new URL('boston-light-west.png', ROOT).pathname;
export const DEFAULT_ARCHIVE = new URL('archive-west.jpeg', ROOT).pathname;

export class RefusedFrame extends Error {}

// The frame's dimensions, read from its SOF header without decoding anything. Covers
// baseline, extended and progressive JPEG (SOF0-SOF3); anything else is refused.
export function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff) return null;
    const marker = buf[at + 1];
    if (marker === 0xff) { at += 1; continue; }        // fill byte
    if (marker === 0xd9 || marker === 0xda) return null; // EOI or scan data before any SOF
    const length = buf.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      if (at + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(at + 5), width: buf.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

// THE decode call site. JPEG bytes in, a 160x35 Uint8Array of cropped luminance out.
// The crop and the area-averaging downscale run in the same ffmpeg filter chain as
// the decode, and the bytes travel over stdin and stdout only.
export function decodeCropped(jpeg, { ffmpeg = 'ffmpeg' } = {}) {
  const size = jpegSize(jpeg);
  if (!size) throw new RefusedFrame('not a JPEG with a readable frame header');
  if (size.width !== EXPECTED_WIDTH || size.height !== EXPECTED_HEIGHT) {
    throw new RefusedFrame(`frame is ${size.width}x${size.height}, not ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}; refusing to crop by ratio`);
  }
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'jpeg_pipe', '-i', 'pipe:0',
    '-vf', `${CROP},scale=${COLS}:${ROWS}:flags=area,format=gray`,
    '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
  ], { input: jpeg, maxBuffer: 1 << 20 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new RefusedFrame(`ffmpeg could not decode the frame: ${String(result.stderr).trim()}`);
  }
  if (result.stdout.length !== COLS * ROWS) {
    throw new RefusedFrame(`ffmpeg returned ${result.stdout.length} bytes, expected ${COLS * ROWS}`);
  }
  return new Uint8Array(result.stdout);
}

// The wait before the next poll. Success: exactly the cadence. After n consecutive
// failures: exponential from 60 s to the 15-minute ceiling, with up to 20% jitter. A
// camera that is down is never polled harder than one that is up.
export function nextDelay(failures, random = Math.random) {
  if (failures <= 0) return POLL_MS;
  const base = POLL_MS * 2 ** Math.min(failures, 10);
  return Math.max(POLL_MS, Math.min(MAX_BACKOFF_MS, Math.round(base * (1 + 0.2 * random()))));
}

// One conditional GET per call. Returns what the transport concluded, in the shape
// liveness.mjs takes plus what the renderer needs:
//   { kind: 'frame', bytes, hash, lastModified, status }   200 with a JPEG body
//   { kind: 'unchanged', status: 304 }
//   { kind: 'error', status?, reason }
export function createPoller({ fetch = globalThis.fetch, url = SOURCE_URL, userAgent = USER_AGENT, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let etag = null;
  let lastModified = null;

  async function poll() {
    const headers = { 'User-Agent': userAgent, Accept: 'image/jpeg' };
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;

    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch (e) {
      return { kind: 'error', reason: e?.name === 'TimeoutError' ? 'timed out' : String(e?.cause?.code || e?.message || e) };
    }
    if (res.status === 304) return { kind: 'unchanged', status: 304 };
    if (res.status !== 200) return { kind: 'error', status: res.status, reason: `HTTP ${res.status}` };
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/jpeg')) return { kind: 'error', status: 200, reason: `content-type ${type || 'missing'}` };

    let bytes;
    try { bytes = Buffer.from(await res.arrayBuffer()); } catch (e) {
      return { kind: 'error', status: 200, reason: `body: ${e?.message || e}` };
    }
    etag = res.headers.get('etag');
    lastModified = res.headers.get('last-modified');
    return {
      kind: 'frame',
      status: 200,
      bytes,
      hash: createHash('sha256').update(bytes).digest('hex'),
      lastModified,
    };
  }

  return { poll };
}

// The station's picture state: what the poller has said, what the ladder concludes,
// and the frame that follows from both. No timers and no filesystem — the run loop
// below drives it, and the tests drive it with a hand-held clock.
export function createVideoFrame({ now, decode = decodeCropped, archiveGrid, log = () => {} }) {
  if (!archiveGrid || archiveGrid.length !== COLS * ROWS) {
    throw new Error('createVideoFrame needs the decoded archive still: it is what renders on a cold start');
  }
  const liveness = createLiveness({ now });
  const archiveLines = toGlyphs(autoLevel(archiveGrid).levelled);

  let acceptedHash = null;  // the newest frame that decoded, which liveness also holds
  let tone = null;          // the smoothed, levelled grid of the live picture
  let capturedAt = null;    // that frame's Last-Modified, or its fetch time
  let lastState = ARCHIVE;
  let lastLines = null;

  // Record one poll outcome. A new frame is decoded here, and only if it is new: a
  // repeat goes to liveness as a repeat without a decode, and a refused frame goes as
  // an error, so the ladder ages exactly as if the fetch had failed.
  function record(outcome) {
    if (outcome.kind !== 'frame') {
      liveness.record({ kind: outcome.kind });
      log({ event: 'poll', result: outcome.kind, status: outcome.status ?? null, reason: outcome.reason ?? null });
      return;
    }
    if (outcome.hash === acceptedHash) {
      liveness.record({ kind: 'frame', hash: outcome.hash });
      log({ event: 'poll', result: 'repeat', status: 200, frozen: liveness.status().frozen });
      return;
    }

    let grid;
    try { grid = decode(outcome.bytes); } catch (e) {
      if (!(e instanceof RefusedFrame)) throw e;
      liveness.record({ kind: 'error' });
      log({ event: 'poll', result: 'refused', status: 200, reason: e.message });
      return;
    }
    const { levelled, span } = autoLevel(grid);
    // Coming back from the archive still, the average restarts at this frame: blending
    // the archive into a picture captioned live would show something that is not now.
    tone = lastState === ARCHIVE ? Float64Array.from(levelled) : smooth(tone, levelled);
    acceptedHash = outcome.hash;
    const parsed = outcome.lastModified ? Date.parse(outcome.lastModified) : NaN;
    capturedAt = Number.isFinite(parsed) ? parsed : now();
    liveness.record({ kind: 'frame', hash: outcome.hash });

    const lines = toGlyphs(tone);
    log({ event: 'poll', result: 'frame', status: 200, span, churn: churn(lastLines, lines), lastModified: outcome.lastModified ?? null });
  }

  // What to draw now. Callable at any time: during an outage nothing is recorded and
  // the picture still has to age down the ladder.
  function frame() {
    const status = liveness.status();
    const lines = status.state === ARCHIVE || tone === null ? archiveLines : toGlyphs(tone);
    const caption = status.state === ARCHIVE || tone === null
      ? captionLine({ capturedAt: null, status: status.caption })
      : captionLine({ capturedAt, status: status.caption });
    if (status.state !== lastState) log({ event: 'state', from: lastState, to: status.state, ageMs: status.ageMs, frozen: status.frozen });
    lastState = status.state;
    lastLines = lines;
    return { state: status.state, lines, caption };
  }

  return { record, frame };
}

// Write next to the target, then rename over it, so videofeed never reads half a PNG.
export function publish(path, png) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, png);
  renameSync(tmp, path);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Forever: republish every REPUBLISH_MS, poll on the polling contract's schedule.
export async function run({ out = DEFAULT_OUT, archive = DEFAULT_ARCHIVE, poller = createPoller(), now = Date.now, log }) {
  const archiveGrid = decodeCropped(readFileSync(archive));
  const vf = createVideoFrame({ now, archiveGrid, log });
  mkdirSync(dirname(out), { recursive: true });

  let failures = 0;
  let nextPollAt = now();
  let cachedKey = null;
  let cachedPng = null;

  for (;;) {
    if (now() >= nextPollAt) {
      const outcome = await poller.poll();
      vf.record(outcome);
      failures = outcome.kind === 'error' ? failures + 1 : 0;
      nextPollAt = now() + nextDelay(failures);
    }
    const { lines, caption } = vf.frame();
    const key = caption + '\n' + lines.join('\n');
    if (key !== cachedKey) { cachedPng = renderPng(lines, caption); cachedKey = key; }
    try { publish(out, cachedPng); } catch (e) { log({ event: 'publish-failed', reason: e.message }); }
    await sleep(REPUBLISH_MS);
  }
}

// The one-off fetch of the archive still. Run once on a host that can reach nps.gov,
// look at the result, and commit it. It is checked against the same size rule as a
// live frame, so a still that would be refused at runtime is refused here instead.
export async function fetchArchive(path = DEFAULT_ARCHIVE, { fetch = globalThis.fetch } = {}) {
  const res = await fetch(ARCHIVE_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (res.status !== 200) throw new Error(`${ARCHIVE_URL}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  decodeCropped(bytes);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { bytes: bytes.length, lastModified: res.headers.get('last-modified') };
}

// One recorded frame through the real ingest path to a PNG, for checking the crop by
// eye (criterion 1) and for feeding tier 0 a real ASCII frame (open question 1).
export function renderRecorded(jpeg) {
  const lines = toGlyphs(autoLevel(decodeCropped(jpeg)).levelled);
  return { lines, png: renderPng(lines, captionLine({ capturedAt: null, status: 'recorded frame - not live' })) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? fallback : rest[i + 1];
  };
  // stderr only, one JSON object per line, so a long run's log can be read back for
  // criteria 3 and 8 rather than assumed.
  const log = (o) => console.error(JSON.stringify({ at: new Date().toISOString(), ...o }));

  if (cmd === 'render') {
    const [input, output] = rest;
    if (!input) { console.error('usage: node ops/videoframe.mjs render <frame.jpeg> [out.png]'); process.exit(64); }
    try {
      const { lines, png } = renderRecorded(readFileSync(input));
      if (output) writeFileSync(output, png); else process.stdout.write(lines.join('\n') + '\n');
    } catch (e) {
      if (!(e instanceof RefusedFrame)) throw e;
      console.error(`videoframe: refused: ${e.message}`);
      process.exit(2);
    }
  } else if (cmd === 'fetch-archive') {
    const r = await fetchArchive(rest[0] || DEFAULT_ARCHIVE);
    console.error(`videoframe: archive still saved, ${r.bytes} bytes, Last-Modified ${r.lastModified}`);
  } else if (cmd === 'run') {
    log({ event: 'start', userAgent: USER_AGENT, url: SOURCE_URL });
    await run({ out: arg('out', DEFAULT_OUT), archive: arg('archive', DEFAULT_ARCHIVE), log });
  } else {
    console.error('usage: node ops/videoframe.mjs <render <frame.jpeg> [out.png] | run [--out path] [--archive path] | fetch-archive [path]>');
    process.exit(64);
  }
}
