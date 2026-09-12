// Golden audio fixture: definition, hashing, and the regenerate entry point.
// Run deliberately with `npm run golden`, and review the resulting diff.

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { BARS } from '../composer.mjs';
import { renderChunk } from './render.mjs';

export const GOLDEN = {
  startCycle: 216813 * BARS,
  cycles: 8,
  journal: { version: 1, seed: 'window-seat-v1', events: [] },
};

export function pcmHash(samples) {
  const hash = createHash('sha256');
  let peak = 0;
  let sumSq = 0;
  const view = new DataView(new ArrayBuffer(4));
  for (const v of samples) {
    view.setFloat32(0, v);
    hash.update(new Uint8Array(view.buffer));
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  return {
    hash: hash.digest('hex'),
    peak: Math.round(peak * 1e9) / 1e9,
    rms: Math.round(Math.sqrt(sumSq / samples.length) * 1e9) / 1e9,
    samples: samples.length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = pcmHash(renderChunk(GOLDEN.startCycle, GOLDEN.cycles, GOLDEN.journal));
  writeFileSync(new URL('./fixtures/golden-quiet.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(`golden-quiet: ${result.samples} samples, peak ${result.peak}, rms ${result.rms}`);
}
