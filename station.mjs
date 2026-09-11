import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { BPM, BARS, BAR_MS, EPOCH, hash, pick, atmosphere, identity, scene, validate, patternSource } from './composer.mjs';
const dir = dirname(fileURLToPath(import.meta.url));
const [command='export', ...args] = process.argv.slice(2);
const path = resolve(dir,'journal.json');
const journal = validate(JSON.parse(await readFile(path,'utf8')));
if (command === 'weather' || command === 'remember') {
  const [value, at=new Date().toISOString()] = args;
  const event = {id:randomUUID(),at,type:command,...(command==='weather'?{value}:{motif:value})};
  journal.events.push(event);
  validate(journal);
  await writeFile(path, JSON.stringify(journal,null,2)+'\n');
  console.log('Saved. Export again to include this event.');
} else if (command === 'export') {
  const at = args[0] ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at)) || Date.parse(at)<EPOCH) throw Error('Choose a date on or after 2026-01-01');
  const startBar = Math.floor((Date.parse(at)-EPOCH)/BAR_MS);
  const prelude = `// Endless Memory v3 — synthesized sounds only. Paste into Strudel and play.\n// Score anchor: ${at}. UTC day phases. Replay starts here, not at the current clock.\nsetcps(${BPM}/60/4)\nconst BPM=${BPM}, BARS=${BARS}, BAR_MS=${BAR_MS}, EPOCH=${EPOCH};\nconst journal=${JSON.stringify(journal)};\n${hash.toString()}\n${pick.toString()}\n${atmosphere.toString()}\n${identity.toString()}\n${scene.toString()}\n`;
  // Generate source from the same tested model without eval or external network calls.
  const template = patternSource(scene(Math.floor(startBar/BARS), journal));
  const expression = template.replace(/"<[^"\n]*>"/g, token => {
    const s = scene(Math.floor(startBar/BARS),journal);
    const key=['chords','bass','melody','kicks','snares','hats'].find(k=>JSON.stringify(s[k])===token);
    return `mini(part.${key})`;
  }).replace(/\.lpf\(\d+\)(?=\.gain\(\.14\))/, '.lpf(part.cutoff)');
  const source = prelude + `const cache=new Map();\nconst startBar=${startBar};\nconst music=new Pattern(state=>{\n const begin=Number(state.span.begin), end=Number(state.span.end);\n const haps=[];\n for(let i=Math.floor((begin+startBar)/BARS);i<Math.ceil((end+startBar)/BARS);i++){\n  if(!cache.has(i)){const part=scene(i,journal);cache.set(i,${expression});}\n  const a=Math.max(begin,i*BARS-startBar), b=Math.min(end,(i+1)*BARS-startBar);\n  haps.push(...cache.get(i).early(startBar-i*BARS).queryArc(a,b));\n }\n if(cache.size>8){for(const k of cache.keys())if(k<Math.floor((begin+startBar)/BARS)-1)cache.delete(k);}\n return haps.map(hap=>{\n  const drift=atmosphere(Number((hap.whole || hap.part).begin)+startBar,journal);\n  return hap.withValue(value=>({...value, gain:value.gain*drift.gain, ...(value.gain===.14 ? {cutoff:drift.cutoff,release:drift.release} : {})}));\n });\n});\nmusic\n`;
  const safeSource = source.replace(/"(?:[^"\\]|\\.)*"/g, token => "'" + JSON.parse(token).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'");
  await writeFile(resolve(dir,'endless-memory.strudel'),safeSource);
  const score=[];
  for(let i=Math.floor(startBar/BARS); i<=Math.floor((startBar+45*60000/BAR_MS)/BARS); i++) {
    const {index,at,motif,previousMotif,transitioning,recalled,weather,weatherKnown,phase}=scene(i,journal);
    score.push({index,at,motif,previousMotif,transitioning,recalled,weather,weatherKnown,phase});
  }
  await writeFile(resolve(dir,'score-45min.json'),JSON.stringify(score,null,2)+'\n');
  await writeFile(resolve(dir,'listen.url'),`https://strudel.cc/#${Buffer.from(safeSource).toString('base64')}\n`);
  console.log(`Exported endless-memory.strudel and 45-minute score. Current motif: ${score[0].motif}`);
} else throw Error('Use export [ISO date], weather clear|cloudy|rain|snow [ISO date], or remember mID [ISO date]');
