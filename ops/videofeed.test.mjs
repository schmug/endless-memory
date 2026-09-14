import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, openSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chooseFrame, isCompletePng, feed, MAX_FRAME_AGE_MS, TARGET_FPS, DECLARED_FPS } from './videofeed.mjs';

const FRESH = { mtimeMs: 1000, size: 4084 };

// Rule 1 of the seam: piece D's frame is used when it is actually there and actually
// current. Everything else in this file is a fallback away from this case.
test('a fresh frame from piece D is the one that goes out', () => {
  const choice = chooseFrame({ source: FRESH, hasLastGood: true, nowMs: 1500, maxAgeMs: MAX_FRAME_AGE_MS });

  assert.equal(choice.use, 'source');
});

// #38 step 4 is piece D's own fallback and a softer concern — picture quality. This
// one is about whether the station is on the air, so a stalled piece D holds the last
// picture rather than stopping the feed.
test('a stale frame falls back to the last good one rather than stopping', () => {
  const choice = chooseFrame({ source: FRESH, hasLastGood: true, nowMs: 1000 + MAX_FRAME_AGE_MS + 1, maxAgeMs: MAX_FRAME_AGE_MS });

  assert.equal(choice.use, 'last-good');
});

test('a stale frame with nothing good behind it falls back to the placeholder', () => {
  const choice = chooseFrame({ source: FRESH, hasLastGood: false, nowMs: 1000 + MAX_FRAME_AGE_MS + 1, maxAgeMs: MAX_FRAME_AGE_MS });

  assert.equal(choice.use, 'placeholder');
});

// A PNG caught mid-write is a real state, not a hypothetical: piece D writes the file
// while videofeed reads it four times a second. A zero-length file is the cheap half of
// that to detect, and emitting it would hand ffmpeg a truncated frame.
test('a zero-length frame is not emitted even when its mtime is current', () => {
  const choice = chooseFrame({ source: { mtimeMs: 1000, size: 0 }, hasLastGood: false, nowMs: 1000, maxAgeMs: MAX_FRAME_AGE_MS });

  assert.equal(choice.use, 'placeholder');
});

// The other half of the mid-write problem. A file with a plausible size can still be
// a PNG missing its tail, and the size check above cannot see that. ffmpeg's decoder
// would reject the frame, and the fifo would carry a hole instead of a picture.
test('a truncated PNG is rejected, not handed to ffmpeg', () => {
  const whole = readFileSync(new URL('./placeholder.png', import.meta.url));

  assert.equal(isCompletePng(whole), true);
  assert.equal(isCompletePng(whole.subarray(0, whole.length - 1)), false, 'a frame missing its IEND read as complete');
  assert.equal(isCompletePng(Buffer.alloc(0)), false);
  assert.equal(isCompletePng(Buffer.concat([Buffer.from('not a png'), whole.subarray(9)])), false);
});

// The launch state, and the one the spec names outright: videofeed must emit a frame
// regardless of piece D's state, and at launch piece D does not exist at all.
test('no frame source at all still emits the placeholder', () => {
  const choice = chooseFrame({ source: null, hasLastGood: false, nowMs: 1000, maxAgeMs: MAX_FRAME_AGE_MS });

  assert.equal(choice.use, 'placeholder');
});

// The spec's third seam property. A writer slower than the declared input rate starves
// the muxer, and a starved muxer stalls the AUDIO — the one way a picture problem takes
// the station off the air. Writing faster than declared means `-re` throttles videofeed
// through pipe backpressure instead.
test('videofeed targets a higher rate than the framerate ffmpeg declares, so -re throttles it', () => {
  assert.ok(TARGET_FPS > DECLARED_FPS, `${TARGET_FPS} fps target does not exceed the declared ${DECLARED_FPS} fps`);
});

// The declared rate is stated twice — here and in the ffmpeg invocation — and the two
// must not drift apart, because the whole backpressure argument above is a comparison
// between them.
test('the declared framerate matches the one ops/stream.sh hands ffmpeg', () => {
  const args = execFileSync('bash', [new URL('./stream.sh', import.meta.url).pathname], {
    encoding: 'utf8',
    env: { ...process.env, DRY_RUN: '1', SINK: '/tmp/tier0.flv' },
  }).trim().split('\n');

  assert.equal(args[args.indexOf('-framerate') + 1], String(DECLARED_FPS));
});

