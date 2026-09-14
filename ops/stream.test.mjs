import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { SR } from '../runtime/voices.mjs';
import { FORBIDDEN_FILTERS } from './measure.mjs';

const SCRIPT = new URL('./stream.sh', import.meta.url).pathname;
const SOURCE = readFileSync(SCRIPT, 'utf8');

// stream.sh prints the argv it would exec and exits, so these assertions run against
// the command that actually reaches ffmpeg rather than against the script's text. A
// grep over the source cannot tell a flag from a comment mentioning one.
function argv(env = {}) {
  const out = execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, DRY_RUN: '1', SINK: '/tmp/tier0.flv', ...env },
  });
  return out.trim().split('\n');
}

const indexOfRun = (args, run) => args.findIndex((_, i) => run.every((v, j) => args[i + j] === v));

// These three flags are a restatement of the renderer's output format, not a tuning
// choice: runtime/voices.mjs's SR, and toPcm's dual-mono 16-bit LE. Getting one wrong
// produces audio that plays at the wrong speed while passing every structural check,
// so SR is imported rather than typed out again.
test('the audio input flags restate the renderer output format exactly', () => {
  const args = argv();

  assert.ok(indexOfRun(args, ['-f', 's16le', '-ar', String(SR), '-ac', '2', '-i', '-']) > 0,
    `no s16le/${SR}/2 input in: ${args.join(' ')}`);
});

// -re on BOTH inputs. The audio side is the mechanism the realtime proof exercised;
// the video side stops an unpaced infinite source racing ahead into ffmpeg's buffers,
// which on a 24/7 run is a slow leak.
test('both inputs are paced with -re', () => {
  const args = argv();
  const inputs = args.map((a, i) => (a === '-i' ? i : -1)).filter((i) => i >= 0);

  assert.equal(inputs.length, 2, 'expected exactly two inputs');
  for (const i of inputs) {
    const before = args.slice(0, i);
    assert.ok(before.lastIndexOf('-re') > before.lastIndexOf('-i'), `input at ${i} is not preceded by -re`);
  }
});

test('the video input reads the fifo at the declared framerate', () => {
  const args = argv({ VIDEO_FIFO: '/run/endless-memory/video.fifo' });

  assert.ok(indexOfRun(args, ['-f', 'image2pipe', '-framerate', '2', '-i', '/run/endless-memory/video.fifo']) > 0,
    `no image2pipe input in: ${args.join(' ')}`);
});

// ebur128 MEASURES; it must not be in the branch that reaches the encoder. The mapped
// output comes off asplit's other leg, so the audio that goes out is a bit-exact copy.
test('the ebur128 branch ends in anullsink and never reaches the encoder', () => {
  const args = argv();
  const graph = args[args.indexOf('-filter_complex') + 1];

  assert.match(graph, /\[1:a\]asplit=2\[aout\]\[ameter\]/);
  assert.match(graph, /\[ameter\]ebur128=[^;]*\[m\];\s*\[m\]anullsink/);
  assert.ok(indexOfRun(args, ['-map', '[aout]']) > 0, 'the encoder is not fed from asplit\'s clean leg');
  assert.ok(!/\[ameter\][^;]*\[aout\]/.test(graph), 'the measured leg feeds the output');
});

// Named permanently forbidden by the spec: every one of them alters samples, and the
// sound is listener-approved. If one ever becomes necessary it is a sound change with
// a listening pass, governed by the same rule as `npm run fixtures`.
test('no sample-altering filter appears anywhere in the invocation', () => {
  const args = argv().join(' ');

  for (const filter of FORBIDDEN_FILTERS) {
    assert.ok(!args.includes(filter), `${filter} is in the live path`);
  }
});

// The argv check above only sees the branch this environment took. A forbidden filter
// added behind a condition would sit dormant in the script until production hit it, so
// the source is checked too — outside its comments, which name all five deliberately.
test('no sample-altering filter is dormant in a branch the dry run did not take', () => {
  const code = SOURCE.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

  for (const filter of FORBIDDEN_FILTERS) {
    assert.ok(!code.includes(filter), `${filter} is in stream.sh outside a comment`);
  }
});

// Observed 2026-09-14: with an infinite video input and no -shortest, killing the
// renderer left ffmpeg encoding silent video indefinitely — the pipeline never exited,
// so `Restart=always` never fired and the unit stayed green over permanent dead air.
// With -shortest the same kill ended the pipeline in 2s. See ops/README.md.
test('-shortest is present, so the renderer dying ends the pipeline instead of leaving silent video on air', () => {
  assert.ok(argv().includes('-shortest'));
});

test('the GOP is fixed and closed at two seconds, as YouTube requires', () => {
  const args = argv();

  assert.ok(indexOfRun(args, ['-g', '60']) > 0);
  assert.ok(indexOfRun(args, ['-keyint_min', '60']) > 0);
  assert.ok(indexOfRun(args, ['-sc_threshold', '0']) > 0);
});

test('a local SINK replaces the RTMPS destination entirely, so tier 0 cannot reach the network', () => {
  const args = argv({ SINK: '/tmp/tier0.flv' });

  assert.equal(args[args.length - 1], '/tmp/tier0.flv');
  assert.ok(!args.some((a) => a.startsWith('rtmp')), 'an rtmp destination survived alongside SINK');
});

test('setting both a stream key and a local sink is refused rather than silently preferring one', () => {
  assert.throws(() => argv({ CF_STREAM_KEY: 'k', SINK: '/tmp/x.flv' }), /status 64|Command failed/);
});

// The key never enters the repo, the unit file, or the logs. A dry run is something an
// operator pastes into a terminal or a ticket, so it must not be the thing that leaks.
test('a dry run redacts the stream key rather than printing the assembled URL', () => {
  const key = 'zzzz-not-a-real-key-zzzz';
  const args = argv({ CF_STREAM_KEY: key, SINK: '' }).join(' ');

  assert.ok(!args.includes(key), 'the dry run printed the stream key');
  assert.match(args, /rtmps:\/\//, 'the dry run should still show the destination shape');
});

test('no secret literal is committed in the script itself', () => {
  assert.ok(!/rtmps:\/\/\S*\/[A-Za-z0-9]{16,}/.test(SOURCE), 'a key-shaped literal is in stream.sh');
  assert.match(SOURCE, /\$\{?CF_STREAM_KEY/, 'the key should come from the environment');
});

// A fifo returns EOF to its reader when the last writer closes. Holding it open
// read-write on a spare descriptor means videofeed can start, crash and be replaced
// without ffmpeg ever seeing the end of the stream. Without this, restarting the video
// feeder ends the broadcast. It is not visible in argv, so it is asserted in the text.
test('the fifo is held open read-write on a spare descriptor', () => {
  assert.match(SOURCE, /exec 3<>/, 'stream.sh does not hold the fifo open');
});

// ffmpeg exits 0 on EOF, so without pipefail a renderer crash would look like success.
test('the pipeline fails when the renderer fails, not only when ffmpeg does', () => {
  assert.match(SOURCE, /set -[a-z]*e[a-z]*o pipefail|set -o pipefail/);
});
