import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { duplicateScene, copyName } = require('../scene-duplicate.js');
const original = '54f63a6c-2a22-44f2-8424-fab737c26524';
const objectId = 'fd1449dc-1052-4818-9d13-cd6ecdff7fd8';
const sourcePhoto = original + '/' + objectId + '/photo.jpg';
const site = 'eeeeeeee-2222-4444-8888-000000000001';
const actor = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function fixture(options = {}) {
  const statements = [];
  let rolledBack = false;
  let committed = false;
  const copied = [];
  const cleaned = [];
  const db = {
    async query(sql, args=[]) {
      statements.push({sql, args});
      if (sql === 'COMMIT') committed = true;
      if (sql === 'ROLLBACK') rolledBack = true;
      if (sql.startsWith('select id, name, kind, camera')) {
        return {rows: options.missing ? [] : [{id:original,name:'Fire Hose',kind:options.kind||'admin',camera:{position:[1,2,3]}}]};
      }
      if (sql.startsWith('select id, kind, transform')) {
        return {rows: [
          {id:objectId,kind:'label',props:{text:'Fire Hose',description:'Missing nozzle',photoPath:sourcePhoto,
            photoPaths:options.galleryPaths||[],photoThumbPaths:options.thumbPaths||[]},transform:{position:[1,2,3]},style:{},z_index:1},
          {id:'aaaaaaaa-0000-0000-0000-000000000001',kind:'button',props:{label:'Call office',action:{type:'none'}},transform:{position:[4,5,6]},style:{},z_index:2},
        ]};
      }
      if (sql.startsWith('select label, type, scope')) return {rows:options.points||[]};
      if (sql.startsWith('select exists')) return {rows:[{has_photos:!!options.pointPhotos}]};
      if (sql.startsWith('insert into scene_objects') && options.failAfterPhoto) throw new Error('synthetic DB error');
      return {rows:[]};
    },
    release() { statements.push({sql:'RELEASE'}); },
  };
  return {
    statements, copied, cleaned, get committed(){return committed}, get rolledBack(){return rolledBack},
    deps:{
      getSite: async()=>site,
      connect: async()=>db,
      copyImage: async(...args)=>{
        const target=args[2]+'/'+args[3]+'/photo.jpg';
        copied.push({args,target});
        if(options.failStorage) throw new Error('synthetic storage error');
        return target;
      },
      copyGalleryImage:async(sourceScene,sourceObj,src,destScene,destObj)=>{
        const path=destScene+'/'+destObj+'/gallery/'+src.split('/').pop();
        copied.push({args:[sourceScene,sourceObj,src,destScene,destObj],target:path});
        return path;
      },
      copyGalleryThumbnail:async(sourceScene,sourceObj,src,destScene,destObj)=>{
        const path=destScene+'/'+destObj+'/gallery/'+src.split('/').pop();
        copied.push({args:[sourceScene,sourceObj,src,destScene,destObj],target:path});
        if(options.failThumbnail)throw Error('Thumbnail clone interrupted');
        return path;
      },
      removeImages: async arr => {cleaned.push(...arr)},
    },
  };
}

test('duplicate creates new scene, new token, independent photo and object IDs', async()=>{
  const f=fixture();
  const result=await duplicateScene('landcros',original,undefined,actor,f.deps);
  assert.equal(result.name,'Fire Hose (Copy)');
  assert.notEqual(result.id,original);
  assert.match(result.shareCode,/^[a-z2-9]{10}$/);
  assert.equal(result.copiedObjects,2);
  assert.equal(result.copiedPhotos,1);
  assert.equal(f.copied.length,1);
  assert.deepEqual(f.copied[0].args.slice(0,2),[original,objectId]);
  assert.equal(f.committed,true);
  assert.equal(f.rolledBack,false);
  const inserted=f.statements.filter(s=>s.sql.startsWith('insert into scene_objects'));
  assert.equal(inserted.length,2);
  const newProps=JSON.parse(inserted[0].args[6]);
  assert.equal(newProps.text,'Fire Hose');
  assert.equal(newProps.description,'Missing nozzle');
  assert.notEqual(inserted[0].args[0],objectId);
  assert.equal(newProps.photoPath,f.copied[0].target);
  assert.ok(!f.statements.some(s=>s.sql.startsWith('update scenes') || s.sql.startsWith('delete from scenes')));
});

test('transaction rolls back and cleans copied photos if DB insert fails',async()=>{
  const f=fixture({failAfterPhoto:true});
  await assert.rejects(()=>duplicateScene('landcros',original,'Copy',actor,f.deps),/synthetic DB error/);
  assert.equal(f.committed,false);
  assert.equal(f.rolledBack,true);
  assert.deepEqual(f.cleaned,f.copied.map(x=>x.target));
});

test('rejects unscoped and non-admin duplication without writing',async()=>{
  const absent=fixture({missing:true});
  await assert.rejects(()=>duplicateScene('landcros',original,'Copy',actor,absent.deps),{status:404});
  assert.equal(absent.rolledBack,true);
  const hazard=fixture({kind:'hazard'});
  await assert.rejects(()=>duplicateScene('landcros',original,'Copy',actor,hazard.deps),{status:422});
  assert.equal(hazard.copied.length,0);
  assert.throws(()=>copyName('A', ' '),{status:400});
});


test('scene copy duplicates every gallery photo to independent private paths',async()=>{
  const sourcePath=original+'/'+objectId+'/gallery/cccccccc-cccc-cccc-cccc-cccccccccccc.jpg';
  const f=fixture({galleryPaths:[sourcePath]});
  const result=await duplicateScene('landcros',original,undefined,actor,f.deps);
  assert.equal(result.copiedPhotos,2);
  assert.equal(f.copied.length,2);
  const insert=f.statements.find(s=>s.sql.startsWith('insert into scene_objects'));
  const copiedProps=JSON.parse(insert.args[6]);
  assert.equal(copiedProps.photoPaths.length,1);
  assert.notEqual(copiedProps.photoPaths[0],sourcePath);
  assert.equal(copiedProps.photoPaths[0],f.copied[1].target);
  assert.equal(f.committed,true);
});

test('scene copy preserves associated private thumbnails and cleans them on rollback',async()=>{
  const sourcePath=original+'/'+objectId+'/gallery/cccccccc-cccc-cccc-cccc-cccccccccccc.webp';
  const thumbPath=sourcePath.replace('.webp','.thumb.webp');
  const f=fixture({galleryPaths:[sourcePath],thumbPaths:[thumbPath]});
  const result=await duplicateScene('landcros',original,undefined,actor,f.deps);
  assert.equal(result.copiedPhotos,2,'thumbnail is not counted as another photo');
  assert.equal(f.copied.length,3);
  const inserted=f.statements.find(s=>s.sql.startsWith('insert into scene_objects'));
  const props=JSON.parse(inserted.args[6]);
  assert.deepEqual(props.photoThumbPaths,[f.copied[2].target]);
  assert.notEqual(props.photoThumbPaths[0],thumbPath);

  const failed=fixture({galleryPaths:[sourcePath],thumbPaths:[thumbPath],failAfterPhoto:true});
  await assert.rejects(()=>duplicateScene('landcros',original,undefined,actor,failed.deps),/synthetic DB error/);
  assert.deepEqual(failed.cleaned,failed.copied.map(item=>item.target));
});
