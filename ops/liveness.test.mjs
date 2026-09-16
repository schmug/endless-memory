import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  createLiveness, LIVE, HELD, ARCHIVE,
  LIVE_MAX_MS, HELD_MAX_MS, FROZEN_AFTER_REPEATS, ARCHIVE_DATE,
} from './liveness.mjs';

const MIN = 60_000;

// A clock the tests drive by hand. The whole point of the module taking one is
// that an hour of station time costs a few hundred function calls, so these
// tests never sleep and never read the wall clock.
function testClock(start = 0) {
  let t = start;
  return { now: () => t, set: (ms) => { t = ms; }, advance: (ms) => { t += ms; } };
}

// The three poll outcomes the module accepts. Deliberately not HTTP: the caller
// owns the transport, and hands this module what the transport concluded.
const frame = (hash) => ({ kind: 'frame', hash });
const unchanged = () => ({ kind: 'unchanged' });   // 304
const failed = () => ({ kind: 'error' });          // refused, 5xx, timeout

// ---------------------------------------------------------------------------
// Acceptance criterion 1: the full validated timeline from issue #51.
//
// The rows below are the ten sampled instants that issue records; the polls
// between them are every 60 s, as the polling contract specifies. Each row's
// description labels the poll AT that instant, which is what fixes the
// schedule: 10:00 is itself the first refused connection (so the last good
// frame is 09:00 and the picture is still LIVE at one minute old), and 23:00
// is itself the first byte-identical repeat (so the last genuinely different
// frame is 22:00).
//
// `age` is stated here rather than in the issue's caption column, which shows
// one representative HELD caption in both HELD rows. At 29:00 the frame really
// is seven minutes old: the last different frame landed at 22:00. Getting six
// there would require the age to date from 23:00 — a poll that returned bytes
// already held — which is exactly the accounting this module exists to refuse.
// ---------------------------------------------------------------------------
const TIMELINE = [
  { vt: 0,  poll: 'error',     state: ARCHIVE, frozen: false, age: null, caption: `archive ${ARCHIVE_DATE} — not live` },
  { vt: 2,  poll: 'frame',     state: LIVE,    frozen: false, age: 0,    caption: 'live' },
  { vt: 6,  poll: 'unchanged', state: LIVE,    frozen: false, age: 1,    caption: 'live' },
  { vt: 10, poll: 'error',     state: LIVE,    frozen: false, age: 1,    caption: 'live' },
  { vt: 15, poll: 'error',     state: HELD,    frozen: false, age: 6,    caption: 'held, frame 6 min old' },
  { vt: 21, poll: 'frame',     state: LIVE,    frozen: false, age: 0,    caption: 'live' },
  { vt: 23, poll: 'repeat',    state: LIVE,    frozen: false, age: 1,    caption: 'live' },
  { vt: 29, poll: 'repeat',    state: HELD,    frozen: true,  age: 7,    caption: 'held, frame 7 min old' },
  { vt: 53, poll: 'repeat',    state: ARCHIVE, frozen: true,  age: 31,   caption: `archive ${ARCHIVE_DATE} — not live` },
  { vt: 65, poll: 'frame',     state: LIVE,    frozen: false, age: 0,    caption: 'live' },
];

// The regime each minute of the timeline sits in.
function pollAt(vt) {
  if (vt === 0) return 'error';                    // cold start, network down
  if (vt === 6) return 'unchanged';                // dropped publish, 304
  if (vt <= 9) return 'frame';                     // healthy, a new frame a minute
  if (vt <= 20) return 'error';                    // camera unreachable
  if (vt <= 22) return 'frame';                    // recovered
  if (vt <= 64) return 'repeat';                   // frozen: 200 OK, fresh headers, same bytes
  return 'frame';                                  // recovered again
}

test('the full liveness timeline, on an injected clock', () => {
  const clock = testClock();
  const ladder = createLiveness({ now: clock.now });
  const expected = new Map(TIMELINE.map((row) => [row.vt, row]));
  let distinct = 0;

  for (let vt = 0; vt <= 65; vt++) {
    clock.set(vt * MIN);
    const kind = pollAt(vt);
    if (kind === 'frame') ladder.record(frame(`f${distinct++}`));
    else if (kind === 'repeat') ladder.record(frame(`f${distinct - 1}`));
    else if (kind === 'unchanged') ladder.record(unchanged());
    else ladder.record(failed());

    const row = expected.get(vt);
    if (!row) continue;
    const status = ladder.status();
    assert.equal(kind, row.poll, `vt ${vt}: poll regime`);
    assert.equal(status.state, row.state, `vt ${vt}: state`);
    assert.equal(status.frozen, row.frozen, `vt ${vt}: frozen`);
    assert.equal(status.ageMs === null ? null : status.ageMs / MIN, row.age, `vt ${vt}: age in minutes`);
    assert.equal(status.caption, row.caption, `vt ${vt}: caption`);
    expected.delete(vt);
  }

  assert.equal(expected.size, 0, 'every sampled instant was reached');
});

