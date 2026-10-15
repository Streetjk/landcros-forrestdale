import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadSharedScenePinPreview,sanitizeSharedScenePinPreview} from '../shared-scene-pin-preview.js';

const runtime={
  siteSlug:'landcros',
  supabaseUrl:'https://example.supabase.co',
  supabasePublishableKey:'sb_publishable_'+'x'.repeat(32),
};
const label=(id='00000000-0000-4000-a000-000000000001')=>({
  id,kind:'label',transform:{position:[1.5,0,-6]},props:{text:'Shared label',description:'Authorized public description'},
});
const src=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');

test('share code is bound to the configured site and calls only the restricted Supabase RPC',async()=>{
  const calls=[];
  const result=await loadSharedScenePinPreview(runtime,'ic48ij45q9',{
    fetchFn:async(url,options)=>{
      calls.push({url,options});
      return {ok:true,json:async()=>({objects:[label()]})};
    },
  });
  assert.equal(result?.objects?.length,1);
  assert.deepEqual(result.objects[0],label());
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://example.supabase.co/rest/v1/rpc/sitenav_shared_scene_pin_preview');
  assert.equal(calls[0].options.method,'POST');
  assert.equal(calls[0].options.headers.apikey,runtime.supabasePublishableKey);
  assert.equal(calls[0].options.cache,'no-store');
  assert.equal(calls[0].options.referrerPolicy,'no-referrer');
  assert.deepEqual(JSON.parse(calls[0].options.body),{p_code:'ic48ij45q9',p_site_slug:'landcros'});
  assert.ok(!/service_role|private|script|scene_id/.test(calls[0].options.body));
});

test('invalid codes, missing configuration, and My Pins-style input never trigger a preview request',async()=>{
  let calls=0;
  for(const code of ['',null,'abc','INVALID123','../../bad','ic48ij45q9-extra']){
    assert.equal(await loadSharedScenePinPreview(runtime,code,{fetchFn:async()=>{calls++;throw Error('unexpected')}}),null);
  }
  assert.equal(await loadSharedScenePinPreview({...runtime,supabasePublishableKey:''},'ic48ij45q9',{fetchFn:async()=>{calls++;throw Error('unexpected')}}),null);
  assert.equal(await loadSharedScenePinPreview({...runtime,siteSlug:'other/invalid'},'ic48ij45q9',{fetchFn:async()=>{calls++;throw Error('unexpected')}}),null);
  assert.equal(calls,0);
});

test('anonymous preview rejects contaminated or excessive scene data instead of leaking extra fields',()=>{
  const valid={objects:[label()]};
  assert.deepEqual(sanitizeSharedScenePinPreview(valid),valid);
  assert.equal(sanitizeSharedScenePinPreview({objects:[{...label(),props:{text:'Label',photoUrl:'https://private.example/photo'}}]}).objects[0].props.photoUrl,undefined);
  for(const invalid of [
    null,{}, {objects:[{...label(),kind:'hazard'}]},
    {objects:[{...label(),id:'not-a-uuid'}]},
    {objects:[{...label(),transform:{position:[0,NaN,1]}}]},
    {objects:[{...label(),transform:{position:[0,0,201]}}]},
    {objects:[{...label(),props:{text:'X'.repeat(161)}}]},
    {objects:[{...label(),props:{text:'Label',description:'X'.repeat(4001)}}]},
    {objects:[{...label(),props:{text:'Label',description:{private:true}}}]},
    {objects:[label(),label()]}, {objects:Array.from({length:26},(_,i)=>label('00000000-0000-4000-a000-'+String(i+1).padStart(12,'0')))},
  ])assert.equal(sanitizeSharedScenePinPreview(invalid),null);
});

test('invalid/forbidden/failed RPC results never escalate to a broader anonymous query',async()=>{
  for(const status of [401,403,404,429,500,503]){
    let attempts=0;
    const got=await loadSharedScenePinPreview(runtime,'ic48ij45q9',{fetchFn:async()=>{attempts++;return{ok:false,status}}});
    assert.equal(got,null);
    assert.equal(attempts,1);
  }
  assert.equal((await loadSharedScenePinPreview(runtime,'ic48ij45q9',{fetchFn:async()=>({ok:true,json:async()=>null})})),null);
});

test('abort is bounded and cleaned up without persistent timers or storage',async()=>{
  const started=Date.now();
  const result=await loadSharedScenePinPreview(runtime,'ic48ij45q9',{
    timeoutMs:20,
    fetchFn:(_url,{signal})=>new Promise((_,reject)=>{
      signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
    }),
  });
  assert.equal(result,null);
  assert.ok(Date.now()-started<750);
});

test('SQL RPC permits only admin shared labels and no direct anonymous scene table access',()=>{
  const sql=src('supabase/migrations/0021_shared_scene_pin_preview.sql');
  assert.match(sql,/security definer/i);
  assert.match(sql,/set search_path = ''/);
  assert.match(sql,/s\.kind = 'admin'/);
  assert.match(sql,/coalesce\(s\.camera ->> 'purpose', ''\) <> 'my-pins-v1'/);
  assert.match(sql,/obj\.scene_id = s\.id/);
  assert.match(sql,/obj\.site_id = s\.site_id/);
  assert.match(sql,/site\.slug = p_site_slug/);
  assert.match(sql,/grant execute on function public\.sitenav_shared_scene_pin_preview\(text, text\)\s+to anon/i);
  assert.doesNotMatch(sql,/grant\s+select\s+on\s+.*scene_objects/i);
  assert.doesNotMatch(sql,/\b(photoUrls|photoUrl|description|script_source|phone|contact_ids)\b/);
  const grants=src('supabase/migrations/0022_revoke_anon_scene_table_grants.sql');
  assert.match(grants,/revoke all privileges on table[\s\S]*public\.scenes,[\s\S]*public\.scene_objects,[\s\S]*public\.scripts[\s\S]*from anon;/i);
});

test('viewer starts Supabase preview before the scene build, reconciles full data, and keeps vanilla private',()=>{
  const viewer=src('viewer3d.js');
  const code=viewer.slice(viewer.indexOf('async function boot()'));
  assert.ok(code.indexOf('loadSharedScenePinPreview(')<code.indexOf('fetch(\'./data/config.json\')'));
  assert.match(viewer,/renderSceneWidgets\(preview\.objects,\{preview:true\}\)/);
  assert.match(viewer,/existing\.obj = obj/);
  assert.match(viewer,/existing\.preview = false/);
  assert.match(viewer,/if \(entry\.preview && !freshIds\.has\(id\)\) _removeSceneWidget\(id,entry\)/);
  assert.match(code,/_scopedPreviewForReveal\?\.objects\?\.length/);
  assert.match(viewer,/_params\.has\('id'\)/);
  assert.match(viewer,/!_publicMyPinMode/);
  for(const html of ['index.html','viewer3d.html']){
    assert.match(src(html),/viewer3d\.js\?v=scene-detail-hydrate-20261015a/);
  }
});
