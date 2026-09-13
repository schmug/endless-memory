import test from 'node:test';
import assert from 'node:assert/strict';
import {
  median,
  linearSlope,
  analyse,
  meteringSink,
  MAX_RSS_SLOPE_BYTES_PER_HOUR,
} from './endurance.mjs';

const MB = 1024 * 1024;

// Build a sample series over `hours`, `perHour` samples an hour, where rss(h) is
// whatever the caller's function returns. heapUsed tracks rss here; the analyser
// treats them independently, and only rss decides the verdict.
function series(hours, perHour, rssAt) {
  const out = [];
  for (let i = 1; i <= hours * perHour; i++) {
    const h = i / perHour;
    out.push({ hours: h, rss: rssAt(h, i), heapUsed: rssAt(h, i) / 2 });
  }
  return out;
}

// A GC sawtooth: allocation climbs, collection drops it back. Deterministic, so a
// failure is reproducible rather than a flake.
const sawtooth = (i, depth = 8 * MB) => (i % 7) * (depth / 7);

test('median returns the middle of an odd list and the mean of the middle two of an even one', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5]), 5);
  assert.ok(Number.isNaN(median([])));
});

test('linearSlope recovers a known slope and refuses points that determine no line', () => {
  assert.equal(linearSlope([{ x: 0, y: 10 }, { x: 1, y: 12 }, { x: 2, y: 14 }]), 2);
  assert.equal(linearSlope([{ x: 0, y: 5 }, { x: 3, y: 5 }]), 0);
  assert.ok(Number.isNaN(linearSlope([{ x: 1, y: 1 }])), 'one point is not a line');
  assert.ok(Number.isNaN(linearSlope([{ x: 1, y: 1 }, { x: 1, y: 9 }])), 'a vertical pair is not a line');
});

// The regression this whole script exists to avoid (#13): a whole-run linear fit on
// this project once reported "+111 MB/day" for a process that was flat after
// warm-up. Fitting on per-phase medians and excluding warm-up phases must read such
// a series as flat, while the whole-run figure still carries the warm-up climb —
// the report prints both so the gap is visible rather than a matter of trust.
test('a run that is flat after warm-up reads as flat, and the whole-run fit does not', () => {
  const flatAfterWarmup = series(24, 20, (h) => {
    const base = h < 3 ? 40 * MB + (h / 3) * 50 * MB : 90 * MB;
    return base + sawtooth(Math.round(h * 20));
  });

  const result = analyse(flatAfterWarmup, { totalHours: 24, phaseCount: 8, warmupPhases: 1 });

  assert.ok(
    Math.abs(result.rssSlopeBytesPerHour) < 0.05 * MB,
    `post-warm-up slope should be flat, got ${result.rssSlopeBytesPerHour / MB} MB/h`,
  );
  // A 50 MB warm-up over a 24 h run inflates the whole-run figure by >12 MB/day on
  // a process that grew not at all after hour 3.
  assert.ok(
    result.wholeRunRssSlopeBytesPerHour > 0.5 * MB,
    `the whole-run fit should carry the warm-up climb, got ${result.wholeRunRssSlopeBytesPerHour / MB} MB/h`,
  );
});

// The same shape, with the warm-up amplified until the distortion crosses the
// budget: the magnitude is synthetic, the failure mode is not. Without warm-up
// exclusion this flat process is reported as a leak.
test('warm-up exclusion is what keeps a steep warm-up from failing a flat run', () => {
  const steepWarmup = series(24, 20, (h) => (h < 3 ? 40 * MB + (h / 3) * 210 * MB : 250 * MB));

  const withWarmup = analyse(steepWarmup, { totalHours: 24, phaseCount: 8, warmupPhases: 0 });
  const withoutWarmup = analyse(steepWarmup, { totalHours: 24, phaseCount: 8, warmupPhases: 1 });

  assert.ok(
    withWarmup.rssSlopeBytesPerHour > MAX_RSS_SLOPE_BYTES_PER_HOUR,
    `including warm-up should exceed the budget, got ${withWarmup.rssSlopeBytesPerHour / MB} MB/h`,
  );
  assert.ok(
    Math.abs(withoutWarmup.rssSlopeBytesPerHour) < 0.05 * MB,
    `excluding it should read flat, got ${withoutWarmup.rssSlopeBytesPerHour / MB} MB/h`,
  );
});

test('a genuine post-warm-up leak is detected', () => {
  const leaking = series(24, 20, (h) => {
    const warm = h < 3 ? 40 * MB + (h / 3) * 50 * MB : 90 * MB;
    const leak = h < 3 ? 0 : (h - 3) * 10 * MB;
    return warm + leak + sawtooth(Math.round(h * 20));
  });

  const result = analyse(leaking, { totalHours: 24, phaseCount: 8, warmupPhases: 1 });

  assert.ok(
    result.rssSlopeBytesPerHour > MAX_RSS_SLOPE_BYTES_PER_HOUR,
    `a 10 MB/h leak must exceed the budget, got ${result.rssSlopeBytesPerHour / MB} MB/h`,
  );
});

test('a sawtooth with no underlying trend does not read as growth', () => {
  // Amplitude far above the budget, so a fit that tracked raw samples rather than
  // per-phase medians would be at the mercy of where each phase happened to end.
  const noisy = series(24, 20, (_h, i) => 90 * MB + sawtooth(i, 60 * MB));
  const result = analyse(noisy, { totalHours: 24, phaseCount: 8, warmupPhases: 1 });
  assert.ok(
    Math.abs(result.rssSlopeBytesPerHour) < MAX_RSS_SLOPE_BYTES_PER_HOUR,
    `sawtooth noise should not read as a trend, got ${result.rssSlopeBytesPerHour / MB} MB/h`,
  );
});

test('phases partition the run and every sample lands in exactly one', () => {
  const samples = series(24, 10, () => 90 * MB);
  const { phases } = analyse(samples, { totalHours: 24, phaseCount: 8, warmupPhases: 1 });
  assert.equal(phases.length, 8);
  assert.equal(phases.reduce((n, p) => n + p.samples, 0), samples.length);
  assert.equal(phases[0].fromHours, 0);
  assert.equal(phases.at(-1).toHours, 24);
});

test('the sink counts silent chunks independently of the renderer that produced them', async () => {
  const sink = meteringSink();
  const loud = Buffer.alloc(400);
  loud.writeInt16LE(1234, 200);
  sink.stream.write(loud);
  sink.stream.write(Buffer.alloc(400));
  sink.stream.end();

  assert.equal(sink.chunks, 2);
  assert.equal(sink.silentChunks, 1, 'an all-zero chunk is silent');
  assert.equal(sink.bytes, 800);
  assert.equal(sink.samples.length, 2);
});