// ---------------------------------------------------------------------------
// Acceptance criterion 2: the age-accounting regression.
//
// The naive ladder advances the frame age on every successful fetch and only
// stops once five identical frames have latched `frozen`. It therefore keeps
// captioning the picture `live` for five minutes past the point the camera
// stopped, off a frame it already held. These two tests fail under it.
// ---------------------------------------------------------------------------
test('a byte-identical frame never refreshes the age', () => {
  const clock = testClock();
  const ladder = createLiveness({ now: clock.now });
  ladder.record(frame('last-distinct'));

  // The camera freezes. Every poll from here on succeeds with the bytes we hold.
  let lastLiveMinute = 0;
  for (let vt = 1; vt <= 20; vt++) {
    clock.set(vt * MIN);
    ladder.record(frame('last-distinct'));
    if (ladder.status().state === LIVE) lastLiveMinute = vt;
  }

  // Six minutes after the last genuinely different frame, not six minutes after
  // the last successful fetch. The naive ladder reports 10 here.
  assert.equal(lastLiveMinute, 5, 'the caption stops claiming live within six minutes of the last different frame');
});

test('the age dates from the last different frame, not the last successful fetch', () => {
  const clock = testClock();
  const ladder = createLiveness({ now: clock.now });
  ladder.record(frame('last-distinct'));

  for (let vt = 1; vt <= 9; vt++) {
    clock.set(vt * MIN);
    ladder.record(frame('last-distinct'));
  }

  const status = ladder.status();
  assert.equal(status.ageMs, 9 * MIN, 'nine minutes of repeats age the frame by nine minutes');
  assert.equal(status.state, HELD);
  assert.equal(status.caption, 'held, frame 9 min old');
  assert.notEqual(status.caption, 'live');
});

// ---------------------------------------------------------------------------
// Acceptance criterion 3: frozen within five identical fetches; 304 is not one.
// ---------------------------------------------------------------------------
test('frozen is declared on the fifth consecutive byte-identical fetch', () => {
  const clock = testClock();
  const ladder = createLiveness({ now: clock.now });
  ladder.record(frame('a'));

  const seen = [];
  for (let i = 1; i <= FROZEN_AFTER_REPEATS; i++) {
    clock.advance(MIN);
    ladder.record(frame('a'));
    seen.push(ladder.status().frozen);
  }

  assert.deepEqual(seen, [false, false, false, false, true]);
});

test('a 304 is not a frozen signal', () => {
  const clock = testClock();
  const ladder = createLiveness({ now: clock.now });
  ladder.record(frame('a'));

  // Twenty dropped publishes in a row. Nothing new is not the same claim as
  // the same bytes again, and at this cadence a 304 is ordinary.
  for (let i = 0; i < 20; i++) {
    clock.advance(MIN);
    ladder.record(unchanged());
  }

  const status = ladder.status();
  assert.equal(status.frozen, false, '304 carries no body and cannot show the content repeated');
  // It is still not fresh: the camera has gone silent, so the ladder falls
  // through on age alone.
  assert.equal(status.state, HELD);
  assert.equal(status.ageMs, 20 * MIN);
});

test('an error breaks the run of consecutive identical fetches', () => {
  const clock = testClock();
  const ladder = createLiveness({ now: clock.now });
  ladder.record(frame('a'));
  for (let i = 0; i < 4; i++) { clock.advance(MIN); ladder.record(frame('a')); }

  clock.advance(MIN);
  ladder.record(failed());
  clock.advance(MIN);
  ladder.record(frame('a'));
  assert.equal(ladder.status().frozen, false, 'the fifth identical fetch was not consecutive with the first four');
});

test('a 304 mid-run neither advances nor breaks the frozen count', () => {
  const clock = testClock();
  const ladder = createLiveness({ now: clock.now });
  ladder.record(frame('a'));

  // Four identical bodies, a dropped publish, then the fifth identical body.
  // A 304 says the origin file has not moved, which agrees with the content
  // not moving, so it is not the contradiction an error is.
  for (let i = 0; i < 4; i++) { clock.advance(MIN); ladder.record(frame('a')); }
  clock.advance(MIN);
  ladder.record(unchanged());
  assert.equal(ladder.status().frozen, false, 'a 304 is not itself the fifth identical body');
  clock.advance(MIN);
  ladder.record(frame('a'));
  assert.equal(ladder.status().frozen, true, 'the run survived the dropped publish');
});

