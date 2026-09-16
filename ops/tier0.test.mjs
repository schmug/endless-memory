import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTracks, assessFeederKill, collectFailures } from './tier0.mjs';

// The acceptance criterion in one assertion: a local run produces a file with BOTH an
// audio and a video track, from a single ffmpeg invocation. YouTube Live requires a
// video track, so an audio-only file is not a smaller success.
test('a file carrying both tracks passes; an audio-only one does not', () => {
  const both = [
    { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
  ];

  assert.equal(assessTracks(both).ok, true);
  assert.equal(assessTracks(both.slice(1)).ok, false);
  assert.match(assessTracks(both.slice(1)).reason, /video/);
  assert.equal(assessTracks(both.slice(0, 1)).ok, false);
});

test('a video track at the wrong size fails, because the seam contract is 1280x720', () => {
  const wrong = [
    { codec_type: 'video', codec_name: 'h264', width: 640, height: 360 },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
  ];

  assert.equal(assessTracks(wrong).ok, false);
});

// Audio at the wrong rate plays at the wrong speed while passing every structural
// check, which is exactly why the three input flags are not tunable.
test('audio at the wrong sample rate fails', () => {
  const wrong = [
    { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2 },
  ];

  assert.equal(assessTracks(wrong).ok, false);
});

// Criterion 6 as the spec wrote it — "videofeed is killed and the broadcast does not
// end ... the unit restarts and resumes feeding" — was measured on 2026-09-15 to be
// unachievable: replacing the fifo's writer under a live ffmpeg wedges it. stream.sh
// now owns the feeder, so the safe behaviour is the opposite one. A dead feeder must
// END the pipeline promptly, so systemd restarts renderer, ffmpeg and feeder together.
test('a feeder death that ends the pipeline promptly is the passing case now', () => {
  const verdict = assessFeederKill({ killedAtSeconds: 120, exitedAtSeconds: 123.4, graceSeconds: 15 });

  assert.equal(verdict.ok, true);
  assert.ok(verdict.tookSeconds < 15);
});

// The failure this replaces the old criterion with: the pipeline outliving its feeder is
// exactly the wedge, and it is dead air no liveness check can see.
test('a pipeline that outlives its dead feeder is the failure, not the success', () => {
  const verdict = assessFeederKill({ killedAtSeconds: 120, exitedAtSeconds: null, graceSeconds: 15 });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /did not end|wedge/i);
});

test('a pipeline that takes too long to notice its feeder died fails', () => {
  const verdict = assessFeederKill({ killedAtSeconds: 120, exitedAtSeconds: 180, graceSeconds: 15 });

  assert.equal(verdict.ok, false);
});

test('a run with no feeder kill reports that it did not attempt one', () => {
  const verdict = assessFeederKill({ killedAtSeconds: null, exitedAtSeconds: 300, graceSeconds: 15 });

  assert.equal(verdict.attempted, false);
  assert.equal(verdict.ok, true);
});

// Every verdict is a gate. A run that produced a file and exited 0 while measuring
// nothing must not report PASS — the realtime harness makes the same argument about a
// clean exit and a large file proving nothing.
// A run killed on purpose cannot produce an end-of-run measurement: ffmpeg never prints
// its ebur128 Summary and the flv has no trailer to probe for skew. Reporting those as
// failures in a feeder-kill run is noise that trains someone to ignore a real one — the
// same argument assessRssSlope makes for a run too short to fit a trend.
test('a deliberately killed run does not fail on measurements only a clean end can produce', () => {
  const killed = {
    renderCode: 0, ffmpegCode: 143, outputBytes: 1024,
    tracks: { ok: true, reason: 't' }, drift: { ok: true, reason: 'd' }, silence: { ok: true, reason: 's' },
    starvation: { ok: true, reason: 'p' }, stall: { ok: true, reason: 'n' }, rssVerdict: { ok: true, reason: 'r' },
    levels: { ok: false, reason: 'no ebur128 summary in the run' },
    avSkew: { ok: false, reason: 'A/V skew could not be measured at both ends of the run' },
    feederKill: { ok: true, attempted: true, reason: 'ended 0.1s later' },
  };

  assert.deepEqual(collectFailures(killed), []);
});

// And the gate is not weakened for a normal run: there, an unmeasurable level IS a
// failure, because a clean run has no excuse for producing none.
test('a run that was not killed still fails on an unmeasurable level', () => {
  const normal = {
    renderCode: 0, ffmpegCode: 0, outputBytes: 1024,
    tracks: { ok: true, reason: 't' }, drift: { ok: true, reason: 'd' }, silence: { ok: true, reason: 's' },
    starvation: { ok: true, reason: 'p' }, stall: { ok: true, reason: 'n' }, rssVerdict: { ok: true, reason: 'r' },
    levels: { ok: false, reason: 'no ebur128 summary in the run' },
    avSkew: { ok: true, reason: 'a' },
    feederKill: { ok: true, attempted: false, reason: 'none' },
  };

  assert.deepEqual(collectFailures(normal), ['no ebur128 summary in the run']);
});

test('collectFailures gates on every verdict, not just the exit code', () => {
  const clean = {
    renderCode: 0, ffmpegCode: 0, outputBytes: 1024,
    tracks: { ok: true, reason: 't' }, drift: { ok: true, reason: 'd' }, silence: { ok: true, reason: 's' },
    starvation: { ok: true, reason: 'p' }, levels: { ok: true, reason: 'l' }, avSkew: { ok: true, reason: 'a' },
    feederKill: { ok: true, reason: 'f' },
    stall: { ok: true, reason: 'n' }, rssVerdict: { ok: true, reason: 'r' },
  };

  assert.deepEqual(collectFailures(clean), []);
  // The failure mode that hung a 60-minute run on 2026-09-14: ffmpeg wedged with every
  // process alive, so the harness's own exit-code check would have reported nothing at
  // all. A stall has to be a gate in its own right.
  assert.deepEqual(collectFailures({ ...clean, ffmpegCode: 0, stall: { ok: false, reason: 'DEAD AIR at 1791s' } }), ['DEAD AIR at 1791s']);
  assert.deepEqual(collectFailures({ ...clean, levels: { ok: false, reason: 'true peak too high' } }), ['true peak too high']);
  assert.equal(collectFailures({ ...clean, ffmpegCode: 1 }).length, 1);
  assert.equal(collectFailures({ ...clean, outputBytes: 0 }).length, 1);
  assert.equal(collectFailures({ ...clean, starvation: { ok: false, reason: 'starved' }, drift: { ok: false, reason: 'drifted' } }).length, 2);
});
