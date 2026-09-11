import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '@strudel/core';
import { miniAllStrings, mini } from '@strudel/mini';
import { transpiler } from '@strudel/transpiler';
import { atmosphere, scene, EPOCH, BAR_MS, BARS, validate } from './composer.mjs';
// Match the REPL: generated strings require explicit mini() parsing.
core.setStringParser(core.pure);
const journal={version:1,seed:'test',events:[]};
test('queries are deterministic and future inputs cannot rewrite history',()=>{
 const before=scene(4,journal);
 const later={...journal,events:[{id:'rain',type:'weather',value:'rain',at:new Date(EPOCH+5*BARS*BAR_MS).toISOString()}]};
 assert.deepEqual(scene(4,later),before);
 assert.equal(scene(6,later).weather,'rain');
 assert.deepEqual(scene(4,journal),before);
});
test('remembered motifs return without replacing every new theme',()=>{
 const j={...journal,events:[{id:'memory',type:'remember',motif:'m123',at:new Date(EPOCH).toISOString()}]};
 const scenes=Array.from({length:100},(_,i)=>scene(i,j));
 assert(scenes.some(s=>s.motif==='m123' && s.recalled));
 assert(scenes.some(s=>!s.recalled));
 assert.throws(()=>validate({...journal,events:[{id:'bad',at:'invalid',type:'weather',value:'rain'}]}));
});
test('actual Strudel score emits bounded events across 45 minutes and random seeks',()=>{
 const source=readFileSync(new URL('./endless-memory.strudel',import.meta.url),'utf8');
 const names=['Pattern','stack','note','s'];
 const {output} = transpiler(source, {wrapAsync:false, addReturn:true});
 const pattern=new Function(...names,'setcps','mini',output)(...names.map(n=>core[n]),()=>{},mini);
 let count=0;
 for(let bar=0;bar<855;bar++){
   const events=pattern.queryArc(bar,bar+1);
   assert(events.length>0 && events.length<120);
   for(const e of events){if(e.value.note !== undefined) assert(Number.isFinite(Number(e.value.note)), 'Note must be an individual numeric pitch');assert(Number(e.part.begin)>=bar);assert(Number(e.part.end)<=bar+1);}
   count+=events.length;
 }
 const first=pattern.queryArc(0,1).map(e=>e.value);
 pattern.queryArc(1000000,1000001);
 assert.deepEqual(pattern.queryArc(0,1).map(e=>e.value),first);
 console.log(`Validated ${count} musical events.`);
});

test('weather eases in causally and drift stays small across boundaries',()=>{
 const boundary=320;
 const j={...journal,events:[{id:'rain',type:'weather',value:'rain',at:new Date(EPOCH+boundary*BAR_MS).toISOString()}]};
 assert.deepEqual(atmosphere(boundary-1,j),atmosphere(boundary-1,journal));
 assert.equal(atmosphere(boundary,j).cutoff,atmosphere(boundary,journal).cutoff);
 assert(Math.abs(atmosphere(boundary+.001,j).cutoff-atmosphere(boundary-.001,j).cutoff)<.1);
 assert(atmosphere(boundary+250,j).cutoff < 1300);
 for(let b=0;b<1000;b++){
   const a=atmosphere(b,j);
   assert(a.gain>=.975 && a.gain<=1.025);
   assert(Math.abs(a.cutoff-atmosphere(b+.01,j).cutoff)<1);
 }
});
test('a new weather theme begins with the existing melody, then changes gradually',()=>{
 const index=10;
 const j={...journal,events:[{id:'new-rain',type:'weather',value:'rain',at:new Date(EPOCH+index*BARS*BAR_MS).toISOString()}]};
 const unchanged=scene(index,journal), changed=scene(index,j);
 assert(changed.transitioning);
 assert.notEqual(changed.motif,unchanged.motif);
 const pitches=(score,a,b)=>mini(score.melody).queryArc(a,b).map(h=>h.value);
 assert.deepEqual(pitches(changed,0,1),pitches(unchanged,0,1));
 assert.notDeepEqual(pitches(changed,24,25),pitches(unchanged,24,25));
 assert.deepEqual(scene(index,j),changed);
});
