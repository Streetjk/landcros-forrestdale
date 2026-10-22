import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../scene-early-photos.js',import.meta.url),'utf8');

function run(search,{result,saveData=false,hash=''}={}) {
  const calls=[],images=[];
  const window={};
  const context={
    URLSearchParams,
    location:{hostname:'landcros-forrestdale-static.onrender.com',search,hash},
    navigator:{connection:{saveData}},window,
    Image:class {set src(value){this.url=value;images.push(this);} },
    fetch:async (url,options)=>{
      calls.push({url,options});
      return result || {ok:true,status:200,json:async()=>({objects:[]})};
    },
  };
  vm.runInNewContext(source,context);
  return {window,calls,images};
}

test('head script starts exactly one scoped read and warms thumbnail first',async()=>{
  const result={ok:true,status:200,json:async()=>({objects:[{
    kind:'label',props:{photoItems:[{url:'https://cdn.example/full.webp',thumbUrl:'https://cdn.example/small.webp'}]},
  }]})};
  const {window,calls,images}=run('?scene=abc123def4',{result});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://landcros-forrestdale.onrender.com/api/scenes/by-code/abc123def4');
  assert.equal(calls[0].options.cache,'no-store');
  const response=await window.__siteNavEarlyScene.promise;
  assert.equal(response.ok,true);
  assert.deepEqual(images.map(img=>img.url),['https://cdn.example/small.webp','https://cdn.example/full.webp']);
  assert.equal(window.__siteNavEarlyScene.warmed.length,2);
});

test('unknown or malformed scene codes never start a private read',()=>{
  for(const query of ['','?scene=ABC123DEF4','?scene=abc123def456','?scene=invalid','?scene=abc123def4&id=abc']) {
    const {window,calls}=run(query);
    assert.equal(calls.length,0);
    assert.equal(window.__siteNavEarlyScene,undefined);
  }
  const myPin=run('?scene=abc123def4',{hash:'#myPin=secret'});
  assert.equal(myPin.calls.length,0);
});

test('save-data and denied scenes never preload signed photo links',async()=>{
  const result={ok:true,status:200,json:async()=>({objects:[{kind:'label',props:{photoUrl:'https://cdn.example/full.jpg'}}]})};
  const saved=run('?scene=abc123def4',{result,saveData:true});
  await saved.window.__siteNavEarlyScene.promise;
  assert.equal(saved.images.length,0);

  const denied=run('?scene=abc123def4',{result:{ok:false,status:403,json:async()=>({objects:[{kind:'label',props:{photoUrl:'https://cdn.example/private.jpg'}}]})}});
  await denied.window.__siteNavEarlyScene.promise;
  assert.equal(denied.images.length,0);
});
