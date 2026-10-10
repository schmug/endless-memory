// The off-host "is it live?" check. Runs on a GitHub Actions schedule
// (.github/workflows/on-air.yml), nowhere near the WSL2 host it is checking.
//
// Why off-host: every host-local signal — stream.sh's stall watchdog, NRestarts, the
// progress file — is silent when the host itself is down, WSL has been shut down, or
// Windows rebooted and nobody has logged in (ops/README.md, "The production host"). The
// only witness that survives those is one that asks YouTube.
//
// How: two YouTube Data API calls, one quota unit each. playlistItems.list reads the
// channel's uploads playlist (its id is the channel id with UC swapped for UU), which
// lists a public live broadcast like any other video; videos.list then asks which of
// the newest few are live right now. Not the broadcast's own video id: on the
// direct-to-YouTube host a restart may end one broadcast and start another, so a fixed
// id would report off-air after the first journal change. Not search.list with
// eventType=live, which is what this first used: on 2026-10-10 it answered "no live
// broadcast" twice, five minutes apart, while the public stream was live and audible
// (issue #66). Search is an index, not the source of truth. Not scraping the watch page
// either: its markup is undocumented and changes.

// What it does about it: one issue titled ALERT_TITLE, opened when the station is off
// the air and closed when it is back. GitHub notifies the repo owner of both. While the
// issue stays open, later off-air checks add nothing, so an outage is one notification,
// not one every half hour.
//
// A failed API call is UNKNOWN, never OFF AIR. A quota or key problem is not an outage,
// and an alert that cries wolf gets muted. UNKNOWN exits non-zero, so the workflow run
// itself fails and GitHub reports that separately.
//
// Node stdlib only (global fetch), in keeping with the rest of ops/.

import { pathToFileURL } from 'node:url';

export const ON_AIR = 'ON_AIR';
export const OFF_AIR = 'OFF_AIR';
export const UNKNOWN = 'UNKNOWN';

export const ALERT_TITLE = 'Station off the air';

// A restart ends the broadcast for however long YouTube takes to bring the next one up,
// and the stall watchdog alone can take ~2 minutes to fire. One not-live answer is
// therefore not an outage; two answers this far apart is. Unmeasured: how long a
// restart actually leaves the channel not-live on this host (plan item 1d). If that
// turns out longer than this, raise it rather than alerting on every journal change.
export const RECHECK_MS = 5 * 60_000;

const API = 'https://www.googleapis.com/youtube/v3';

// How many of the newest uploads to ask about. The uploads playlist is newest first by
// publish time, and a live broadcast is published when it starts, so the current one
// sits at or near the top unless this many videos were published after it went live.
export const RECENT = 10;

// Pure: an API response that is not a usable list is UNKNOWN, with the API's own reason.
function failure(status, body) {
  if (status === 200 && body && Array.isArray(body.items)) return null;
  return { state: UNKNOWN, reason: body?.error?.message ?? `HTTP ${status}` };
}

// Pure: one videos.list response body to a verdict. Exported for the tests.
export function judge(status, body) {
  const bad = failure(status, body);
  if (bad) return bad;
  const live = body.items
    .filter((it) => it?.snippet?.liveBroadcastContent === 'live')
    .map((it) => it.id)
    .filter(Boolean);
  return live.length
    ? { state: ON_AIR, videoIds: live }
    : { state: OFF_AIR, reason: `none of the channel's ${body.items.length} newest uploads is live` };
}

export const uploadsPlaylist = (channelId) => `UU${channelId.slice(2)}`;

async function get(fetchImpl, path, params) {
  const url = new URL(`${API}/${path}`);
  url.search = new URLSearchParams(params).toString();
  const res = await fetchImpl(url);
  let body = null;
  try { body = await res.json(); } catch { /* judged as unknown */ }
  return { status: res.status, body };
}

