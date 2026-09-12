import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { BPM, BARS, BAR_MS, EPOCH, hash, pick, atmosphere, identity, scene, validate, patternSource, gainSource } from './composer.mjs';
// Strudel's transpiler reads double-quoted strings and backticks as
// mini-notation, so every string in the generated source has to be
// single-quoted. That rule is applied here, while each literal is built, not by
// rewriting the finished source. The five functions the prelude embeds via
// `.toString()` are single-quoted in composer.mjs and must stay that way —
// nothing rewrites them on the way out any more.
const jsString = s => "'" + s
  .replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r') + "'";
// `journal` is JSON.parse output, so the JSON types are all this has to cover.
function jsLiteral(value) {
  if (typeof value === 'string') return jsString(value);
  if (Array.isArray(value)) return '[' + value.map(v => jsLiteral(v)).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).map(([k,v]) => jsString(k) + ':' + jsLiteral(v)).join(',') + '}';
  }
  return JSON.stringify(value);
}
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
  const prelude = `// Endless Memory v3 — synthesized sounds only. Paste into Strudel and play.\n// Score anchor: ${at}. UTC day phases. Replay starts here, not at the current clock.\nsetcps(${BPM}/60/4)\nconst BPM=${BPM}, BARS=${BARS}, BAR_MS=${BAR_MS}, EPOCH=${EPOCH};\nconst journal=${jsLiteral(journal)};\n${hash.toString()}\n${pick.toString()}\n${atmosphere.toString()}\n${identity.toString()}\n${scene.toString()}\n`;
  // Generate source from the same tested model without eval or external network calls.
  // patternSource() assembles the stack straight from the VOICES table, so the
  // `part.<field>` reads and the chords' `part.cutoff` come out of structured
  // data rather than being matched back out of rendered text.
  const expression = patternSource();
  const source = prelude + `const cache=new Map();\nconst startBar=${startBar};\nconst music=new Pattern(state=>{\n const begin=Number(state.span.begin), end=Number(state.span.end);\n const haps=[];\n for(let i=Math.floor((begin+startBar)/BARS);i<Math.ceil((end+startBar)/BARS);i++){\n  if(!cache.has(i)){const part=scene(i,journal);cache.set(i,${expression});}\n  const a=Math.max(begin,i*BARS-startBar), b=Math.min(end,(i+1)*BARS-startBar);\n  haps.push(...cache.get(i).early(startBar-i*BARS).queryArc(a,b));\n }\n if(cache.size>8){for(const k of cache.keys())if(k<Math.floor((begin+startBar)/BARS)-1)cache.delete(k);}\n return haps.map(hap=>{\n  const drift=atmosphere(Number((hap.whole || hap.part).begin)+startBar,journal);\n  return hap.withValue(value=>({...value, gain:value.gain*drift.gain, ...(value.gain===${gainSource('chords')} ? {cutoff:drift.cutoff,release:drift.release} : {})}));\n });\n});\nmusic\n`;
  await writeFile(resolve(dir,'endless-memory.strudel'),source);
  const score=[];
  for(let i=Math.floor(startBar/BARS); i<=Math.floor((startBar+45*60000/BAR_MS)/BARS); i++) {
    const {index,at,motif,previousMotif,transitioning,recalled,weather,weatherKnown,phase}=scene(i,journal);
    score.push({index,at,motif,previousMotif,transitioning,recalled,weather,weatherKnown,phase});
  }
  await writeFile(resolve(dir,'score-45min.json'),JSON.stringify(score,null,2)+'\n');
  await writeFile(resolve(dir,'listen.url'),`https://strudel.cc/#${Buffer.from(source).toString('base64')}\n`);
  console.log(`Exported endless-memory.strudel and 45-minute score. Current motif: ${score[0].motif}`);
} else throw Error('Use export [ISO date], weather clear|cloudy|rain|snow [ISO date], or remember mID [ISO date]');
