import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLog, summarise, formatReport, localHour, NIGHT_HOURS } from './framelog.mjs';

// A synthetic day of the log `videoframe.mjs run` writes: one poll a minute, a new frame
// on most of them and a 304 on the rest.
function day({ start = '2026-10-12T04:00:00Z', minutes = 24 * 60, churn = () => 0.04, gapS = () => 60 } = {}) {
  const lines = [JSON.stringify({ at: start, event: 'start', userAgent: 'endless-memory/1.0 test' })];
  let t = Date.parse(start);
  for (let m = 0; m < minutes; m++) {
    t += gapS(m) * 1000;
    const at = new Date(t).toISOString();
    if (m % 10 === 9) lines.push(JSON.stringify({ at, event: 'poll', result: 'unchanged', status: 304 }));
    else lines.push(JSON.stringify({ at, event: 'poll', result: 'frame', status: 200, span: 76, churn: m === 0 ? null : churn(at) }));
  }
  return lines.join('\n');
}

test('local hours are Boston time, not UTC', () => {
  assert.equal(localHour('2026-10-12T07:00:00Z'), 3);   // EDT, UTC-4
  assert.equal(localHour('2026-12-12T08:00:00Z'), 3);   // EST, UTC-5
});

test('a polite, quiet 24-hour run passes both criteria', () => {
  const { events, skipped } = parseLog(day());
  const s = summarise(events);
  assert.equal(skipped, 0);
  assert.ok(s.hours > 23.9);
  assert.equal(s.minGapS, 60);
  assert.equal(s.tooFast, 0);
  assert.equal(s.notModifiedShare, 1);
  assert.ok(s.criterion3.ok);
  assert.ok(s.criterion8.ok, JSON.stringify(s.criterion8));
  assert.match(formatReport(s), /Criterion 3, polling: PASS[\s\S]*Criterion 8, overnight churn at or below 8.0%: PASS/);
});

test('a request inside the minute fails criterion 3', () => {
  const s = summarise(parseLog(day({ minutes: 120, gapS: (m) => (m === 50 ? 30 : 60) })).events);
  assert.equal(s.tooFast, 1);
  assert.equal(s.minGapS, 30);
  assert.equal(s.criterion3.ok, false);
});

test('a restart is not a fast poll', () => {
  const text = [
    JSON.stringify({ at: '2026-10-12T04:00:00Z', event: 'start' }),
    JSON.stringify({ at: '2026-10-12T04:00:01Z', event: 'poll', result: 'frame', status: 200 }),
    'Error: something crashed',
    '    at stack frame',
    JSON.stringify({ at: '2026-10-12T04:00:20Z', event: 'start' }),
    JSON.stringify({ at: '2026-10-12T04:00:21Z', event: 'poll', result: 'unchanged', status: 304 }),
  ].join('\n');
  const { events, skipped } = parseLog(text);
  const s = summarise(events);
  assert.equal(skipped, 2);
  assert.equal(s.starts, 2);
  assert.equal(s.tooFast, 0);
});

test('churn over the bar at 3 am fails criterion 8 and names the hour', () => {
  const s = summarise(parseLog(day({ churn: (at) => (localHour(at) === 3 ? 0.12 : 0.04) })).events);
  assert.equal(s.criterion8.ok, false);
  assert.deepEqual(s.criterion8.overBar, [3]);
});

test('a run that never reached the night cannot pass criterion 8', () => {
  // 10:00 to 16:00 Boston time.
  const s = summarise(parseLog(day({ start: '2026-10-12T14:00:00Z', minutes: 6 * 60 })).events);
  assert.equal(s.criterion8.ok, false);
  assert.deepEqual(s.criterion8.uncovered, NIGHT_HOURS);
  assert.ok(s.criterion3.ok, 'six hours is enough for the polling criterion');
});

test('repeats count against the 304 share', () => {
  const text = [
    JSON.stringify({ at: '2026-10-12T04:00:00Z', event: 'poll', result: 'repeat', status: 200 }),
    JSON.stringify({ at: '2026-10-12T04:01:00Z', event: 'poll', result: 'repeat', status: 200 }),
    JSON.stringify({ at: '2026-10-12T04:02:00Z', event: 'poll', result: 'repeat', status: 200 }),
    JSON.stringify({ at: '2026-10-12T04:03:00Z', event: 'poll', result: 'unchanged', status: 304 }),
  ].join('\n');
  const s = summarise(parseLog(text).events);
  assert.equal(s.notModifiedShare, 0.25);
  assert.equal(s.criterion3.ok, false);
});

// Camera ink (2026-10-12) moves night noise from glyph shape into ink colour, so the
// per-hour ink shift is reported beside churn. It is a measurement, not yet a gate: no
// bar exists until a night of it has been looked at.
test('ink shift is reported per hour, and a log without it still reads', () => {
  const withInk = day().split('\n').map((l) => {
    const e = JSON.parse(l);
    if (e.result === 'frame') e.inkShift = localHour(e.at) === 3 ? 0.05 : 0.01;
    return JSON.stringify(e);
  }).join('\n');
  const s = summarise(parseLog(withInk).events);
  assert.equal(s.byHour[3].medianInkShift, 0.05);
  assert.equal(s.byHour[12].medianInkShift, 0.01);
  assert.ok(s.criterion8.ok, 'ink shift must not gate criterion 8');
  assert.match(formatReport(s), /median ink shift/);
  assert.match(formatReport(s), /03:00 .* 5\.0%/);
  assert.equal(summarise(parseLog(day()).events).byHour[3].medianInkShift, null);
});
