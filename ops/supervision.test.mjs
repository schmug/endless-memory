import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';

// The supervision shape, tested against the real ops/stream.sh with the two heavy
// binaries stubbed. Measured 2026-09-15: replacing the process that writes the video
// fifo wedges ffmpeg into dead air that no liveness check can see, whatever the flags.
// The rule that follows is that the fifo's writer is never replaced under a live
// ffmpeg — so stream.sh owns the feeder, and the two die together.
//
// The equivalent check against real ffmpeg lives in `npm run tier0`; this one runs in
// seconds so it can sit in `npm test` and catch the coupling being removed.
const SCRIPT = new URL('./stream.sh', import.meta.url).pathname;

function stubEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'supervision-'));
  const fifo = join(dir, 'video.fifo');
  execFileSync('mkfifo', ['-m', '600', fifo]);
  // Stands in for ffmpeg: drains stdin and the fifo forever, so nothing else can be
  // what ends the run.
  const ffmpeg = join(dir, 'ffmpeg');
  writeFileSync(ffmpeg, '#!/usr/bin/env bash\ncat > /dev/null &\nwhile :; do sleep 1; done\n');
  chmodSync(ffmpeg, 0o755);
  // Stands in for the renderer: produces bytes forever.
  const render = join(dir, 'render.mjs');
  writeFileSync(render, 'const b = Buffer.alloc(65536);\nsetInterval(() => process.stdout.write(b), 50);\n');
  return { dir, fifo, ffmpeg, render };
}

const running = [];
after(() => { for (const s of running) reap(s); });

function reap(stream) {
  for (const c of children(stream.pid)) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } }
  try { process.kill(stream.pid, 'SIGKILL'); } catch { /* gone */ }
}

function startStream({ dir, fifo, ffmpeg, render }) {
  const child = spawn('bash', [SCRIPT], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      VIDEO_FIFO: fifo, SINK: join(dir, 'out.flv'), CF_STREAM_KEY: '',
      FFMPEG: ffmpeg, RENDER: render, ANCHOR: '2026-09-11T12:00:00Z',
    },
  });
  child.stderr.resume();
  running.push(child);
  return child;
}

const children = (root) => {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const all = rows.split('\n').map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); return m ? { pid: +m[1], ppid: +m[2], cmd: m[3] } : null; }).filter(Boolean);
  const out = []; const q = [root];
  while (q.length) { const p = q.pop(); for (const c of all) if (c.ppid === p) { out.push(c); q.push(c.pid); } }
  return out;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The feeder is a child of the pipeline, not a unit of its own. If it were separately
// supervised, systemd would replace it under a live ffmpeg, which is the wedge.
test('stream.sh starts the video feeder itself', async () => {
  const env = stubEnv();
  const stream = startStream(env);
  await sleep(3000);
  const feeder = children(stream.pid).find((c) => c.cmd.includes('videofeed'));

  try {
    assert.ok(feeder, `no videofeed among stream.sh's children: ${children(stream.pid).map((c) => c.cmd).join(' | ')}`);
  } finally {
    reap(stream);
    rmSync(env.dir, { recursive: true, force: true });
  }
});

// The property the whole change exists for. A dead feeder must end the pipeline
// promptly, so systemd restarts renderer, ffmpeg and feeder together — rather than a
// feeder-only restart handing a live ffmpeg a new writer.
test('killing the video feeder ends the whole pipeline instead of replacing the writer', async () => {
  const env = stubEnv();
  const stream = startStream(env);
  await sleep(3000);
  const feeder = children(stream.pid).find((c) => c.cmd.includes('videofeed'));
  if (!feeder) { reap(stream); rmSync(env.dir, { recursive: true, force: true }); assert.fail('no feeder to kill'); }

  const killedAt = Date.now();
  for (const c of children(stream.pid)) { if (c.cmd.includes('videofeed')) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } } }

  let code;
  try {
    [code] = await Promise.race([
      once(stream, 'close'),
      sleep(20000).then(() => { throw new Error('stream.sh did not exit within 20s of the feeder dying — a wedged pipeline is exactly what this coupling exists to prevent'); }),
    ]);
  } finally {
    reap(stream);
    rmSync(env.dir, { recursive: true, force: true });
  }
  const tookMs = Date.now() - killedAt;

  assert.ok(tookMs < 15000, `stream.sh took ${tookMs}ms to notice the feeder died`);
  assert.notEqual(code, 0, 'a dead feeder must fail the unit, or systemd will not restart it');
});

// Nothing may separately supervise the feeder: a unit with its own Restart=always is
// exactly the thing that replaces the writer under a live ffmpeg.
test('there is no separate always-restarting feeder unit', () => {
  const names = execFileSync('ls', [new URL('.', import.meta.url).pathname], { encoding: 'utf8' }).split('\n');

  assert.ok(!names.includes('endless-memory-videofeed.service'),
    'a standalone videofeed unit restarts the fifo writer under a live ffmpeg, which wedges it');
  const stream = readFileSync(new URL('./endless-memory-stream.service', import.meta.url), 'utf8');
  assert.doesNotMatch(stream, /^Requires=.*videofeed/m);
});
