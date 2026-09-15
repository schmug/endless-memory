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
