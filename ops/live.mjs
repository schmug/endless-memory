// A live run: the complete broadcast pipeline against a NETWORK destination.
//
// ops/tier0.mjs is the same pipeline against a local sink, and it stays that way — it
// sets SINK and never CF_STREAM_KEY, so it has no code path to a network at all. This
// file is the other half: it sets CF_STREAM_KEY and never SINK. stream.sh refuses both
// at once, so the two runners cannot be confused for each other at runtime.
//
// What this covers that tier 0 cannot: RTMPS auth, a real uplink, and whether the
// encoder holds 1x when a socket rather than a file is absorbing its output.
//
// What it CANNOT cover, and does not pretend to: there is no output file, so the three
// tier-0 verdicts that probe one — track layout, silencedetect, and A/V skew from packet
// timestamps — have no input here. They are reported as unavailable rather than skipped
// quietly, because a report that lists nine verdicts and silently judges six is worse
// than one that says which three it could not reach. Loudness on the RECEIVED stream
// (spec criterion 8) is likewise not measurable from this side; what `levels` reports is
// the source measurement off the in-graph ebur128, the same figure tier 0 reports.
//
// Long-running, so it lives behind `npm run live` and outside `npm test`, following the
// tier0/endurance/realtime precedent. The pure verdicts it uses all live in
// ops/measure.mjs and are covered there.
//
// THE KEY IS NEVER AN ARGUMENT. It is read from a file whose path is the argument, put
// into the child's environment, and scrubbed from everything this file writes down. The
// assembled RTMPS URL is built inside stream.sh, so it never reaches this process at all.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, createWriteStream, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  driftTolerance, assessDrift, DEFAULT_JOURNAL, logSchedule,
} from '../runtime/realtime.mjs';
import { analyse } from '../runtime/endurance.mjs';
import {
  parseEbur128Summary, assessLevels, parseProgressRecords, intervalSpeeds,
  assessStarvation, startupOffsetSeconds, detectStall, assessStall, STALL_SECONDS,
  assessFfmpegRss,
} from './measure.mjs';
import { descendants, killTree, assessFeederKill } from './tier0.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const MB = 1024 * 1024;

// YouTube's documented primary RTMPS ingest, port 443 with SNI
// (developers.google.com/youtube/v3/live/guides/rtmps-ingestion, read 2026-09-20).
// Google's guidance is that encoders fetch this from the Live Streaming API rather than
// hardcode it, so treat this as a default to confirm against what YouTube Studio shows
// on the stream's own page, not as a constant.
export const YOUTUBE_RTMPS_BASE = 'rtmps://a.rtmps.youtube.com:443/live2';

// Cloudflare's live input, the destination the spec adopts. Kept here so choosing
// between the two is a named argument rather than a URL typed at the shell.
export const CLOUDFLARE_RTMPS_BASE = 'rtmps://live.cloudflare.com:443/live';

export const DESTINATIONS = {
  youtube: YOUTUBE_RTMPS_BASE,
  cloudflare: CLOUDFLARE_RTMPS_BASE,
};

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

// Criterion 10 is "no secret in the repository, the unit files, or the logs", and the
// spec adds: "verified by grepping the tree and the journald output for both key
// prefixes, not by having been careful". Being careful is what this function replaces.
export function redact(text, secret) {
  if (!secret) return text;
  return String(text).split(secret).join('REDACTED');
}

