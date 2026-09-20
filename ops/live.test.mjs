// The pure parts of ops/live.mjs. The run itself is behind `npm run live` and needs a
// real stream key and a real uplink, so what is covered here is everything that decides
// WHERE a run points and whether the key can escape — the two things that must not be
// wrong the first time somebody runs it against YouTube.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  redact, readKey, streamEnv, assertRtmpsSupport, collectFailures,
  DESTINATIONS, YOUTUBE_RTMPS_BASE, CLOUDFLARE_RTMPS_BASE, UNAVAILABLE_LIVE, TLS_BUILD_FLAGS,
} from './live.mjs';

const REPO = resolve(new URL('.', import.meta.url).pathname, '..');
const scratch = () => mkdtempSync(join(tmpdir(), 'live-test-'));

// ---------------------------------------------------------------------------
// The key must not escape
// ---------------------------------------------------------------------------

test('redact removes every occurrence of the key, not just the first', () => {
  const key = 'abcd-1234-efgh-5678';
  const log = `connecting to rtmps://x/live2/${key}\nretry rtmps://x/live2/${key}\n`;
  const out = redact(log, key);
  assert.equal(out.includes(key), false);
  assert.equal(out.match(/REDACTED/g).length, 2);
});

test('redact is a no-op when there is no key rather than corrupting the log', () => {
  assert.equal(redact('some output', ''), 'some output');
  assert.equal(redact('some output', null), 'some output');
});

test('readKey refuses a key file inside the repository', () => {
  const dir = join(REPO, 'ops');
  const path = join(dir, '.live-test-key');
  writeFileSync(path, 'would-be-committed');
  try {
    assert.throws(() => readKey(path), /inside the repository/);
  } finally {
    try { unlinkSync(path); } catch { /* the assertion above already ran */ }
  }
});

test('readKey refuses an empty file', () => {
  const path = join(scratch(), 'key');
  writeFileSync(path, '\n  \n');
  assert.throws(() => readKey(path), /empty/);
});

test('readKey refuses a file holding more than the bare key', () => {
  const path = join(scratch(), 'key');
  // The shape somebody reaches for by habit: an env file rather than a key file.
  writeFileSync(path, 'CF_STREAM_KEY=abc123\n');
  assert.throws(() => readKey(path), /whitespace|bare/i);
});

test('readKey refuses a key file holding a full URL', () => {
  const path = join(scratch(), 'key');
  writeFileSync(path, 'rtmps://a.rtmps.youtube.com/live2/abcd-1234\n');
  assert.throws(() => readKey(path), /holds a URL/);
});

