import test from 'node:test';
import assert from 'node:assert/strict';
import {optimiseScenePhoto,PHOTO_FULL_TARGET_BYTES,PHOTO_THUMB_TARGET_BYTES}
  from '../scene-photo-optimizer.js';

function fakeBrowser({webp=true,large=false,pixels=12_000_000}={}) {
  const old={document:globalThis.document,createImageBitmap:globalThis.createImageBitmap,
    FileReader:globalThis.FileReader};
  const calls=[];
  let closed=false;
  globalThis.createImageBitmap=async()=>({width:pixels===12_000_000?4000:10000,
    height:pixels===12_000_000?3000:6000,close(){closed=true;}});
  globalThis.document={createElement:tag=>{
    assert.equal(tag,'canvas');
    return {
      width:0,height:0,
      getContext:()=>({drawImage(){}}),
      toBlob(callback,type,quality){
        calls.push({type,quality,width:this.width,height:this.height});
        const mime=type==='image/webp' && !webp?'image/png':type;
        const size=large?2_000_000:this.width>500?720_000:40_000;
        callback({type:mime,size});
      },
    };
  }};
  globalThis.FileReader=class {
    readAsDataURL(blob){this.result='data:'+blob.type+';base64,YWJj';this.onload();}
  };
  return {calls,get closed(){return closed;},restore(){Object.assign(globalThis,old);}};
}

const sample={type:'image/jpeg',size:8_000_000};

test('client produces 1920px quality-85 WebP and a distinct 400px thumbnail',async()=>{
  const mock=fakeBrowser();
  try {
    const output=await optimiseScenePhoto(sample);
    assert.equal(output.dataUrl,'data:image/webp;base64,YWJj');
    assert.equal(output.thumbnailDataUrl,'data:image/webp;base64,YWJj');
    assert.equal(output.fullBytes,720_000);
    assert.equal(output.thumbnailBytes,40_000);
    assert.deepEqual(mock.calls.slice(0,2).map(c=>[c.width,c.height,c.quality]),
      [[1920,1440,0.85],[400,300,0.80]]);
    assert.ok(output.fullBytes<PHOTO_FULL_TARGET_BYTES);
    assert.ok(output.thumbnailBytes<PHOTO_THUMB_TARGET_BYTES);
    assert.equal(mock.closed,true);
  }finally{mock.restore();}
});

test('when WebP encoding is unsupported the whole pair falls back to JPEG',async()=>{
  const mock=fakeBrowser({webp:false});
  try{
    const output=await optimiseScenePhoto(sample);
    assert.ok(output.dataUrl.startsWith('data:image/jpeg;'));
    assert.ok(output.thumbnailDataUrl.startsWith('data:image/jpeg;'));
    assert.deepEqual(mock.calls.slice(0,2).map(c=>c.type),['image/webp','image/jpeg']);
    assert.equal(mock.closed,true);
  }finally{mock.restore();}
});

test('very large images fail safely and always release decoded bitmap',async()=>{
  const mock=fakeBrowser({pixels:60_000_000});
  try{
    await assert.rejects(()=>optimiseScenePhoto(sample),/dimensions are too large/);
    assert.equal(mock.calls.length,0);
    assert.equal(mock.closed,true);
  }finally{mock.restore();}
});

test('photos that cannot reach the byte cap are rejected rather than uploaded oversized',async()=>{
  const mock=fakeBrowser({large:true});
  try{
    await assert.rejects(()=>optimiseScenePhoto(sample),/still too large/);
    assert.equal(mock.closed,true);
  }finally{mock.restore();}
});
