import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const viewer = readFileSync(new URL('../viewer3d.js', import.meta.url), 'utf8');
const start = viewer.indexOf('const editorSurface = !!document.getElementById(');
const end = viewer.indexOf('const sv = new GS3D.Viewer(', start);
assert.ok(start !== -1 && end > start, 'Splat GPU/CPU decision must be present');
// Evaluate exactly the production decision, with only browser feature inputs mocked.
const logic = viewer.slice(start, end);
const decide = new Function('document', 'self', 'SharedArrayBuffer',
  '_perfEnabled', '_perfParams', 'navigator', '_perf',
  'return (async () => { ' + logic +
    ' return { gpuSortOk, sharedMemOk, editorSurface }; })()');

function check({ editor=true, isolated=true, userAgent='Chrome', brave=false,
                  pref=null, throws=false }={}) {
  const events = [];
  const document = { getElementById: () => editor ? {} : null };
  const navigator = { userAgent };
  if (brave) navigator.brave = { isBrave: async () => {
    if (throws) throw Error('browser denied detection');
    return true;
  } };
  return decide(document, {crossOriginIsolated:isolated},
    isolated ? ArrayBuffer : undefined,
    !!pref, {get:()=>pref},
    navigator,{mark:(name,info)=>events.push([name,info])})
    .then(result=>({ ...result,events }));
}
test('editor uses the shared CPU worker by default on Chrome',async()=>{
  const r=await check();
  assert.equal(r.editorSurface,true);
  assert.equal(r.sharedMemOk,true);
  assert.equal(r.gpuSortOk,false);
  assert.deepEqual(r.events[0][1],{ mode:'cpu',editor:true,sharedMemory:true });
});
test('public viewers retain GPU sorting when supported',async()=>{
  assert.equal((await check({editor:false})).gpuSortOk,true);
});
test('without shared worker memory standard Chrome retains GPU fallback',async()=>{
  const r=await check({isolated:false});
  assert.equal(r.sharedMemOk,false);
  assert.equal(r.gpuSortOk,true);
});
test('Edge, Brave, and uncertain detection fall back to CPU regardless of override',async()=>{
  assert.equal((await check({userAgent:'Edg/155',pref:'1'})).gpuSortOk,false);
  assert.equal((await check({brave:true,pref:'1'})).gpuSortOk,false);
  assert.equal((await check({brave:true,throws:true,pref:'1'})).gpuSortOk,false);
});
test('opt-in performance experiments can compare sort paths without changing user defaults',async()=>{
  assert.equal((await check({pref:'1'})).gpuSortOk,true);
  assert.equal((await check({editor:false,pref:'0'})).gpuSortOk,false);
});