test('readKey names the path when the file is missing', () => {
  const path = join(scratch(), 'nope');
  assert.throws(() => readKey(path), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('readKey reads and trims a key held outside the repo', () => {
  const path = join(scratch(), 'key');
  writeFileSync(path, '  xxxx-yyyy-zzzz-wwww\n');
  chmodSync(path, 0o600);
  assert.equal(readKey(path), 'xxxx-yyyy-zzzz-wwww');
});

// ---------------------------------------------------------------------------
// Where a run points
// ---------------------------------------------------------------------------

test('the YouTube base is the documented RTMPS ingest on 443', () => {
  // developers.google.com/youtube/v3/live/guides/rtmps-ingestion — rtmps, port 443.
  assert.match(YOUTUBE_RTMPS_BASE, /^rtmps:\/\//);
  assert.match(YOUTUBE_RTMPS_BASE, /:443\//);
  assert.equal(DESTINATIONS.youtube, YOUTUBE_RTMPS_BASE);
});

test('the Cloudflare base matches the one stream.sh defaults to', () => {
  // stream.sh: RTMPS_BASE="${RTMPS_BASE:-rtmps://live.cloudflare.com:443/live}". If these
  // drift, a --destination cloudflare run and a production run go to different places.
  assert.equal(CLOUDFLARE_RTMPS_BASE, 'rtmps://live.cloudflare.com:443/live');
  assert.equal(DESTINATIONS.cloudflare, CLOUDFLARE_RTMPS_BASE);
});

test('streamEnv sets CF_STREAM_KEY and blanks SINK, never the reverse', () => {
  const env = streamEnv({
    fifo: '/tmp/f', secret: 'k', base: YOUTUBE_RTMPS_BASE, journalPath: '/tmp/j',
    seconds: 60, chunkCycles: 8, sampleSeconds: 10,
  });
  assert.equal(env.CF_STREAM_KEY, 'k');
  assert.equal(env.SINK, '');
  assert.equal(env.RTMPS_BASE, YOUTUBE_RTMPS_BASE);
});

test('streamEnv blanks an inherited SINK rather than leaving it set', () => {
  // A shell that ran `npm run tier0` earlier may still export SINK. stream.sh exits 64
  // on both, so inheriting one turns a live run into an immediate refusal.
  const env = streamEnv({
    fifo: '/tmp/f', secret: 'k', base: YOUTUBE_RTMPS_BASE, journalPath: '/tmp/j',
    seconds: 60, chunkCycles: 8, sampleSeconds: 10,
  });
  assert.ok('SINK' in env, 'SINK must be present and empty, so it overrides an inherited one');
  assert.equal(env.SINK, '');
});

test('streamEnv omits ANCHOR entirely when none is given', () => {
  // stream.sh tests -n "${ANCHOR:-}"; an empty string would be falsy there too, but the
  // production path passes no anchor at all and this should match it exactly.
  const env = streamEnv({
    fifo: '/tmp/f', secret: 'k', base: YOUTUBE_RTMPS_BASE, journalPath: '/tmp/j',
    seconds: 60, chunkCycles: 8, sampleSeconds: 10,
  });
  assert.equal('ANCHOR' in env, false);
  const withAnchor = streamEnv({
    fifo: '/tmp/f', secret: 'k', base: YOUTUBE_RTMPS_BASE, journalPath: '/tmp/j',
    seconds: 60, chunkCycles: 8, sampleSeconds: 10, anchor: '2026-09-20T12:00:00Z',
  });
  assert.equal(withAnchor.ANCHOR, '2026-09-20T12:00:00Z');
});

test('streamEnv passes FFMPEG only when an override is given', () => {
  // stream.sh defaults FFMPEG to `ffmpeg`; an empty value would blank that default and
  // exec nothing. Absent means "use the default", which is not the same as empty.
  const base = {
    fifo: '/tmp/f', secret: 'k', base: YOUTUBE_RTMPS_BASE, journalPath: '/tmp/j',
    seconds: 60, chunkCycles: 8, sampleSeconds: 10,
  };
  assert.equal('FFMPEG' in streamEnv(base), false);
  assert.equal(streamEnv({ ...base, ffmpegPath: '/opt/homebrew/bin/ffmpeg' }).FFMPEG, '/opt/homebrew/bin/ffmpeg');
});

test('streamEnv runs at LOGLEVEL info so ebur128 prints its summary', () => {
  // Production uses `warning`, which suppresses the Summary block entirely. See
  // ops/README.md finding 3 — without this the levels verdict has no input.
  const env = streamEnv({
    fifo: '/tmp/f', secret: 'k', base: YOUTUBE_RTMPS_BASE, journalPath: '/tmp/j',
    seconds: 60, chunkCycles: 8, sampleSeconds: 10,
  });
  assert.equal(env.LOGLEVEL, 'info');
});

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

// A stub that answers -protocols and -buildconf the way a real ffmpeg does.
const ffmpegStub = (protocols, buildconf) => {
  const stub = join(scratch(), 'ffmpeg');
  writeFileSync(stub,
    '#!/bin/sh\n'
    + 'case "$2" in\n'
    + `  -protocols) printf '%s\\n' ${protocols.map((x) => `'${x}'`).join(' ')} ;;\n`
    + `  -buildconf) printf '%s\\n' '${buildconf}' ;;\n`
    + 'esac\n');
  chmodSync(stub, 0o755);
  return stub;
};

test('assertRtmpsSupport rejects an ffmpeg with no rtmps protocol at all', () => {
  const stub = ffmpegStub(['  file', '  rtmp'], '--enable-openssl');
  assert.throws(() => assertRtmpsSupport(stub), /no rtmps protocol/);
});

// The regression that cost the first live run to YouTube, 2026-09-20. The build listed
// rtmps and tls, so the old check passed it; it had no TLS library and fell back to Apple
// Secure Transport, which connected, published, sent one socket buffer and then blocked
// with errSSLClosedAbort while YouTube reported "No data".
test('assertRtmpsSupport rejects an ffmpeg that lists rtmps but was built with no TLS library', () => {
  const stub = ffmpegStub(['  rtmp', '  rtmps', '  tls'], '--enable-gpl --enable-libx264 --enable-neon');
  assert.throws(() => assertRtmpsSupport(stub), /no TLS library/);
});

test('the rejection names the override that fixes it rather than only the problem', () => {
  const stub = ffmpegStub(['  rtmps'], '--enable-gpl');
  assert.throws(() => assertRtmpsSupport(stub), /--ffmpeg/);
});

test('assertRtmpsSupport accepts rtmps backed by a real TLS library, and says which', () => {
  for (const flag of TLS_BUILD_FLAGS) {
    const stub = ffmpegStub(['  rtmp', '  rtmps', '  tls'], `--enable-gpl ${flag}`);
    assert.deepEqual(assertRtmpsSupport(stub), { ok: true, tls: [flag] });
  }
});

test('assertRtmpsSupport reports a missing binary rather than assuming no rtmps', () => {
  assert.throws(() => assertRtmpsSupport(join(scratch(), 'absent')), /could not run/);
});

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

const clean = {
  streamCode: 0,
  records: [{ timeSeconds: 10, speed: 1 }],
  stall: { ok: true },
  drift: { ok: true },
  starvation: { ok: true },
  levels: { ok: true },
  feederKill: { ok: true, attempted: false },
  rssVerdict: { ok: true },
};

test('a clean live run collects no failures', () => {
  assert.deepEqual(collectFailures(clean), []);
});

test('a run that produced no progress records fails, however it exited', () => {
  const f = collectFailures({ ...clean, records: [] });
  assert.equal(f.length, 1);
  assert.match(f[0], /never printed a progress record/);
});

test('a deliberate feeder kill does not fail on levels it could not measure', () => {
  // The run is killed before ffmpeg prints its ebur128 Summary, so assessLevels has no
  // input. Judging that as a level failure would make the demonstration always fail —
  // the same carve-out ops/tier0.mjs makes.
  const killed = {
    ...clean,
    streamCode: 75,
    levels: { ok: false, reason: 'no ebur128 summary in the output' },
    feederKill: { ok: true, attempted: true },
  };
  assert.deepEqual(collectFailures(killed), []);
});

test('a non-zero exit is not double-reported on top of a stall', () => {
  // A stalled run is killed by the harness, so its exit code IS the kill. Reporting both
  // buries the stall under the less informative of the two.
  const stalled = {
    ...clean,
    streamCode: 137,
    stall: { ok: false, reason: 'output clock frozen at 1791s' },
  };
  const f = collectFailures(stalled);
  assert.equal(f.length, 1);
  assert.match(f[0], /frozen/);
});

test('the unavailable set names the three verdicts a live run cannot reach', () => {
  // Not a style assertion: a future reader comparing a live report against a tier-0 one
  // must be able to see that tracks, silence and skew were unreachable rather than green.
  assert.deepEqual(
    Object.keys(UNAVAILABLE_LIVE).sort(),
    ['avSkew', 'receivedLevels', 'silence', 'tracks'],
  );
  for (const why of Object.values(UNAVAILABLE_LIVE)) assert.ok(why.length > 20, 'each entry says why');
});
