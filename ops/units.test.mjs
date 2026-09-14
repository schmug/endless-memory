import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const unit = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const STREAM = unit('endless-memory-stream.service');
const VIDEOFEED = unit('endless-memory-videofeed.service');

// A start limit makes systemd GIVE UP after a burst of restarts. For a 24/7 station
// permanent dead air is strictly worse than a restart loop, so the unit must keep
// trying forever; crash-looping is caught by alerting, not by refusing to restart.
test('neither unit is allowed to give up restarting', () => {
  for (const [name, text] of [['stream', STREAM], ['videofeed', VIDEOFEED]]) {
    assert.match(text, /^Restart=always$/m, `${name} does not restart always`);
    assert.match(text, /^StartLimitIntervalSec=0$/m, `${name} has a start limit and would give up`);
  }
});

// ffmpeg exits 0 on EOF, so without pipefail a renderer crash looks like success and
// systemd never restarts. The spec calls for it on the ExecStart line specifically.
test('the stream unit runs the pipeline under pipefail', () => {
  assert.match(STREAM, /^ExecStart=.*-o pipefail.*stream\.sh/m);
});

// videofeed is a SEPARATE unit, and that separation is the whole decoupling from piece
// D. An ordering or binding dependency on the stream unit would put the frame writer
// back in the broadcast path — the exact coupling the fifo holder fd exists to prevent.
test('the videofeed unit is independent of the stream unit', () => {
  assert.doesNotMatch(VIDEOFEED, /^(BindsTo|Requires|PartOf|Requisite)=.*endless-memory-stream/m);
  assert.match(VIDEOFEED, /videofeed\.sh/);
});

test('both units run unprivileged and confined', () => {
  for (const [name, text] of [['stream', STREAM], ['videofeed', VIDEOFEED]]) {
    assert.match(text, /^User=(?!root$)\S+$/m, `${name} does not run as a dedicated non-root user`);
    assert.match(text, /^NoNewPrivileges=yes$/m, name);
    assert.match(text, /^ProtectSystem=strict$/m, name);
    assert.match(text, /^PrivateTmp=yes$/m, name);
  }
});

// The fifo lives under /run, which systemd must create and both units must share.
test('both units share the runtime directory the fifo lives in', () => {
  for (const text of [STREAM, VIDEOFEED]) {
    assert.match(text, /^RuntimeDirectory=endless-memory$/m);
    assert.match(text, /^RuntimeDirectoryPreserve=yes$/m);
  }
});

// Unit files are world-readable. The key is loaded via EnvironmentFile and the RTMPS
// URL is assembled inside stream.sh, so neither the unit nor journald carries a value.
test('the stream key reaches the unit through an EnvironmentFile and never as a literal', () => {
  assert.match(STREAM, /^EnvironmentFile=\/etc\/endless-memory\/stream\.env$/m);
  assert.doesNotMatch(STREAM, /^Environment=.*CF_STREAM_KEY=\S/m);
  assert.doesNotMatch(STREAM, /rtmps:\/\/\S*\/[A-Za-z0-9]{16,}/);
});