// journald is where this gets diagnosed at 3am. "no frame from piece D" and "piece D is
// writing frames I cannot use" call for different things — restart piece D, or go and
// look at what it is writing — so the truncated case must not be logged as the missing
// one.
test('a truncated frame is logged as truncated, not as a missing one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'videofeed-trunc-'));
  const source = join(dir, 'current.png');
  const placeholder = readFileSync(new URL('./placeholder.png', import.meta.url));
  writeFileSync(source, placeholder.subarray(0, placeholder.length - 4));

  const reasons = [];
  const originalError = console.error;
  console.error = (line) => reasons.push(line);
  try {
    await feed({ sourcePath: source, placeholder, out: { write: () => true }, frames: 1, fps: 1000 });
  } finally { console.error = originalError; }

  assert.match(reasons.join('\n'), /truncated|incomplete/i, `logged instead: ${reasons.join(' | ')}`);
  assert.doesNotMatch(reasons.join('\n'), /no frame from piece D/);
  rmSync(dir, { recursive: true, force: true });
});

test('videofeed emits complete placeholder PNGs when piece D has produced nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'videofeed-'));
  const frames = await collectFrames({ dir, args: [], ms: 1500 });

  assert.ok(frames.length >= 4, `only ${frames.length} frames in 1.5s — below the ${TARGET_FPS} fps target`);
  const placeholder = readFileSync(new URL('./placeholder.png', import.meta.url));
  for (const f of frames) assert.deepEqual([...f], [...placeholder]);
  rmSync(dir, { recursive: true, force: true });
});

// Criterion 6 at the videofeed level: piece D vanishing mid-run must not stop the
// frames. The process-level version of this — killing videofeed itself — is the
// tier-0 harness's job, because it needs ffmpeg on the other end of the fifo.
test('videofeed keeps emitting after its frame source is deleted mid-run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'videofeed-'));
  const source = join(dir, 'current.png');
  const custom = readFileSync(new URL('./placeholder.png', import.meta.url));
  writeFileSync(source, custom);

  const frames = await collectFrames({
    dir, args: ['--source', source], ms: 1600,
    midRun: () => rmSync(source, { force: true }),
    midRunAtMs: 600,
  });

  assert.ok(frames.length >= 4, `only ${frames.length} frames — the feed stopped`);
  rmSync(dir, { recursive: true, force: true });
});

// The seam's plumbing, end to end and in miniature: a fifo held open read-write by a
// reader that never writes, a feeder that opens it write-only, and complete PNGs
// arriving on the other side. The tier-0 harness does this with ffmpeg on the reading
// end; this does it with a file descriptor, fast enough for `npm test`.
test('videofeed.sh writes complete frames into a fifo held open read-write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'videofeed-fifo-'));
  const fifo = join(dir, 'video.fifo');
  execFileSync('mkfifo', ['-m', '600', fifo]);
  // O_RDWR, exactly as ops/stream.sh's `exec 3<>` does: it does not block, and it means
  // the writer can come and go without the reader ever seeing EOF.
  const holder = openSync(fifo, 'r+');

  const child = spawn('bash', [new URL('./videofeed.sh', import.meta.url).pathname], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, VIDEO_FIFO: fifo },
  });
  child.stderr.resume();

  const chunks = [];
  // net.Socket, not fs.createReadStream: a stream backed by fs.read parks a libuv
  // threadpool thread inside a blocking read(2) on the fifo, and destroy() cannot
  // interrupt it — the test process then never exits. A Socket polls the descriptor
  // instead, and closes it on destroy.
  const reader = new Socket({ fd: holder, readable: true, writable: false });
  reader.on('data', (d) => chunks.push(d));
  await new Promise((r) => setTimeout(r, 1500));
  child.kill('SIGTERM');
  await once(child, 'close');
  reader.destroy();

  const frames = splitPngs(Buffer.concat(chunks));
  assert.ok(frames.length >= 4, `only ${frames.length} frames through the fifo in 1.5s`);
  const placeholder = readFileSync(new URL('./placeholder.png', import.meta.url));
  assert.deepEqual([...frames[0]], [...placeholder]);
  rmSync(dir, { recursive: true, force: true });
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Split a concatenated PNG stream on the signature, and drop a trailing fragment: the
// feed is killed mid-frame by design, so the last one is usually incomplete.
function splitPngs(buf) {
  const starts = [];
  for (let i = 0; i + 8 <= buf.length; i++) {
    if (buf.subarray(i, i + 8).equals(PNG_SIGNATURE)) starts.push(i);
  }
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    const frame = buf.subarray(starts[i], end);
    if (frame.subarray(frame.length - 8).toString('latin1').includes('IEND')) out.push(frame);
  }
  return out;
}

async function collectFrames({ args, ms, midRun, midRunAtMs }) {
  const child = spawn(process.execPath, [new URL('./videofeed.mjs', import.meta.url).pathname, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  child.stdout.on('data', (d) => chunks.push(d));
  child.stderr.resume();
  if (midRun) setTimeout(midRun, midRunAtMs);
  await new Promise((r) => setTimeout(r, ms));
  child.kill('SIGTERM');
  await once(child, 'close');
  return splitPngs(Buffer.concat(chunks));
}
