import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadSharedSceneBundle,SHARED_SCENE_RETRY_DELAYS_MS} from '../scene-bundle-loader.js';

test('both public viewer routes cache-bust the shared scene retry loader',()=>{
  const viewer=readFileSync(new URL('../viewer3d.js',import.meta.url),'utf8');
  assert.match(viewer,/scene-bundle-loader\.js\?v=scene-firstload-retry-20261015c/);
  for(const html of ['index.html','viewer3d.html']){
    const src=readFileSync(new URL('../'+html,import.meta.url),'utf8');
    assert.match(src,/viewer3d\.js\?v=scene-detail-hydrate-20261015a/);
  }
});

const url='/api/scenes/by-code/scope-code';
test('first success returns exact scene data with one private-code request',async()=>{
  const calls=[];
  const data={scene:{name:'Roller Door'},objects:[{id:'p'}]};
  const got=await loadSharedSceneBundle(url,{
    fetchFn:async (link,opts)=>{calls.push([link,opts]);return{ok:true,status:200,json:async()=>data}},
    wait:async()=>{throw Error('unexpected retry')},
  });
  assert.deepEqual(got,{status:200,data});
  assert.deepEqual(calls.map(x=>x[0]),[url]);
  assert.equal(calls[0][1].cache,'no-store');
});

test('transient 503 and failed connection retry, with bounded backoff',async()=>{
  const calls=[],delays=[];
  const result=await loadSharedSceneBundle(url,{
    fetchFn:async()=>{
      calls.push(1);
      if(calls.length===1)return{status:503,ok:false};
      if(calls.length===2)throw Error('ECONNRESET');
      return{status:200,ok:true,json:async()=>({scene:{name:'Recovered'},objects:[]})};
    },
    wait:async(ms)=>delays.push(ms),
  });
  assert.equal(calls.length,3);
  assert.deepEqual(delays,[650,1500]);
  assert.equal(result.data.scene.name,'Recovered');
});

test('Render cold start: first three temporary failures recover without page reload',async()=>{
  let calls=0;
  const delays=[];
  const expected={scene:{name:'Shared guide'},objects:[{id:'scene-label',kind:'label'}]};
  const result=await loadSharedSceneBundle(url,{
    fetchFn:async()=>++calls<=3
      ? {status:503,ok:false}
      : {status:200,ok:true,json:async()=>expected},
    wait:async(ms)=>delays.push(ms),
  });
  assert.equal(calls,4);
  assert.deepEqual(delays,SHARED_SCENE_RETRY_DELAYS_MS.slice(0,3));
  assert.deepEqual(result,{status:200,data:expected});
});

test('bounded long cold start recovers after multiple 504 responses',async()=>{
  let calls=0;
  const result=await loadSharedSceneBundle(url,{
    fetchFn:async()=>++calls<=6
      ? {status:504,ok:false}
      : {status:200,ok:true,json:async()=>({objects:[{kind:'label'}]})},
    wait:async()=>{},
  });
  assert.equal(calls,7);
  assert.equal(result.status,200);
  assert.equal(result.data.objects.length,1);
});

for(const status of [400,401,403,404,410,422])test('does not retry access denied/not-found status '+status,async()=>{
  let calls=0;
  const result=await loadSharedSceneBundle(url,{fetchFn:async()=>{calls++;return{status,ok:false}},
    wait:async()=>{throw Error('must not retry')}});
  assert.equal(calls,1);
  assert.equal(result.data,null);
  assert.equal(result.status,status);
});

test('does not silently return other scene after invalid JSON',async()=>{
  const result=await loadSharedSceneBundle(url,{fetchFn:async()=>({status:200,ok:true,json:async()=>[]}),
    wait:async()=>{}});
  assert.equal(result.data,null);
});

test('permanent transport failure is finite, no fallback endpoint',async()=>{
  const calls=[];
  const result=await loadSharedSceneBundle(url,{
    fetchFn:async(link)=>{calls.push(link);throw Error('DNS')},
    wait:async()=>{},
  });
  assert.equal(calls.length,SHARED_SCENE_RETRY_DELAYS_MS.length+1);
  assert.ok(calls.every(call=>call===url),'no alternate or wider-scoped endpoint');
  assert.equal(result.data,null);
});
