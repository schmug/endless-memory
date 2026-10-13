import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// One unit, not two. The feeder was a separate unit until 2026-09-15, when replacing
// the fifo's writer under a live ffmpeg was measured to wedge it — see ops/README.md
// and ops/supervision.test.mjs. stream.sh now owns the feeder.
const STREAM = readFileSync(new URL('./endless-memory-stream.service', import.meta.url), 'utf8');

// A start limit makes systemd GIVE UP after a burst of restarts. For a 24/7 station
// permanent dead air is strictly worse than a restart loop, so the unit must keep
// trying forever; crash-looping is caught by alerting, not by refusing to restart.
// The section matters, and an earlier version of this test missed that. systemd moved
// StartLimitIntervalSec from [Service] to [Unit] in v229; systemd 252 reports it in
// [Service] as "Unknown key ... ignoring" and applies the DEFAULT limit instead — five
// restarts in ten seconds and then it gives up. The unit would have looked correct in
// every text assertion while doing the one thing the spec forbids. Caught by
// `systemd-analyze verify` in a Debian container, not by reading.
function section(text, name) {
  const lines = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (/^\[.+\]$/.test(line.trim())) { inside = line.trim() === `[${name}]`; continue; }
    if (inside) lines.push(line);
  }
  return lines.join('\n');
}

test('the unit is not allowed to give up restarting', () => {
  assert.match(section(STREAM, 'Service'), /^Restart=always$/m, 'does not restart always');
  assert.match(section(STREAM, 'Unit'), /^StartLimitIntervalSec=0$/m,
    'StartLimitIntervalSec=0 is not in [Unit], so systemd ignores it and applies the default start limit');
  assert.doesNotMatch(section(STREAM, 'Service'), /StartLimitIntervalSec/,
    'StartLimitIntervalSec is in [Service], where systemd ignores it');
});

// ffmpeg exits 0 on EOF, so without pipefail a renderer crash looks like success and
// systemd never restarts. The spec calls for it on the ExecStart line specifically.
test('the stream unit runs the pipeline under pipefail', () => {
  assert.match(STREAM, /^ExecStart=.*-o pipefail.*stream\.sh/m);
});

test('the unit runs unprivileged and confined', () => {
  assert.match(STREAM, /^User=(?!root$)\S+$/m, 'does not run as a dedicated non-root user');
  assert.match(STREAM, /^NoNewPrivileges=yes$/m);
  assert.match(STREAM, /^ProtectSystem=strict$/m);
  assert.match(STREAM, /^PrivateTmp=yes$/m);
});

// The fifo lives under /run, which systemd must create for the unit.
test('the unit creates the runtime directory the fifo lives in', () => {
  assert.match(STREAM, /^RuntimeDirectory=endless-memory$/m);
});

// Unit files are world-readable. The key is loaded via EnvironmentFile and the RTMPS
// URL is assembled inside stream.sh, so neither the unit nor journald carries a value.
test('the stream key reaches the unit through an EnvironmentFile and never as a literal', () => {
  assert.match(STREAM, /^EnvironmentFile=\/etc\/endless-memory\/stream\.env$/m);
  assert.doesNotMatch(STREAM, /^Environment=.*CF_STREAM_KEY=\S/m);
  assert.doesNotMatch(STREAM, /rtmps:\/\/\S*\/[A-Za-z0-9]{16,}/);
});

// Piece D on the air (2026-10-12). Its own unit, never part of the stream's: videofeed
// reads the PNG it writes and owns every fallback, so this process can crash, restart or
// be stopped without the broadcast noticing. The two units share one fact, the path.
const FRAMES = readFileSync(new URL('./endless-memory-videoframe.service', import.meta.url), 'utf8');

test('the stream reads the PNG piece D writes, from piece D\'s state directory', () => {
  const source = STREAM.match(/^Environment=FRAME_SOURCE=(\S+)$/m)?.[1];
  assert.ok(source, 'the stream unit sets no FRAME_SOURCE, so videofeed never reads piece D');
  const out = FRAMES.match(/^ExecStart=.*--out (\S+)/m)?.[1];
  assert.equal(out, source, 'piece D writes somewhere other than where the stream reads');
  const state = FRAMES.match(/^StateDirectory=(\S+)$/m)?.[1];
  assert.ok(state && source.startsWith(`/var/lib/${state}/`), 'the frame is not in the unit\'s StateDirectory');
  // The stream unit has PrivateTmp, so a frame under /tmp would be invisible to it.
  assert.doesNotMatch(source, /^\/tmp\//);
});

// The polling contract is one request a minute. Restarting re-polls at once, so a crash
// loop faster than that would break it from outside the code that keeps it.
test('piece D restarts forever, but never faster than the camera\'s cadence', () => {
  assert.match(section(FRAMES, 'Service'), /^Restart=always$/m);
  assert.match(section(FRAMES, 'Unit'), /^StartLimitIntervalSec=0$/m);
  const restartSec = Number(section(FRAMES, 'Service').match(/^RestartSec=(\d+)$/m)?.[1]);
  assert.ok(restartSec >= 60, `RestartSec=${restartSec} re-polls the camera inside the minute`);
});

test('piece D runs unprivileged, confined, and below the renderer', () => {
  assert.match(FRAMES, /^User=(?!root$)\S+$/m);
  assert.match(FRAMES, /^NoNewPrivileges=yes$/m);
  assert.match(FRAMES, /^ProtectSystem=strict$/m);
  assert.match(FRAMES, /^PrivateTmp=yes$/m);
  assert.match(FRAMES, /^Nice=19$/m, 'the renderer must always win the CPU');
  // /usr/bin/node is v12 on the production host.
  assert.match(FRAMES, /^ExecStart=\/usr\/local\/bin\/node \S+\/ops\/videoframe\.mjs run /m);
});

test('neither unit binds its lifetime to the other', () => {
  for (const [unit, other] of [[STREAM, 'videoframe'], [FRAMES, 'stream']]) {
    assert.doesNotMatch(unit, new RegExp(`^(Requires|BindsTo|PartOf|Requisite)=.*endless-memory-${other}`, 'm'));
  }
});