test('once declared, frozen is cleared only by a genuinely new frame', () => {
  const clock = testClock();
  const ladder = createLiveness({ now: clock.now });
  ladder.record(frame('a'));
  for (let i = 0; i < FROZEN_AFTER_REPEATS; i++) { clock.advance(MIN); ladder.record(frame('a')); }
  assert.equal(ladder.status().frozen, true);

  clock.advance(MIN);
  ladder.record(failed());
  assert.equal(ladder.status().frozen, true, 'a failed fetch is not evidence the camera came back');
  clock.advance(MIN);
  ladder.record(unchanged());
  assert.equal(ladder.status().frozen, true, 'nor is a 304');

  clock.advance(MIN);
  ladder.record(frame('b'));
  assert.equal(ladder.status().frozen, false);
});

// ---------------------------------------------------------------------------
// Acceptance criterion 4: cold start with nothing cached and no network.
// ---------------------------------------------------------------------------
test('cold start with no cached frame and no network is ARCHIVE, never live', () => {
  const clock = testClock();
  const ladder = createLiveness({ now: clock.now });

  assert.equal(ladder.status().state, ARCHIVE, 'before the first poll');
  assert.equal(ladder.status().ageMs, null);
  assert.equal(ladder.status().frameAt, null);
  assert.equal(ladder.status().caption, `archive ${ARCHIVE_DATE} — not live`);

  for (let i = 0; i < 30; i++) {
    clock.advance(MIN);
    ladder.record(failed());
    const status = ladder.status();
    assert.equal(status.state, ARCHIVE);
    assert.notEqual(status.caption, 'live');
  }
});

test('the archive date is captioned, and is configurable for the committed still', () => {
  const clock = testClock();
  const ladder = createLiveness({ now: clock.now, archiveDate: '2025-01-10' });
  assert.equal(ladder.status().caption, 'archive 2025-01-10 — not live');
  assert.equal(ARCHIVE_DATE, '2025-01-10', 'the NPS -002 stills, Last-Modified 10 Jan 2025');
});

// ---------------------------------------------------------------------------
// The ladder's thresholds, exactly as the spec states them.
// ---------------------------------------------------------------------------
test('the ladder switches at the spec thresholds', () => {
  const clock = testClock();
  const ladder = createLiveness({ now: clock.now });
  ladder.record(frame('a'));

  const stateAt = (ms) => { clock.set(ms); return ladder.status().state; };
  assert.equal(stateAt(LIVE_MAX_MS - 1), LIVE, 'just under six minutes');
  assert.equal(stateAt(LIVE_MAX_MS), HELD, 'six minutes exactly is held');
  assert.equal(stateAt(HELD_MAX_MS), HELD, 'thirty minutes exactly is still held');
  assert.equal(stateAt(HELD_MAX_MS + 1), ARCHIVE, 'past thirty minutes');
});

test('recovery has no hysteresis', () => {
  const clock = testClock();
  const ladder = createLiveness({ now: clock.now });
  ladder.record(frame('a'));
  clock.advance(HELD_MAX_MS + MIN);
  assert.equal(ladder.status().state, ARCHIVE);

  ladder.record(frame('b'));
  const status = ladder.status();
  assert.equal(status.state, LIVE, 'one genuinely new frame is enough');
  assert.equal(status.ageMs, 0);
  assert.equal(status.caption, 'live');
});

test('status() advances with the clock between polls', () => {
  const clock = testClock();
  const ladder = createLiveness({ now: clock.now });
  ladder.record(frame('a'));
  assert.equal(ladder.status().state, LIVE);
  clock.advance(7 * MIN);
  assert.equal(ladder.status().state, HELD, 'the ladder falls through without being polled');
});

test('createLiveness refuses to invent a clock', () => {
  assert.throws(() => createLiveness({}), /now/);
});

test('an unknown poll outcome is rejected rather than silently ignored', () => {
  const clock = testClock();
  const ladder = createLiveness({ now: clock.now });
  assert.throws(() => ladder.record({ kind: 'ok' }), /outcome/);
  assert.throws(() => ladder.record(frame(undefined)), /hash/);
});

// ---------------------------------------------------------------------------
// The module is pure: no transport, no filesystem, no wall clock. This mirrors
// the guard in runtime/render.test.mjs, which scans raw source text for the
// same reason — a claim about what the code cannot do is a claim about the
// source, not about a behaviour a test can observe.
// ---------------------------------------------------------------------------
test('ops modules import nothing and read no wall clock', () => {
  const dir = new URL('.', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
  assert.ok(files.includes('liveness.mjs'), 'the guard found the module it is guarding');

  for (const file of files) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    const imports = [...source.matchAll(/\bimport\s[^;]*?['"]([^'"]+)['"]/g)].map((m) => m[1]);
    assert.deepEqual(imports, [], `${file} imports nothing`);
    assert.equal(/\brequire\s*\(/.test(source), false, `${file} does not require()`);
    assert.equal(/\bDate\.now\b|\bnew Date\b|\bperformance\.now\b/.test(source), false,
      `${file} reads no wall clock`);
  }
});
