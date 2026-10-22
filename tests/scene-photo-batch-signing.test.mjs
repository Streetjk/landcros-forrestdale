import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {signPhotoPaths, withSignedPhotos, photoPath} = require('../scene-photo-storage.js');
const scene = '11111111-2222-3333-4444-555555555555';
const object = '66666666-7777-8888-9999-000000000000';
const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const signed = path => 'https://cdn.example.test/private/' + path + '?token=test-ephemeral';

test('batch-signs 60 paths in two bounded requests rather than 60 separate calls', async () => {
  const paths = Array.from({length:60},(_,i)=>scene+'/'+object+'/gallery/'+String(i).padStart(3,'0')+'.jpg');
  const calls=[];let fallback=0;
  const result=await signPhotoPaths([...paths,paths[1]], {
    signMany:async chunk=> {
      calls.push(chunk);
      return {data:chunk.map(path=>({path,signedUrl:signed(path)})),error:null};
    },
    signOne:async()=>{fallback++;return null;},
  });
  assert.deepEqual(calls.map(x=>x.length),[50,10]);
  assert.equal(fallback,0);
  assert.equal(result.size,60);
  assert.equal(result.get(paths[1]),signed(paths[1]));
});

test('missing batch signatures use one-path fallback without exposing unrelated entries',async()=>{
  const paths=['a/b/a.jpg','a/b/b.jpg'];
  const calls=[];
  const result=await signPhotoPaths(paths,{
    signMany:async()=>({data:[
      {path:paths[0],signedUrl:signed(paths[0])},
      {path:'not-authorised.jpg',signedUrl:signed('not-authorised.jpg')},
    ]}),
    signOne:async path=>{calls.push(path);return signed(path);},
  });
  assert.equal(result.size,2);
  assert.deepEqual(calls,[paths[1]]);
  assert.equal(result.has('not-authorised.jpg'),false);
});

test('batch signing errors fall back to individual private signing',async()=>{
  const paths=['x.jpg','y.jpg'];
  const old=console.error;
  const logs=[];console.error=(...args)=>logs.push(args.join(' '));
  try {
    const result=await signPhotoPaths(paths,{
      signMany:async()=>{throw Error('Simulated Storage interruption');},
      signOne:async path=>signed(path),
    });
    assert.deepEqual([...result.keys()],paths);
    assert.equal(logs.length,1);
  }finally{console.error=old;}
});

test('scene labels retain private path scoping, signed URL order and legacy-photo compatibility',async()=>{
  const legacy=photoPath(scene,object);
  const photo=scene+'/'+object+'/gallery/00000000-0000-0000-0000-000000000001.jpg';
  const foreignPath=scene+'/'+other+'/gallery/00000000-0000-0000-0000-000000000002.jpg';
  const obj={id:object,sceneId:scene,kind:'label',props:{
    text:'Equipment',photoPath:legacy,photoPaths:[photo,photo,foreignPath,'/invalid.jpg'],
  }};
  const button={id:other,sceneId:scene,kind:'button',props:{label:'Action'}};
  const queried=[];
  const result=await withSignedPhotos([obj,button],{
    signPaths:async paths=>{
      queried.push(...paths);
      return new Map(paths.map(path=>[path,signed(path)]));
    },
  });
  assert.deepEqual(queried,[legacy,photo]);
  assert.deepEqual(result[0].props.photoItems,[{path:legacy,url:signed(legacy)},{path:photo,url:signed(photo)}]);
  assert.equal(result[0].props.photoUrl,signed(legacy));
  assert.deepEqual(result[0].props.photoUrls,[signed(legacy),signed(photo)]);
  assert.strictEqual(result[1],button);
  assert.deepEqual(obj.props.photoPaths,[photo,photo,foreignPath,'/invalid.jpg'],'DB input remains unchanged');
});

test('unsigned or missing photos remain absent rather than leaking untrusted links',async()=>{
  const obj={id:object,sceneId:scene,kind:'label',props:{
    photoPath:photoPath(scene,object),
  }};
  const result=await withSignedPhotos([obj],{signPaths:async()=>new Map()});
  assert.deepEqual(result[0].props.photoItems,[]);
  assert.deepEqual(result[0].props.photoUrls,[]);
  assert.equal(result[0].props.photoUrl,null);
});

test('only thumbnail paths belonging to a valid private gallery photo are signed',async()=>{
  const full=scene+'/'+object+'/gallery/00000000-0000-0000-0000-000000000003.webp';
  const thumb=full.replace('.webp','.thumb.webp');
  const foreign=scene+'/'+other+'/gallery/00000000-0000-0000-0000-000000000003.thumb.webp';
  const input={id:object,sceneId:scene,kind:'label',props:{
    photoPaths:[full],photoThumbPaths:[thumb,foreign],
  }};
  let paths=[];
  const result=await withSignedPhotos([input],{signPaths:async values=>{
    paths=values;return new Map(values.map(path=>[path,signed(path)]));
  }});
  assert.deepEqual(paths,[full,thumb]);
  assert.deepEqual(result[0].props.photoItems,[{path:full,url:signed(full),thumbUrl:signed(thumb)}]);
  assert.equal(paths.includes(foreign),false);
});
