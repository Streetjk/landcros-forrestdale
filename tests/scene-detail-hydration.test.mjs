import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url),'utf8');
const source = read('viewer3d.js');
const hydration = source.slice(
  source.indexOf('function _hydrateOpenSceneLabelDetails()'),
  source.indexOf('// Hazard pin detail:',source.indexOf('function _hydrateOpenSceneLabelDetails()')),
);
const UUID = '00000000-0000-4000-a000-000000000001';

function harness({selectedId=UUID,entryId=UUID,preview=false,stage='summary',key='scene:'+UUID,visible=true,compact=true}={}) {
  const touched=[];
  let refresh=0;
  const detail={dataset:{sceneLabelId:selectedId},classList:{contains:className=>className==='visible'&&visible}};
  const entry={preview,obj:{kind:'label',id:entryId,props:{text:'Authorized title',description:'Hydrated body'}}};
  const mobile={
    isCompact:()=>compact,
    snapshot:()=>({stage,key}),
    refresh:()=>{refresh++},
    open:()=>{throw Error('hydration must not reopen the panel')},
    repeat:()=>{throw Error('hydration must not simulate another tap')},
  };
  const context={document:{getElementById:id=>id==='point-detail'?detail:null},_sceneWidgets:new Map([[entryId,entry]]),
    _mobileDetails:mobile,_renderSceneLabelBody:obj=>touched.push(obj)};
  vm.runInNewContext(hydration+'\n_hydrateOpenSceneLabelDetails();',context);
  return{detail,entry,touched,refresh,snapshot:mobile.snapshot()};
}

test('hydration refreshes a selected preview without a second tap or changing summary/full mode',()=>{
  for(const stage of ['summary','full']){
    const result=harness({stage});
    assert.equal(result.touched.length,1);
    assert.equal(result.touched[0].props.description,'Hydrated body');
    assert.equal(result.refresh,1);
    assert.equal(result.snapshot.stage,stage);
  }
});

test('late response must not reopen dismissed, replaced, or still-preview-only panel',()=>{
  const scenarios=[
    {selectedId:'other'}, {key:'scene:someone-else'}, {stage:'closed'},
    {stage:'idle'}, {visible:false}, {preview:true}, {entryId:'other'},
  ];
  for(const opts of scenarios) {
    const result=harness(opts);
    assert.equal(result.touched.length,0,JSON.stringify(opts));
    assert.equal(result.refresh,0,JSON.stringify(opts));
  }
});

test('desktop hydration is also constrained to the current visible scene label',()=>{
  assert.equal(harness({compact:false}).touched.length,1);
  assert.equal(harness({compact:false,selectedId:'other'}).touched.length,0);
  assert.equal(harness({compact:false,visible:false}).touched.length,0);
});

test('first preview tap uses regular scene detail panel and render upgrade fills photos',()=>{
  assert.match(source,/pinVisual = createSceneLabelPin\([\s\S]*?showSceneLabelDetail\(entry\.obj\);/);
  assert.match(source,/if \(current\) showSceneLabelDetail\(current\.obj\);/);
  assert.doesNotMatch(source,/showWidgetDetail\([^\n]*Loading shared scene details/);
  assert.match(source,/detail\.dataset\.sceneLabelId = obj\.id/);
  assert.match(source,/delete openDetail\.dataset\.sceneLabelId/);
  assert.match(source,/if \(!preview\) _hydrateOpenSceneLabelDetails\(\);/);
  assert.match(source,/\[401,403,404,410\]\.includes\(status\)/);
  assert.match(source,/renderSceneWidgets\(\[\]\);/);
  assert.match(source,/notes\.textContent = obj\.props\?\.description \|\| ''/);
  assert.match(source,/renderScenePhotoGallery\(\{props:obj\.props/);
});

test('new Supabase RPC keeps the original scene capability rules and returns only bounded text',()=>{
  const sql=read('supabase/migrations/0023_shared_scene_preview_description.sql');
  assert.match(sql,/security definer/i);
  assert.match(sql,/set search_path = ''/);
  assert.match(sql,/s\.kind = 'admin'/);
  assert.match(sql,/s\.share_code = p_code/);
  assert.match(sql,/site\.slug = p_site_slug/);
  assert.match(sql,/obj\.scene_id = s\.id/);
  assert.match(sql,/obj\.site_id = s\.site_id/);
  assert.match(sql,/coalesce\(s\.camera ->> 'purpose', ''\) <> 'my-pins-v1'/);
  assert.match(sql,/'description', pg_catalog\.left\(coalesce\(o\.props ->> 'description', ''\), 4000\)/);
  assert.doesNotMatch(sql,/\b(photoItems|photoUrl|photoUrls|script_source|contact_ids|phone)\b/);
  assert.doesNotMatch(sql,/grant\s+select\s+on/i);
  const js=read('shared-scene-pin-preview.js');
  assert.match(js,/description\.length > 4000/);
  assert.match(js,/props: \{ text, description \}/);
  assert.match(source,/shared-scene-pin-preview\.js\?v=scene-detail-hydrate-20261015a/);
  for(const html of ['index.html','viewer3d.html'])
    assert.match(read(html),/viewer3d\.js\?v=photoload-20261022a/);
});
