import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createGalleryPhoto,deleteGalleryPhoto,validGalleryPaths,galleryPath,MAX_PHOTOS}=
  require('../scene-photo-gallery.js');
const {photoPath}=require('../scene-photo-storage.js');
const scene='11111111-2222-3333-4444-555555555555';
const obj='66666666-7777-8888-9999-000000000000';
const site='88888888-7777-6666-5555-444444444444';
const base=photoPath(scene,obj);
const jpeg=Buffer.from([0xff,0xd8,0xff,0xe0,0x31,0xff,0xd9]);
const dataUrl='data:image/jpeg;base64,'+jpeg.toString('base64');
const webp=Buffer.alloc(20);
webp.write('RIFF',0);webp.writeUInt32LE(12,4);webp.write('WEBP',8);webp.write('VP8 ',12);
const webpDataUrl='data:image/webp;base64,'+webp.toString('base64');

function db(initialProps={},opts={}) {
  const rows=[],imagesUploaded=[],removed=[];
  let props={...initialProps};
  const conn={
    async query(sql,args=[]) {
      rows.push({sql,args});
      if(sql.startsWith('select props from scene_objects')) return {rows:opts.missing?[]:[{props}]};
      if(sql.startsWith('update scene_objects')) {
        if(opts.failUpdate)throw Error('Simulated DB conflict');
        props=JSON.parse(args[3]);
        return {rowCount:1};
      }
      return {rowCount:0,rows:[]};
    },
    release(){},
  };
  return {
    rows,imagesUploaded,removed,get props(){return props;},
    deps:{
      getSite:async()=>site,connect:async()=>conn,
      upload:async(path,data,contentType)=>{
        imagesUploaded.push({path,data,contentType});
        if(opts.failSecondUpload && imagesUploaded.length===2)throw Error('Thumbnail storage interrupted');
      },
      remove:async paths=>{removed.push(...paths);},
      readProps:async(_s,_o,p)=>({...p,photoItems:[]}),
    },
  };
}

test('adds one new gallery photo without overwriting legacy single photo',async()=>{
  const f=db({text:'Fire Hose',photoPath:base});
  const r=await createGalleryPhoto('landcros',scene,obj,dataUrl,f.deps);
  assert.equal(r.count,2);
  assert.equal(f.props.photoPath,base);
  assert.equal(f.props.text,'Fire Hose');
  assert.equal(f.imagesUploaded.length,1);
  assert.match(f.imagesUploaded[0].path,new RegExp('^'+scene+'/'+obj+'/gallery/[0-9a-f-]{36}\\.jpg$'));
  assert.equal(f.props.photoPaths.length,1);
  assert.ok(f.rows.some(q=>q.sql==='COMMIT'));
});

