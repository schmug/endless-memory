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

// Spec criterion 6, the one that proves piece D cannot take the station off the air.
// Killing the feeder must leave the audio running to the end of the run.
test('the feeder dying mid-run passes only when the audio ran on to the end', () => {
  const verdict = assessFeederKill({ killedAtSeconds: 60, audioEndSeconds: 299.4, targetSeconds: 300, framesResumed: true });

  assert.equal(verdict.ok, true);
});

// The failure this exists to catch: the video feeder takes the whole broadcast with it.
// Without the fifo holder fd, ffmpeg sees EOF on the video input and the run ends.
test('a run that ended when the feeder was killed is the failure, not a short run', () => {
  const verdict = assessFeederKill({ killedAtSeconds: 60, audioEndSeconds: 61.2, targetSeconds: 300, framesResumed: true });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /ended/);
});

// "the unit restarts and resumes feeding" — a run that survived because ffmpeg held the
// last frame forever, with nothing ever feeding it again, has not shown the whole thing.
test('surviving the kill is not enough; the feed has to come back', () => {
  const verdict = assessFeederKill({ killedAtSeconds: 60, audioEndSeconds: 299.4, targetSeconds: 300, framesResumed: false });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /resume/);
});

test('a run with no feeder kill reports that it did not attempt one', () => {
  const verdict = assessFeederKill({ killedAtSeconds: null, audioEndSeconds: 299.4, targetSeconds: 300 });

  assert.equal(verdict.attempted, false);
  assert.equal(verdict.ok, true);
});

// Every verdict is a gate. A run that produced a file and exited 0 while measuring
// nothing must not report PASS — the realtime harness makes the same argument about a
// clean exit and a large file proving nothing.
test('collectFailures gates on every verdict, not just the exit code', () => {
  const clean = {
    renderCode: 0, ffmpegCode: 0, outputBytes: 1024,
    tracks: { ok: true, reason: 't' }, drift: { ok: true, reason: 'd' }, silence: { ok: true, reason: 's' },
    starvation: { ok: true, reason: 'p' }, levels: { ok: true, reason: 'l' }, avSkew: { ok: true, reason: 'a' },
    feederKill: { ok: true, reason: 'f' }, feederOutage: { ok: true, reason: 'o' }, rssVerdict: { ok: true, reason: 'r' },
  };

  assert.deepEqual(collectFailures(clean), []);
  assert.deepEqual(collectFailures({ ...clean, feederOutage: { ok: false, reason: 'never recovered' } }), ['never recovered']);
  assert.deepEqual(collectFailures({ ...clean, levels: { ok: false, reason: 'true peak too high' } }), ['true peak too high']);
  assert.equal(collectFailures({ ...clean, ffmpegCode: 1 }).length, 1);
  assert.equal(collectFailures({ ...clean, outputBytes: 0 }).length, 1);
  assert.equal(collectFailures({ ...clean, starvation: { ok: false, reason: 'starved' }, drift: { ok: false, reason: 'drifted' } }).length, 2);
});
