import test from 'node:test';
import assert from 'node:assert/strict';
import {
  judge, checkOnce, check, reconcile, ON_AIR, OFF_AIR, UNKNOWN, ALERT_TITLE,
} from './onair.mjs';

// Shapes follow the YouTube Data API v3 search.list response. No live API in tests.
const LIVE = { items: [{ id: { videoId: 'abc123' }, snippet: { liveBroadcastContent: 'live' } }] };
const EMPTY = { items: [] };
const QUOTA = { error: { code: 403, message: 'The request cannot be completed because you have exceeded your quota.' } };

const respond = (...answers) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const [status, body] = answers[Math.min(calls.length - 1, answers.length - 1)];
    return { status, json: async () => body };
  };
  return { fetchImpl, calls };
};

test('a live item is ON_AIR and names the broadcast', () => {
  assert.deepEqual(judge(200, LIVE), { state: ON_AIR, videoIds: ['abc123'] });
});

test('no live items is OFF_AIR', () => {
  assert.equal(judge(200, EMPTY).state, OFF_AIR);
  // An upcoming or completed broadcast is not on the air.
  assert.equal(judge(200, { items: [{ id: { videoId: 'x' }, snippet: { liveBroadcastContent: 'none' } }] }).state, OFF_AIR);
});

// The property that keeps the alert trustworthy: a broken key or spent quota says
// nothing about the station, so it must never open an off-air issue.
test('an API error is UNKNOWN, never OFF_AIR', () => {
  assert.equal(judge(403, QUOTA).state, UNKNOWN);
  assert.match(judge(403, QUOTA).reason, /quota/);
  assert.equal(judge(200, null).state, UNKNOWN);
  assert.equal(judge(500, {}).state, UNKNOWN);
});

test('a network failure is UNKNOWN', async () => {
  const v = await checkOnce({ apiKey: 'k', channelId: 'c', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(v.state, UNKNOWN);
});

test('the request asks for live broadcasts on the configured channel', async () => {
  const { fetchImpl, calls } = respond([200, LIVE]);
  await checkOnce({ apiKey: 'k', channelId: 'UCchan', fetchImpl });
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('channelId'), 'UCchan');
  assert.equal(url.searchParams.get('eventType'), 'live');
  assert.equal(url.searchParams.get('type'), 'video');
});

// A restart briefly ends the broadcast. One not-live answer must not be an outage.
test('OFF_AIR then ON_AIR on the recheck is ON_AIR', async () => {
  const { fetchImpl, calls } = respond([200, EMPTY], [200, LIVE]);
  const slept = [];
  const v = await check({ apiKey: 'k', channelId: 'c', fetchImpl, sleep: async (ms) => { slept.push(ms); }, recheckMs: 7 });
  assert.equal(v.state, ON_AIR);
  assert.equal(calls.length, 2);
  assert.deepEqual(slept, [7]);
});

test('OFF_AIR twice is OFF_AIR', async () => {
  const { fetchImpl } = respond([200, EMPTY], [200, EMPTY]);
  const v = await check({ apiKey: 'k', channelId: 'c', fetchImpl, sleep: async () => {} });
  assert.equal(v.state, OFF_AIR);
});

test('ON_AIR on the first answer does not spend a second request', async () => {
  const { fetchImpl, calls } = respond([200, LIVE]);
  await check({ apiKey: 'k', channelId: 'c', fetchImpl, sleep: async () => { throw new Error('slept'); } });
  assert.equal(calls.length, 1);
});

// A stand-in for the GitHub REST API holding a list of issues.
function fakeGitHub(issues = []) {
  const writes = [];
  let next = 100;
  const gh = async (method, path, body) => {
    if (method === 'GET') return issues.filter((i) => i.state === 'open');
    writes.push({ method, path, body });
    if (method === 'POST' && path === '/issues') { const i = { number: next++, title: body.title, state: 'open' }; issues.push(i); return i; }
    if (method === 'PATCH') { const n = Number(path.split('/').pop()); issues.find((i) => i.number === n).state = body.state; }
    return {};
  };
  return { gh, writes, issues };
}

test('off air with no alert open opens one', async () => {
  const f = fakeGitHub();
  const r = await reconcile({ state: OFF_AIR }, { gh: f.gh });
  assert.equal(r.action, 'opened');
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].body.title, ALERT_TITLE);
  // `systemctl status` prints the stream key (ops/README.md), so the alert warns off it.
  assert.match(f.writes[0].body.body, /never `systemctl status`/);
});

// One outage, one notification.
test('off air with an alert already open writes nothing', async () => {
  const f = fakeGitHub([{ number: 7, title: ALERT_TITLE, state: 'open' }]);
  const r = await reconcile({ state: OFF_AIR }, { gh: f.gh });
  assert.deepEqual(r, { action: 'none', issue: 7 });
  assert.equal(f.writes.length, 0);
});

test('back on air comments on and closes the open alert', async () => {
  const f = fakeGitHub([{ number: 7, title: ALERT_TITLE, state: 'open' }]);
  const r = await reconcile({ state: ON_AIR, videoIds: ['abc123'] }, { gh: f.gh });
  assert.equal(r.action, 'closed');
  assert.match(f.writes[0].body.body, /abc123/);
  assert.equal(f.issues[0].state, 'closed');
});

test('on air with nothing open, or an unknown verdict, writes nothing', async () => {
  const f = fakeGitHub([{ number: 3, title: 'something else', state: 'open' }]);
  await reconcile({ state: ON_AIR, videoIds: ['a'] }, { gh: f.gh });
  await reconcile({ state: UNKNOWN, reason: 'quota' }, { gh: f.gh });
  assert.equal(f.writes.length, 0);
});

test('pull requests that happen to share the title are ignored', async () => {
  const f = fakeGitHub([{ number: 9, title: ALERT_TITLE, state: 'open', pull_request: {} }]);
  const r = await reconcile({ state: OFF_AIR }, { gh: f.gh });
  assert.equal(r.action, 'opened');
});