test('removes only selected gallery picture, leaving other images',async()=>{
  const first=galleryPath(scene,obj,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  const second=galleryPath(scene,obj,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  const f=db({photoPath:base,photoPaths:[first,second]});
  const r=await deleteGalleryPhoto('landcros',scene,obj,first,f.deps);
  assert.equal(r.count,2);
  assert.deepEqual(f.props.photoPaths,[second]);
  assert.equal(f.props.photoPath,base);
  assert.deepEqual(f.removed,[first]);
});

test('WebP upload stores a detailed image and its small thumbnail independently',async()=>{
  const f=db({text:'Equipment',photoPath:base});
  const result=await createGalleryPhoto('landcros',scene,obj,webpDataUrl,{
    ...f.deps,thumbnailDataUrl:webpDataUrl,
  });
  assert.equal(result.count,2,'thumbnail does not use an extra gallery slot');
  assert.equal(f.imagesUploaded.length,2);
  const full=f.imagesUploaded[0];const thumb=f.imagesUploaded[1];
  assert.match(full.path,/\/gallery\/[0-9a-f-]{36}\.webp$/);
  assert.equal(thumb.path,full.path.replace('.webp','.thumb.webp'));
  assert.equal(full.contentType,'image/webp');
  assert.equal(thumb.contentType,'image/webp');
  assert.deepEqual(f.props.photoThumbPaths,[thumb.path]);
  assert.deepEqual(f.props.photoPaths,[full.path]);
});

test('deletion removes only the selected full WebP and its corresponding thumbnail',async()=>{
  const full=galleryPath(scene,obj,'cccccccc-cccc-cccc-cccc-cccccccccccc','webp');
  const thumb=full.replace('.webp','.thumb.webp');
  const another=galleryPath(scene,obj,'dddddddd-dddd-dddd-dddd-dddddddddddd','webp');
  const anotherThumb=another.replace('.webp','.thumb.webp');
  const f=db({photoPaths:[full,another],photoThumbPaths:[thumb,anotherThumb]});
  await deleteGalleryPhoto('landcros',scene,obj,full,f.deps);
  assert.deepEqual(f.removed,[full,thumb]);
  assert.deepEqual(f.props.photoPaths,[another]);
  assert.deepEqual(f.props.photoThumbPaths,[anotherThumb]);
});

test('failed thumbnail upload rolls back and cleans both private storage paths',async()=>{
  const f=db({photoPath:base},{failSecondUpload:true});
  await assert.rejects(()=>createGalleryPhoto('landcros',scene,obj,webpDataUrl,{
    ...f.deps,thumbnailDataUrl:webpDataUrl,
  }),/Thumbnail storage interrupted/);
  assert.deepEqual(f.removed,f.imagesUploaded.map(item=>item.path));
  assert.ok(f.rows.some(q=>q.sql==='ROLLBACK'));
  assert.deepEqual(f.props.photoPaths,undefined);
});

test('forged image MIME and mismatched thumbnail formats are rejected before storage',async()=>{
  const f=db();
  await assert.rejects(()=>createGalleryPhoto('landcros',scene,obj,
    'data:image/webp;base64,'+jpeg.toString('base64'),f.deps),{status:400});
  await assert.rejects(()=>createGalleryPhoto('landcros',scene,obj,webpDataUrl,{
    ...f.deps,thumbnailDataUrl:dataUrl,
  }),{status:400});
  assert.equal(f.imagesUploaded.length,0);
});

test('legacy photo removal leaves new gallery files untouched',async()=>{
  const image=galleryPath(scene,obj,'cccccccc-cccc-cccc-cccc-cccccccccccc');
  const f=db({photoPath:base,photoPaths:[image]});
  await deleteGalleryPhoto('landcros',scene,obj,base,f.deps);
  assert.equal(f.props.photoPath,null);
  assert.deepEqual(f.props.photoPaths,[image]);
  assert.deepEqual(f.removed,[base]);
});

test('rolls back and removes orphan upload if metadata DB write fails',async()=>{
  const f=db({}, {failUpdate:true});
  await assert.rejects(()=>createGalleryPhoto('landcros',scene,obj,dataUrl,f.deps),/Simulated DB conflict/);
  assert.ok(f.rows.some(q=>q.sql==='ROLLBACK'));
  assert.deepEqual(f.removed,[f.imagesUploaded[0].path]);
});

test('max six including legacy, reject attempts to remove other paths',async()=>{
  const paths=Array.from({length:5},(_,i)=>galleryPath(scene,obj,
    '00000000-0000-0000-0000-00000000000'+i));
  const full=db({photoPath:base,photoPaths:paths});
  await assert.rejects(()=>createGalleryPhoto('landcros',scene,obj,dataUrl,full.deps),{status:422});
  assert.equal(full.imagesUploaded.length,0);
  const single=db({photoPath:base,photoPaths:[paths[0]]});
  await assert.rejects(()=>deleteGalleryPhoto('landcros',scene,obj,
    galleryPath(scene,'ffffffff-ffff-ffff-ffff-ffffffffffff','cccccccc-cccc-cccc-cccc-cccccccccccc'),single.deps),{status:404});
  assert.deepEqual(single.removed,[]);
  assert.equal(MAX_PHOTOS,6);
  assert.deepEqual(validGalleryPaths(single.props,scene,obj),[paths[0]]);
});
