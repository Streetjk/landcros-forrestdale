// Transactional gallery metadata; legacy photoPath remains untouched.
// Object bytes stay in the existing PRIVATE Supabase Storage bucket.
const crypto = require('crypto');
const {pool,getSiteId} = require('./supabase-db');
const storage = require('./scene-photo-storage');

const MAX_PHOTOS=6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function galleryPath(sceneId,objectId,photoId) {
  if (![sceneId,objectId,photoId].every(id=>UUID.test(id||''))) {
    throw Object.assign(new Error('Invalid gallery identifier'),{status:400});
  }
  return `${sceneId}/${objectId}/gallery/${photoId}.jpg`;
}
function validGalleryPaths(props,sceneId,objectId) {
  const prefix=`${sceneId}/${objectId}/gallery/`;
  const values=Array.isArray(props?.photoPaths)?props.photoPaths:[];
  return [...new Set(values.filter(v=>
    typeof v==='string' && v.startsWith(prefix) &&
    UUID.test(v.slice(prefix.length,-4)) && v.endsWith('.jpg')
  ))].slice(0,MAX_PHOTOS);
}
function allStoredPaths(props,sceneId,objectId) {
  const paths=[];
  if(props?.photoPath === storage.photoPath(sceneId,objectId))paths.push(props.photoPath);
  return [...paths,...validGalleryPaths(props,sceneId,objectId)];
}
function galleryError(message,status=400) {
  return Object.assign(new Error(message),{status});
}
async function galleryPropsForRead(sceneId,objectId,props) {
  const full = await storage.withSignedPhotos([{
    id:objectId,sceneId,kind:'label',props,
  }]);
  return full[0].props;
}

async function createGalleryPhoto(slug,sceneId,objectId,dataUrl,{
  getSite=getSiteId,
  connect=()=>pool().connect(),
  upload=storage.uploadGalleryObject,
  remove=storage.removeClonedSceneLabelPhotos,
  readProps=galleryPropsForRead,
}={}) {
  const data=storage.decodeJpegDataUrl(dataUrl);
  const siteId=await getSite(slug);
  const client=await connect();
  let path=null, committed=false;
  try {
    await client.query('BEGIN');
    const {rows}=await client.query(
      `select props from scene_objects
       where site_id=$1::uuid and scene_id=$2::uuid and id=$3::uuid and kind='label'
       for update`,
      [siteId,sceneId,objectId]
    );
    if(!rows.length) throw galleryError('Pin not found',404);
    const current=rows[0].props||{};
    const previous=validGalleryPaths(current,sceneId,objectId);
    if (previous.length + (current.photoPath===storage.photoPath(sceneId,objectId)?1:0) >= MAX_PHOTOS) {
      throw galleryError('Maximum six photos per pin',422);
    }
    path=galleryPath(sceneId,objectId,crypto.randomUUID());
    await upload(path,data);
    const next={...current,photoPaths:[...previous,path]};
    delete next.photoUrl;delete next.photoUrls;delete next.photoItems;
    const updated=await client.query(
      `update scene_objects set props=$4::jsonb, updated_at=now()
       where site_id=$1::uuid and scene_id=$2::uuid and id=$3::uuid and kind='label'
       returning props`,
      [siteId,sceneId,objectId,JSON.stringify(next)]
    );
    if(updated.rowCount !== 1) throw galleryError('Photo save failed',409);
    await client.query('COMMIT');committed=true;
    return {props:await readProps(sceneId,objectId,next),count:allStoredPaths(next,sceneId,objectId).length};
  } catch(error) {
    if(!committed){
      try{await client.query('ROLLBACK');}catch(e){console.error('[gallery] rollback:',e.message);}
      if(path){
        try{await remove([path]);}catch(e){console.error('[gallery] orphan cleanup:',e.message);}
      }
    }
    throw error;
  } finally {client.release();}
}

async function deleteGalleryPhoto(slug,sceneId,objectId,photoPath,{
  getSite=getSiteId,
  connect=()=>pool().connect(),
  remove=storage.removeClonedSceneLabelPhotos,
  readProps=galleryPropsForRead,
}={}) {
  if(typeof photoPath !== 'string')throw galleryError('Photo path required');
  const siteId=await getSite(slug);
  const client=await connect();
  let next=null,committed=false;
  try{
    await client.query('BEGIN');
    const {rows}=await client.query(
      `select props from scene_objects where site_id=$1::uuid and scene_id=$2::uuid
       and id=$3::uuid and kind='label' for update`,
      [siteId,sceneId,objectId]
    );
    if(!rows.length)throw galleryError('Pin not found',404);
    const current=rows[0].props||{};
    const gallery=validGalleryPaths(current,sceneId,objectId);
    const legacy=storage.photoPath(sceneId,objectId);
    if(photoPath !== legacy && !gallery.includes(photoPath))throw galleryError('Photo not found',404);
    if(photoPath===legacy && current.photoPath!==legacy)throw galleryError('Photo not found',404);
    next={...current};
    if(photoPath===legacy)next.photoPath=null;
    else next.photoPaths=gallery.filter(p=>p!==photoPath);
    delete next.photoUrl;delete next.photoUrls;delete next.photoItems;
    const updated=await client.query(
      `update scene_objects set props=$4::jsonb,updated_at=now()
       where site_id=$1::uuid and scene_id=$2::uuid and id=$3::uuid and kind='label'`,
      [siteId,sceneId,objectId,JSON.stringify(next)]
    );
    if(updated.rowCount!==1)throw galleryError('Photo remove failed',409);
    await client.query('COMMIT');committed=true;
    try{await remove([photoPath]);}
    catch(error){console.error('[gallery] orphan photo cleanup:',error.message);}
    return {props:await readProps(sceneId,objectId,next),count:allStoredPaths(next,sceneId,objectId).length};
  } catch(error){
    if(!committed){try{await client.query('ROLLBACK');}catch(e){console.error('[gallery] rollback:',e.message);}}
    throw error;
  }finally{client.release();}
}
module.exports={galleryPath,validGalleryPaths,allStoredPaths,createGalleryPhoto,deleteGalleryPhoto,MAX_PHOTOS};