export function readKey(keyFile, { repoRoot = resolve(HERE, '..') } = {}) {
  const path = resolve(keyFile.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
  // The gitignore calls itself "a backstop, not the reason". This is the reason: a key
  // inside the worktree is one `git add -A` from being published, and this repo is
  // public. Refuse rather than rely on a pattern match in .gitignore.
  let real;
  try { real = realpathSync(path); } catch { throw new Error(`live: no key file at ${path}`); }
  if (real.startsWith(realpathSync(repoRoot) + '/')) {
    throw new Error(`live: the key file is inside the repository (${real}) — put it somewhere outside the worktree, mode 0600`);
  }
  const key = readFileSync(real, 'utf8').trim();
  if (!key) throw new Error(`live: the key file ${real} is empty`);
  if (/\s/.test(key)) throw new Error('live: the key file contains whitespace — it should hold the stream key and nothing else');
  // The habit this catches: writing an env file rather than a key file. `CF_STREAM_KEY=abc`
  // trims clean and has no internal whitespace, so the check above passes it, and
  // stream.sh then builds `.../live2/CF_STREAM_KEY=abc` — a connect failure whose cause is
  // not obvious from the log. Matched narrowly (a shell NAME= prefix) so a key that merely
  // ends in base64 padding is still accepted.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(key)) {
    throw new Error('live: the key file looks like an env assignment (NAME=value) — it should hold the bare key, with no variable name');
  }
  if (key.includes('://')) {
    throw new Error('live: the key file holds a URL — it should hold only the key; the destination is chosen with --destination or --rtmps-base');
  }
  return key;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

// A TLS library ffmpeg was actually built against. Apple's Secure Transport is the
// implicit fallback on macOS and is NOT in this list on purpose — see below.
export const TLS_BUILD_FLAGS = ['--enable-openssl', '--enable-gnutls', '--enable-mbedtls', '--enable-libtls'];

// Measured 2026-09-20, and the reason this check is no longer about `-protocols`.
//
// The first live run to YouTube used an ffmpeg whose `-protocols` listed `rtmps` and
// `tls`, so the old version of this function passed it. The run then connected, completed
// an RTMP publish, pushed 31 KiB, and blocked forever; YouTube's Stream health said "No
// data" throughout, and the connection died with `[tls] IO Error: -9806` —
// errSSLClosedAbort, an **Apple Secure Transport** code. That build's `-buildconf` has no
// TLS library in it at all: ffmpeg fell back to Secure Transport, which Apple deprecated
// and which does not carry this session.
//
// So `rtmps` appearing in `-protocols` is true and meaningless — it was the false
// reassurance that let the run start. What predicts a working RTMPS session is a real TLS
// library in the build configuration.
export function assertRtmpsSupport(ffmpeg = 'ffmpeg') {
  let protocols = '';
  try {
    protocols = execFileSync(ffmpeg, ['-hide_banner', '-protocols'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    throw new Error(`live: could not run ${ffmpeg} -protocols: ${e.message}`);
  }
  if (!/^\s*rtmps\s*$/m.test(protocols)) {
    throw new Error('live: this ffmpeg has no rtmps protocol — an rtmps:// destination will fail at connect');
  }
  let buildconf = '';
  try {
    buildconf = execFileSync(ffmpeg, ['-hide_banner', '-buildconf'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    throw new Error(`live: could not run ${ffmpeg} -buildconf: ${e.message}`);
  }
  const found = TLS_BUILD_FLAGS.filter((f) => buildconf.includes(f));
  if (!found.length) {
    throw new Error(
      `live: ${ffmpeg} lists rtmps but was built with no TLS library (${TLS_BUILD_FLAGS.join(', ')} all absent), `
      + 'so it falls back to Apple Secure Transport. Measured 2026-09-20: that combination connects, publishes, '
      + 'sends about one socket buffer and then blocks with errSSLClosedAbort while the destination reports no data. '
      + 'Pass --ffmpeg /path/to/an/openssl-built/ffmpeg, or use plain rtmp:// to a destination that accepts it.',
    );
  }
  return { ok: true, tls: found };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

// Named so a reader of the report knows these were not merely omitted. Each says what
// would have to change for the measurement to become available.
export const UNAVAILABLE_LIVE = {
  tracks: 'no output file to probe — the track layout is fixed by the same stream.sh argv tier 0 already gates',
  silence: 'silencedetect needs a file; a live run has no artifact unless one is recorded alongside',
  avSkew: 'skew is read from packet timestamps in a container, and there is no container on this side of the socket',
  receivedLevels: 'spec criterion 8 wants loudness on the RECEIVED stream, which has to be measured off the destination, not here',
};

export function collectFailures(r) {
  const failures = [];
  if (r.streamCode !== 0 && r.stall?.ok !== false && !r.feederKill?.attempted) {
    failures.push(`stream.sh exited ${r.streamCode}`);
  }
  if (!r.records.length) failures.push('ffmpeg never printed a progress record — nothing reached the destination');
  // A run killed on purpose cannot produce an end-of-run measurement: ffmpeg never
  // prints its ebur128 Summary. Same carve-out tier 0 makes, same reason.
  const endOfRunOnly = r.feederKill?.attempted ? ['levels'] : [];
  for (const key of ['stall', 'drift', 'starvation', 'levels', 'feederKill', 'rssVerdict']) {
    if (endOfRunOnly.includes(key)) continue;
    const v = r[key];
    if (v && !v.ok) failures.push(v.reason);
  }
  return failures;
}

// ---------------------------------------------------------------------------
// The child's environment
// ---------------------------------------------------------------------------

// Pulled out of live() so the destination invariant is a test rather than a comment.
// stream.sh refuses SINK and CF_STREAM_KEY together and exits 64, so getting this wrong
// fails loudly — but it fails after the fifo is made and the key is read, and the one
// thing worth knowing before any of that is which destination this run is aimed at.
export function streamEnv({ fifo, secret, base, journalPath, seconds, chunkCycles, sampleSeconds, anchor = null, ffmpegPath = null }) {
  const env = {
    VIDEO_FIFO: fifo,
    CF_STREAM_KEY: secret,
    RTMPS_BASE: base,
    // Explicitly empty, not absent: a SINK inherited from the caller's shell would make
    // stream.sh refuse the run, and inheriting one silently from a previous tier-0
    // session is exactly the shape of accident this guards.
    SINK: '',
    JOURNAL: journalPath,
    SECONDS_LIMIT: String(seconds),
    CHUNK_CYCLES: String(chunkCycles),
    // ebur128 prints its summary at AV_LOG_INFO; production's `warning` suppresses it.
    // Same deviation tier 0 makes, same reason — see ops/README.md.
    LOGLEVEL: 'info',
    STATS_PERIOD: String(sampleSeconds),
  };
  // Omitted rather than empty when absent: stream.sh tests -n on it, and production
  // passes no anchor so the renderer reads the wall clock.
  if (anchor) env.ANCHOR = anchor;
  // Same rule: stream.sh defaults FFMPEG to `ffmpeg`, so an empty value would blank it.
  if (ffmpegPath) env.FFMPEG = ffmpegPath;
  return env;
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

export async function live({
  seconds = 1500,
  keyFile,
  key = null,
  destination = 'youtube',
  rtmpsBase = null,
  // stream.sh honours FFMPEG; this is how a live run reaches a TLS-capable binary when
  // the one first on PATH is not. Recorded in the report, because which encoder produced
  // the broadcast is part of what the run measured.
  ffmpegPath = null,
  // null means the renderer reads the wall clock, which is what production does and what
  // makes a restart resume at the correct musical moment. A fixed anchor is for
  // reproducing a specific stretch of music, not for a realistic run.
  anchor = null,
  journal = DEFAULT_JOURNAL,
  chunkCycles = 8,
  killFeederAt = null,
  sampleSeconds = 10,
  stallSeconds = STALL_SECONDS,
  logDir = null,
  onSample = () => {},
} = {}) {
  const secret = key ?? readKey(keyFile);
  const base = rtmpsBase ?? DESTINATIONS[destination];
  if (!base) throw new Error(`live: unknown destination '${destination}' — one of ${Object.keys(DESTINATIONS).join(', ')}, or pass rtmpsBase`);
  const tls = assertRtmpsSupport(ffmpegPath || 'ffmpeg');

  const dir = logDir || mkdtempSync(join(tmpdir(), 'live-'));
  // /run/endless-memory does not exist on macOS, and the production default points
  // there. A live run from a laptop needs its own fifo; the production host uses the
  // unit's RuntimeDirectory.
  const fifo = join(dir, 'video.fifo');
  execFileSync('mkfifo', ['-m', '600', fifo]);
  const journalPath = join(dir, 'journal.json');
  writeFileSync(journalPath, JSON.stringify(journal));

  const env = { ...process.env, ...streamEnv({ fifo, secret, base, journalPath, seconds, chunkCycles, sampleSeconds, anchor, ffmpegPath }) };

  const stream = spawn('bash', [join(HERE, 'stream.sh')], { stdio: ['ignore', 'ignore', 'pipe'], env });

  const started = Date.now();
  let stderr = '';
  const stderrPath = join(dir, 'ffmpeg.log');
  const stderrFile = createWriteStream(stderrPath);
  // Scrubbed on the way in, so the key is never on disk even for the instant between
  // write and a later sweep. ffmpeg echoes its output URL on error, which is exactly
  // when a log gets pasted somewhere.
  stream.stderr.on('data', (d) => {
    const clean = redact(d.toString(), secret);
    stderr += clean;
    stderrFile.write(clean);
  });

  let feederKilledAt = null;
  let feederExitedAt = null;
  let stall = null;
  const samples = [];
  let lastRecord = null;

  const timer = setInterval(() => {
    const kids = descendants(stream.pid);
    const ffmpeg = kids.find((p) => p.comm.includes('ffmpeg'));
    const records = parseProgressRecords(stderr);
    lastRecord = records[records.length - 1] || lastRecord;
    if (ffmpeg) {
      const sample = { hours: (Date.now() - started) / 3600000, rss: ffmpeg.rssBytes, heapUsed: 0 };
      samples.push(sample);
      onSample(sample, lastRecord);
    }
    // The wedge: every process alive, every thread parked, the output clock frozen. It
    // is the one failure a liveness check cannot see, and on a live run it is dead air
    // going out over a real connection.
    const check = detectStall(records, { stallSeconds });
    if (check.stalled && !stall) {
      stall = check;
      process.stderr.write(`  [${((Date.now() - started) / 60000).toFixed(1)} min] STALLED: output clock frozen at ${check.frozenAtSeconds}s for ${check.stalledForSeconds.toFixed(0)}s — ending the run\n`);
      killTree(stream.pid);
    }
  }, sampleSeconds * 1000);

  let killTimer = null;
  if (killFeederAt !== null) {
    killTimer = setTimeout(() => {
      const feeder = descendants(stream.pid).filter((p) => p.comm.includes('node'));
      const target = feeder.find((p) => p.pid !== stream.pid);
      feederKilledAt = (Date.now() - started) / 1000;
      process.stderr.write(`  [${feederKilledAt.toFixed(0)}s] killing the video feeder — the pipeline should end, not survive\n`);
      for (const p of descendants(stream.pid)) {
        if (p.comm.includes('node') && p.pid !== target?.pid) continue;
        try { process.kill(p.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }, killFeederAt * 1000);
  }

  const [streamCode] = await once(stream, 'close');
  clearInterval(timer);
  if (killTimer) clearTimeout(killTimer);
  const wallSeconds = (Date.now() - started) / 1000;
  if (feederKilledAt !== null) feederExitedAt = wallSeconds;

  const records = parseProgressRecords(stderr);
  const producedSeconds = records.length ? records[records.length - 1].timeSeconds : 0;
  const intervals = intervalSpeeds(records);
  const tolerance = driftTolerance({ chunkCycles, pipeBytes: 64 * 1024 });
  const analysis = analyse(samples, { totalHours: Math.max(wallSeconds / 3600, 1e-9) });

  const result = {
    seconds, anchor, chunkCycles, destination, rtmpsBase: base, wallSeconds, producedSeconds,
    ffmpegPath: ffmpegPath || 'ffmpeg', tls,
    stderrPath, dir, tolerance, records, intervals, samples, analysis, streamCode,
    startupOffsetSeconds: startupOffsetSeconds(records),
    renderReport: stderr.split('\n').filter((l) => l.startsWith('render:')).pop() || '',
    feederKilledAt, feederExitedAt,
    unavailable: UNAVAILABLE_LIVE,
    drift: assessDrift({ producedSeconds, elapsedSeconds: wallSeconds, tolerance }),
    starvation: assessStarvation(intervals, {
      skipSeconds: 2 * sampleSeconds,
      excludeWindows: feederKilledAt === null ? [] : [[feederKilledAt, Infinity]],
    }),
    levels: assessLevels(parseEbur128Summary(stderr)),
    feederKill: assessFeederKill({ killedAtSeconds: feederKilledAt, exitedAtSeconds: feederExitedAt }),
    stall: assessStall(stall ?? detectStall(records, { stallSeconds })),
    rssVerdict: assessFfmpegRss({ slopeBytesPerHour: analysis.rssSlopeBytesPerHour, wallSeconds }),
  };
  // Criterion 10, mechanically: the key must not appear in anything this run produced.
  result.keyLeaked = stderr.includes(secret);
  if (result.keyLeaked) result.leakReason = 'the stream key appears in captured ffmpeg output — redaction failed, treat the key as compromised and rotate it';
  result.failures = collectFailures(result);
  if (result.keyLeaked) result.failures.push(result.leakReason);
  result.passed = result.failures.length === 0;
  return result;
}

const fmtMb = (b) => `${(b / MB).toFixed(1)} MB`;

export function formatLiveReport(r) {
  const lines = [];
  lines.push(`live: ${(r.seconds / 60).toFixed(0)} min target, ${r.destination} (${r.rtmpsBase}/REDACTED), anchor ${r.anchor || 'wall clock'}, chunk ${r.chunkCycles} cycles`);
  lines.push(`  produced ${(r.producedSeconds / 60).toFixed(1)} min of audio in ${(r.wallSeconds / 60).toFixed(1)} min wall`);
  lines.push(`  drift: ${r.drift.aheadSeconds >= 0 ? '+' : ''}${r.drift.aheadSeconds.toFixed(2)}s vs realtime, bound ±${r.tolerance.toFixed(2)}s — ${r.drift.reason}`);
  lines.push(`  startup offset: ${r.startupOffsetSeconds.toFixed(2)}s — one-time, which is why cumulative speed= is not the starvation signal`);
  lines.push(`  pacing: ${r.starvation.reason}`);
  lines.push(`  levels (source, not received): ${r.levels.reason}`);
  lines.push(`  video feeder: ${r.feederKill.reason}`);
  lines.push(`  stall: ${r.stall.reason}`);
  lines.push(`  encoder: ${r.ffmpegPath}, TLS via ${r.tls?.tls?.join(', ') || 'unknown'}`);
  lines.push(`  key in output: ${r.keyLeaked ? 'LEAKED' : 'absent'}`);
  lines.push(`  ffmpeg log: ${r.stderrPath}`);
  if (r.renderReport) lines.push(`  ${r.renderReport}`);
  lines.push('  not measurable from this side:');
  for (const [k, why] of Object.entries(r.unavailable)) lines.push(`    ${k}: ${why}`);
  // A run that died before ffmpeg started has no samples, and analyse() still returns
  // empty phases whose medians are NaN. A table of NaN is noise on top of the real
  // failure, which the FAIL lines below already name.
  if (r.samples.length) {
    lines.push('  phase  span (h)        samples   median RSS    min RSS     max RSS   (ffmpeg)');
    for (const p of r.analysis.phases) {
      const warm = p.index < r.analysis.warmupPhases ? ' (warm-up)' : '';
      lines.push(
        `  ${String(p.index + 1).padStart(5)}  ${p.fromHours.toFixed(2).padStart(5)}–${p.toHours.toFixed(2).padEnd(5)} ` +
        `${String(p.samples).padStart(9)}  ${fmtMb(p.medianRss).padStart(11)} ${fmtMb(p.minRss).padStart(10)} ${fmtMb(p.maxRss).padStart(11)}${warm}`,
      );
    }
  }
  lines.push(`  ffmpeg RSS verdict: ${r.rssVerdict.reason}`);
  for (const f of r.failures) lines.push(`  FAIL: ${f}`);
  lines.push(`  verdict: ${r.passed ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
  };
  const keyFile = arg('key-file');
  if (!keyFile) {
    process.stderr.write(
      'usage: node ops/live.mjs --key-file <path> [--minutes 25] [--destination youtube|cloudflare]\n' +
      '                        [--rtmps-base <url>] [--ffmpeg <path>] [--anchor <ISO>]\n' +
      '                        [--kill-feeder-at <s>] [--log-every <s>]\n\n' +
      'The key is read from the file, never passed as an argument: an argv is visible to\n' +
      'every local user through ps. The file must live outside this repository.\n',
    );
    process.exit(64);
  }
  const minutes = Number(arg('minutes', 25));
  const logDue = logSchedule(Number(arg('log-every', 30)));
  const result = await live({
    seconds: Math.round(minutes * 60),
    keyFile,
    destination: arg('destination', 'youtube'),
    rtmpsBase: arg('rtmps-base', null),
    ffmpegPath: arg('ffmpeg', null),
    anchor: arg('anchor', null),
    chunkCycles: Number(arg('chunk-cycles', 8)),
    killFeederAt: arg('kill-feeder-at') ? Number(arg('kill-feeder-at')) : null,
    onSample: (s, p) => {
      if (!logDue(s.hours * 3600)) return;
      process.stderr.write(`  [${(s.hours * 60).toFixed(1)} min] ffmpeg rss ${fmtMb(s.rss)}, at ${p ? p.timeSeconds.toFixed(0) : '?'}s, cumulative speed ${p ? p.speed.toFixed(2) : '?'}x\n`);
    },
  });
  console.log(formatLiveReport(result));
  process.exitCode = result.passed ? 0 : 1;
}
