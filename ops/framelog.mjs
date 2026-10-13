// Reads the JSON log `node ops/videoframe.mjs run` writes to stderr and answers the two
// piece D acceptance criteria that only a long run against the live camera can:
//
//   3. Poll behaviour is observed, not intended: no more than one request per 60 s, and
//      the great majority of polls that find nothing new return 304.
//   8. Night is measured over a full 24 hours: smoothed glyph churn stays at or below 8%
//      through the overnight hours.
//
// Since camera ink (2026-10-12) the log also carries `inkShift`, where sticky glyphs
// move night noise to. It is reported per hour beside churn but gates nothing yet.
//
// Pure apart from the CLI at the bottom, so ops/framelog.test.mjs drives it with
// synthetic logs. Specified in docs/superpowers/specs/2026-09-14-visual-layer-design.md.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MIN_POLL_GAP_S = 60;
export const NIGHT_CHURN_BAR = 0.08;
// "Overnight": the hours the spec's 21:00 observation did not reach, ending before dawn.
export const NIGHT_HOURS = [0, 1, 2, 3, 4, 5];
export const TIME_ZONE = 'America/New_York';

// Lines that are not JSON (a Node warning, a stack trace from a crash and restart) are
// counted and skipped rather than failing the whole report.
export function parseLog(text) {
  const events = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.at === 'string' && typeof e.event === 'string') events.push(e);
      else skipped++;
    } catch { skipped++; }
  }
  return { events, skipped };
}

const hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23' });
export const localHour = (iso) => Number(hourFormat.format(new Date(iso)));

function quantile(values, q) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))];
}

export function summarise(events) {
  const polls = events.filter((e) => e.event === 'poll');
  const results = {};
  for (const p of polls) results[p.result] = (results[p.result] || 0) + 1;

  // Gaps are measured within one process lifetime: a crash and restart polls at once,
  // and that first poll is a fresh process, not a second request inside the minute.
  let minGapS = null;
  let tooFast = 0;
  let previous = null;
  for (const e of events) {
    if (e.event === 'start') { previous = null; continue; }
    if (e.event !== 'poll') continue;
    const t = Date.parse(e.at);
    if (previous !== null) {
      const gap = (t - previous) / 1000;
      if (minGapS === null || gap < minGapS) minGapS = gap;
      if (gap < MIN_POLL_GAP_S) tooFast++;
    }
    previous = t;
  }

  // A 304 and a 200 carrying bytes already held both mean "nothing new"; only the first
  // costs the camera nothing, so the share of 304s among them is the politeness figure.
  const nothingNew = (results.unchanged || 0) + (results.repeat || 0);
  const notModifiedShare = nothingNew ? (results.unchanged || 0) / nothingNew : null;

  const byHour = Array.from({ length: 24 }, () => ({ churn: [], span: [], inkShift: [] }));
  for (const p of polls) {
    if (p.result !== 'frame') continue;
    const h = byHour[localHour(p.at)];
    if (typeof p.churn === 'number') h.churn.push(p.churn);
    if (typeof p.span === 'number') h.span.push(p.span);
    if (typeof p.inkShift === 'number') h.inkShift.push(p.inkShift);
  }
  const hours = byHour.map((h, hour) => ({
    hour,
    frames: h.churn.length,
    medianChurn: quantile(h.churn, 0.5),
    p90Churn: quantile(h.churn, 0.9),
    medianSpan: quantile(h.span, 0.5),
    medianInkShift: quantile(h.inkShift, 0.5),
  }));

  const night = hours.filter((h) => NIGHT_HOURS.includes(h.hour));
  const uncovered = night.filter((h) => h.frames === 0).map((h) => h.hour);
  const overBar = night.filter((h) => h.medianChurn !== null && h.medianChurn > NIGHT_CHURN_BAR).map((h) => h.hour);

  const starts = events.filter((e) => e.event === 'start');
  const first = events[0]?.at ?? null;
  const last = events[events.length - 1]?.at ?? null;

  return {
    first,
    last,
    hours: first && last ? (Date.parse(last) - Date.parse(first)) / 3_600_000 : 0,
    starts: starts.length,
    userAgent: starts[0]?.userAgent ?? null,
    polls: polls.length,
    results,
    minGapS,
    tooFast,
    notModifiedShare,
    transitions: events.filter((e) => e.event === 'state').map((e) => ({ at: e.at, from: e.from, to: e.to })),
    byHour: hours,
    criterion3: {
      ok: polls.length > 0 && tooFast === 0 && notModifiedShare !== null && notModifiedShare > 0.5,
    },
    criterion8: {
      ok: uncovered.length === 0 && overBar.length === 0,
      uncovered,
      overBar,
    },
  };
}

const pct = (v) => (v === null ? '-' : `${(v * 100).toFixed(1)}%`);

export function formatReport(s, skipped = 0) {
  const lines = [];
  lines.push(`Log: ${s.first} to ${s.last} (${s.hours.toFixed(1)} h), ${s.starts} process start(s), ${skipped} non-JSON line(s) skipped`);
  lines.push(`User-Agent sent: ${s.userAgent ?? 'not logged'}`);
  lines.push('');
  lines.push(`Criterion 3, polling: ${s.criterion3.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`  polls ${s.polls}: ${Object.entries(s.results).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  lines.push(`  shortest gap between requests ${s.minGapS === null ? '-' : `${s.minGapS.toFixed(1)} s`}; gaps under ${MIN_POLL_GAP_S} s: ${s.tooFast}`);
  lines.push(`  polls that found nothing new and cost only a 304: ${pct(s.notModifiedShare)}`);
  lines.push('');
  lines.push(`Criterion 8, overnight churn at or below ${pct(NIGHT_CHURN_BAR)}: ${s.criterion8.ok ? 'PASS' : 'FAIL'}`);
  if (s.criterion8.uncovered.length) lines.push(`  no frames logged at local hour(s) ${s.criterion8.uncovered.join(', ')}; the run did not cover the night`);
  if (s.criterion8.overBar.length) lines.push(`  median churn over the bar at local hour(s) ${s.criterion8.overBar.join(', ')}`);
  lines.push(`  hour (${TIME_ZONE})  frames  median churn  p90 churn  median span  median ink shift`);
  for (const h of s.byHour) {
    if (!h.frames) continue;
    lines.push(`  ${String(h.hour).padStart(2, '0')}:00              ${String(h.frames).padStart(4)}  ${pct(h.medianChurn).padStart(12)}  ${pct(h.p90Churn).padStart(9)}  ${(h.medianSpan === null ? '-' : String(h.medianSpan)).padStart(11)}  ${pct(h.medianInkShift).padStart(16)}`);
  }
  lines.push('');
  lines.push(`Ladder transitions: ${s.transitions.length ? '' : 'none'}`);
  for (const t of s.transitions) lines.push(`  ${t.at}  ${t.from} -> ${t.to}`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) { console.error('usage: node ops/framelog.mjs <videoframe.log>'); process.exit(64); }
  const { events, skipped } = parseLog(readFileSync(path, 'utf8'));
  const s = summarise(events);
  console.log(formatReport(s, skipped));
  process.exitCode = s.criterion3.ok && s.criterion8.ok ? 0 : 1;
}
