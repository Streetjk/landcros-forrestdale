import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../scene-early-photos.js',import.meta.url),'utf8');
const uuid='11111111-2222-4333-8444-555555555555';

function start({mode='viewer',search='?scene=abcde12345',hostname='landcros-forrestdale-static.onrender.com',
  saveData=false,response=async()=>({ok:false,status:404,json:async()=>({error:'missing'})})}={}) {
  const calls=[],images=[];
  class ImageStub {
    set src(value){this.url=value;images.push(this);}
  }
  const window={};
  runInNewContext(source,{
    document:{currentScript:{dataset:{sceneMode:mode}}},
    location:{search,hostname},navigator:{connection:{saveData}},
    URLSearchParams,window,Image:ImageStub,
    fetch:async (url,options)=>{calls.push({url,options});return response(url);},
  });
  return {window,calls,images};
}

test('static scene starts backend request before viewer and warms private preview first',async()=>{
  const full='https://storage.example.test/private/full.webp?token=x';
  const thumb='https://storage.example.test/private/thumb.webp?token=x';
  const {window,calls,images}=start({response:async()=>({ok:true,status:200,json:async()=>({
    objects:[{kind:'label',props:{photoItems:[{path:'a.webp',url:full,thumbUrl:thumb}]}}],
  })})});
  const result=await window.__siteNavEarlyScene.promise;
  assert.equal(result.ok,true);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://landcros-forrestdale.onrender.com/api/scenes/by-code/abcde12345');
  assert.equal(calls[0].options.credentials,'same-origin');
  assert.deepEqual(images.map(x=>x.url),[thumb,full]);
  assert.equal(images[0].fetchPriority,'high');
  assert.equal(images[1].fetchPriority,'low');
  assert.ok(images.every(x=>x.crossOrigin==='anonymous' && x.referrerPolicy==='no-referrer'));
});

test('backend viewer retains same-origin route; missing/invalid scenes never prefetch photos',async()=>{
  const backend=start({hostname:'landcros-forrestdale.onrender.com'});
  await backend.window.__siteNavEarlyScene.promise;
  assert.equal(backend.calls[0].url,'/api/scenes/by-code/abcde12345');
  assert.equal(backend.images.length,0);
  const invalid=start({search:'?scene=bad'});
  assert.equal(invalid.window.__siteNavEarlyScene,undefined);
  assert.equal(invalid.calls.length,0);
});

test('editor prefetches groups and scenes concurrently, then first scene photos',async()=>{
  const photo='https://storage.example.test/signed/original.jpg';
  const {window,calls,images}=start({mode:'editor',search:'?site=landcros',
    response:async(url)=>({ok:true,status:200,json:async()=>
      url.endsWith('/scenes')?[{id:uuid,name:'First'}]
      :url.includes('/scene-groups')?{groups:[],assignments:[]}
      :[{kind:'label',props:{photoUrl:photo}}]})});
  const warm=window.__siteNavEarlyEditor;
  const [groups,scenes,objects]=await Promise.all([warm.groups,warm.scenes,warm.objects]);
  assert.equal(groups.ok,true);
  assert.equal(scenes.data[0].id,uuid);
  assert.equal(objects.sceneId,uuid);
  assert.equal(calls.length,3);
  assert.equal(calls[0].url,'/api/sites/landcros/scene-groups?kind=admin');
  assert.equal(calls[1].url,'/api/sites/landcros/scenes');
  assert.equal(calls[2].url,'/api/sites/landcros/objects?scene='+uuid);
  assert.equal(images[0].url,photo);
});

test('an access denial and data-saving mode never preload private images',async()=>{
  const denied=start({response:async()=>({ok:false,status:401,json:async()=>({error:'denied'})})});
  const result=await denied.window.__siteNavEarlyScene.promise;
  assert.equal(result.status,401);
  assert.equal(denied.images.length,0);
  const noWarm=start({saveData:true,response:async()=>({ok:true,status:200,json:async()=>({
    objects:[{kind:'label',props:{photoUrl:'https://storage.example.test/a.jpg'}}],
  })})});
  await noWarm.window.__siteNavEarlyScene.promise;
  assert.equal(noWarm.images.length,0);
});

test('all three HTML entries launch the early reader before blocking CDN scripts',()=>{
  for(const name of ['index.html','viewer3d.html','editor.html']) {
    const html=readFileSync(new URL('../'+name,import.meta.url),'utf8');
    const early=html.indexOf('src="./scene-early-photos.js"');
    const gsap=html.indexOf('gsap@3.12.5');
    assert.ok(early>=0 && early<gsap,name+' must start network before viewer dependencies');
  }
});