export async function checkOnce({ apiKey, channelId, fetchImpl = fetch }) {
  try {
    const uploads = await get(fetchImpl, 'playlistItems', {
      part: 'contentDetails', playlistId: uploadsPlaylist(channelId), maxResults: String(RECENT), key: apiKey,
    });
    // A wrong channel id fails here, as a 404 for the playlist: unknown, not off air.
    const bad = failure(uploads.status, uploads.body);
    if (bad) return bad;
    const ids = uploads.body.items.map((it) => it?.contentDetails?.videoId).filter(Boolean);
    if (!ids.length) return { state: OFF_AIR, reason: 'the channel has no uploads' };
    const videos = await get(fetchImpl, 'videos', { part: 'snippet', id: ids.join(','), key: apiKey });
    return judge(videos.status, videos.body);
  } catch (err) {
    return { state: UNKNOWN, reason: `request failed: ${err.message}` };
  }
}

// Check, and if the first answer is OFF_AIR, wait and ask again. Only two OFF_AIR answers
// in a row are an outage; anything else is the second answer.
export async function check({ recheckMs = RECHECK_MS, sleep = defaultSleep, ...opts }) {
  const first = await checkOnce(opts);
  if (first.state !== OFF_AIR) return first;
  await sleep(recheckMs);
  return checkOnce(opts);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The issue side. `gh` is a minimal GitHub REST caller so the tests can stand one in.
export async function reconcile(verdict, { gh, now = new Date() }) {
  if (verdict.state === UNKNOWN) return { action: 'none' };
  const open = (await gh('GET', '/issues?state=open&per_page=100'))
    .filter((i) => !i.pull_request && i.title === ALERT_TITLE);
  const stamp = now.toISOString();

  if (verdict.state === OFF_AIR) {
    if (open.length) return { action: 'none', issue: open[0].number };
    const created = await gh('POST', '/issues', {
      title: ALERT_TITLE,
      body: `The off-host check found no live broadcast on the channel at ${stamp}, `
        + `twice, ${RECHECK_MS / 60_000} minutes apart.\n\n`
        + 'Check the host: `systemctl is-active endless-memory-stream` and '
        + '`systemctl show -p NRestarts endless-memory-stream` (never `systemctl status`, which '
        + 'prints the stream key). If WSL itself is down, the Windows machine may have rebooted '
        + 'and be waiting for a login (ops/README.md, "The production host").\n\n'
        + 'This issue closes itself when the next check finds the station live.',
    });
    return { action: 'opened', issue: created.number };
  }

  for (const issue of open) {
    await gh('POST', `/issues/${issue.number}/comments`, {
      body: `Back on the air at ${stamp}: https://www.youtube.com/watch?v=${verdict.videoIds[0]}`,
    });
    await gh('PATCH', `/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
  }
  return { action: open.length ? 'closed' : 'none', issue: open[0]?.number };
}

function githubCaller({ token, repository, fetchImpl = fetch }) {
  return async (method, path, body) => {
    const res = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status}`);
    return res.json();
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { YOUTUBE_API_KEY, YOUTUBE_CHANNEL_ID, GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
  if (!YOUTUBE_API_KEY || !YOUTUBE_CHANNEL_ID) {
    console.error('onair: set YOUTUBE_API_KEY and YOUTUBE_CHANNEL_ID');
    process.exit(64);
  }
  const verdict = await check({ apiKey: YOUTUBE_API_KEY, channelId: YOUTUBE_CHANNEL_ID });
  // Never print the request URL: it carries the API key.
  console.log(`onair: ${verdict.state}${verdict.videoIds ? ` ${verdict.videoIds.join(' ')}` : ''}${verdict.reason ? ` (${verdict.reason})` : ''}`);
  if (GITHUB_TOKEN && GITHUB_REPOSITORY) {
    const result = await reconcile(verdict, { gh: githubCaller({ token: GITHUB_TOKEN, repository: GITHUB_REPOSITORY }) });
    console.log(`onair: issue ${result.action}${result.issue ? ` #${result.issue}` : ''}`);
  }
  process.exit(verdict.state === UNKNOWN ? 1 : 0);
}
