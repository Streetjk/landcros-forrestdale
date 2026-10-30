import test from 'node:test';
import assert from 'node:assert/strict';
import {optimiseScenePhoto,PHOTO_FULL_TARGET_BYTES,PHOTO_THUMB_TARGET_BYTES}
  from '../scene-photo-optimizer.js';

function fakeBrowser({webp=true,large=false,tooLargeAt4k=false,pixels=12_000_000}={}) {
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
      getContext(){
        this.context={drawImage(){},imageSmoothingEnabled:false,imageSmoothingQuality:'low'};
        return this.context;
      },
      toBlob(callback,type,quality){
        calls.push({type,quality,width:this.width,height:this.height,
          smoothing:this.context.imageSmoothingQuality});
        const mime=type==='image/webp' && !webp?'image/png':type;
        const size=large || (tooLargeAt4k && this.width>3456)
          ? 8_000_000 : this.width>800 ? 1_600_000 : 80_000;
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

test('client preserves over four times as many photo pixels with a distinct 800px thumbnail',async()=>{
  const mock=fakeBrowser();
  try {
    const output=await optimiseScenePhoto(sample);
    assert.equal(output.dataUrl,'data:image/webp;base64,YWJj');
    assert.equal(output.thumbnailDataUrl,'data:image/webp;base64,YWJj');
    assert.equal(output.fullBytes,1_600_000);
    assert.equal(output.thumbnailBytes,80_000);
    assert.deepEqual(mock.calls.slice(0,2).map(c=>[c.width,c.height,c.quality]),
      [[4000,3000,0.94],[800,600,0.86]]);
    assert.ok(mock.calls.every(call=>call.smoothing==='high'));
    assert.ok(4000*3000/(1920*1440)>4);
    assert.equal(800*600/(400*300),4);
    assert.ok(output.fullBytes<PHOTO_FULL_TARGET_BYTES);
    assert.ok(output.thumbnailBytes<PHOTO_THUMB_TARGET_BYTES);
    assert.equal(mock.closed,true);
  }finally{mock.restore();}
});

test('high-detail encoding retains at least three times old pixel count when 4K exceeds byte cap',async()=>{
  const mock=fakeBrowser({tooLargeAt4k:true});
  try {
    const result=await optimiseScenePhoto(sample);
    assert.equal(result.fullBytes,1_600_000);
    const full=mock.calls.find(call=>call.width===3456);
    assert.ok(full,'the encoder falls back to a lower resolution before failing');
    assert.ok(full.width*full.height/(1920*1440)>=3);
  } finally {mock.restore();}
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
