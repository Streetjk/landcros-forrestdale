import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSharedSceneBundle} from '../scene-bundle-loader.js';

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
  assert.deepEqual(calls,[url,url,url]);
  assert.equal(result.data,null);
});
