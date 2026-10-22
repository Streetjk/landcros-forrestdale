// Photos live in private Supabase Storage and are signed at read time.
const { createClient } = require('@supabase/supabase-js');
const { pool, getSiteId } = require('./supabase-db');
const BUCKET = 'sitenav-scene-photos';
const MAX_PHOTO_BYTES = 950_000;
const MAX_THUMB_BYTES = 120_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let client = null;
let bucketReady = false;

function storageClient() {
  if (!client) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
      throw new Error('Supabase Storage credentials not configured');
    }
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false },
    });
  }
  return client;
}

function photoPath(sceneId, objectId) {
  if (!UUID_RE.test(sceneId || '') || !UUID_RE.test(objectId || '')) {
    throw Object.assign(new Error('Invalid scene/object ID'), { status: 400 });
  }
  return sceneId + '/' + objectId + '/photo.jpg';
}

function decodePhotoDataUrl(dataUrl, {maxBytes=MAX_PHOTO_BYTES, jpegOnly=false}={}) {
  const match = typeof dataUrl === 'string'
    && /^data:(image\/jpeg|image\/webp);base64,/.exec(dataUrl);
  if (!match || (jpegOnly && match[1] !== 'image/jpeg')) {
    throw Object.assign(new Error('A JPEG or WebP photo is required'), { status: 400 });
  }
  const encoded = dataUrl.slice(match[0].length);
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded) ||
      encoded.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw Object.assign(new Error('Invalid or oversized photo'), { status: 413 });
  }
  const bytes = Buffer.from(encoded, 'base64');
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8
    && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  const webp = bytes.length >= 20 && bytes.toString('ascii',0,4) === 'RIFF'
    && bytes.toString('ascii',8,12) === 'WEBP'
    && ['VP8 ','VP8L','VP8X'].includes(bytes.toString('ascii',12,16))
    && bytes.readUInt32LE(4) + 8 === bytes.length;
  if (bytes.length > maxBytes || !(match[1] === 'image/jpeg' ? jpeg : webp)) {
    throw Object.assign(new Error('Invalid or oversized photo'), { status: 400 });
  }
  return {bytes,contentType:match[1],extension:jpeg ? 'jpg' : 'webp'};
}

// Backward compatibility for the original single-JPEG photo endpoint.
function decodeJpegDataUrl(dataUrl) {
  return decodePhotoDataUrl(dataUrl,{jpegOnly:true}).bytes;
}

function thumbnailPathForGallery(path) {
  const match = typeof path === 'string' &&
    /^(.*\/gallery\/[0-9a-f-]{36})\.(jpg|webp)$/i.exec(path);
  if (!match || !UUID_RE.test(match[1].slice(-36))) {
    throw Object.assign(new Error('Invalid gallery photo path'),{status:400});
  }
  return match[1]+'.thumb.'+match[2];
}

async function assertOwnsLabel(slug, sceneId, objectId) {
  photoPath(sceneId, objectId);
  const siteId = await getSiteId(slug);
  const { rows } = await pool().query(
    "select id from scene_objects where id=$1::uuid and scene_id=$2::uuid and site_id=$3::uuid and kind='label'",
    [objectId, sceneId, siteId]
  );
  if (!rows.length) throw Object.assign(new Error('Scene label not found'), { status: 404 });
}

async function ensureBucket() {
  if (bucketReady) return;
  const storage = storageClient().storage;
  const { data, error } = await storage.getBucket(BUCKET);
  if (data) {
    if (data.public) throw new Error('Scene photo bucket must be private');
    const allowed = data.allowed_mime_types ?? data.allowedMimeTypes;
    // Existing buckets were initially JPEG-only. Extend that allowlist in
    // place while preserving their privacy, size cap and other MIME entries.
    if (Array.isArray(allowed) && allowed.length && !allowed.includes('image/webp')) {
      const options = {public:false,allowedMimeTypes:[...new Set([...allowed,'image/webp'])]};
      if (data.file_size_limit != null) options.fileSizeLimit=data.file_size_limit;
      const {error:updateError}=await storage.updateBucket(BUCKET,options);
      if (updateError) throw updateError;
    }
  } else {
    if (error && !/not found|404|does not exist/i.test(String(error.message || ''))) throw error;
    const { error: createError } = await storage.createBucket(BUCKET, {
      public: false, fileSizeLimit: '1MB', allowedMimeTypes: ['image/jpeg','image/webp'],
    });
    if (createError && !/already exists|duplicate/i.test(String(createError.message || ''))) throw createError;
  }
  bucketReady = true;
}

async function uploadPhoto(slug, sceneId, objectId, dataUrl) {
  const bytes = decodeJpegDataUrl(dataUrl);
  await assertOwnsLabel(slug, sceneId, objectId);
  await ensureBucket();
  const path = photoPath(sceneId, objectId);
  const { error } = await storageClient().storage.from(BUCKET).upload(path, bytes, {
    contentType: 'image/jpeg', upsert: true, cacheControl: '300',
  });
  if (error) throw error;
  return { photoPath: path, photoUrl: await signPhoto(path) };
}

async function deletePhoto(slug, sceneId, objectId) {
  await assertOwnsLabel(slug, sceneId, objectId);
  const { error } = await storageClient().storage.from(BUCKET).remove([photoPath(sceneId, objectId)]);
  if (error) throw error;
  return { ok: true };
}

async function signPhoto(path) {
  if (typeof path !== 'string') return null;
  try {
    const { data, error } = await storageClient().storage.from(BUCKET).createSignedUrl(path, 3600);
    if (error) throw error;
    return data?.signedUrl || null;
  } catch (e) {
    console.error('[scene-photos] Could not sign photo:', e.message);
    return null;
  }
}

// Supabase Storage supports signing multiple private paths in one request.
// Never persist URLs or construct public bucket links: authorisation remains
// enforced by the scene/object API before this helper is called.
async function signPhotoPaths(paths, {
  signMany = batch => storageClient().storage.from(BUCKET).createSignedUrls(batch, 3600),
  signOne = signPhoto,
} = {}) {
  const signed = new Map();
  const unique = [...new Set(paths)].filter(path => typeof path === 'string');
  if (!unique.length) return signed;
  const BATCH = 50;
  await Promise.all(Array.from({length: Math.ceil(unique.length / BATCH)}, async (_, i) => {
    const chunk = unique.slice(i * BATCH, (i + 1) * BATCH);
    try {
      const {data,error} = await signMany(chunk);
      if (error || !Array.isArray(data)) throw error || new Error('Invalid photo batch signature response');
      const expected = new Set(chunk);
      for (const entry of data) {
        if (!expected.has(entry?.path) || typeof entry.signedUrl !== 'string'
            || !entry.signedUrl.startsWith('https://')) continue;
        signed.set(entry.path, entry.signedUrl);
      }
    } catch (error) {
      // Service errors must not turn a valid scene into a crash or publish an
      // unsigned URL. Individual signing is a bounded compatibility fallback.
      console.error('[scene-photos] Photo batch signing unavailable:', error.message);
    }
    await Promise.all(chunk.filter(path => !signed.has(path)).map(async path => {
      const url = await signOne(path);
      if (typeof url === 'string' && url.startsWith('https://')) signed.set(path,url);
    }));
  }));
  return signed;
}

async function withSignedPhotos(objects, { signPaths = signPhotoPaths } = {}) {
  // Keep per-object ordering, validating private storage paths against the
  // authoritative scene ID. Unknown paths are never sent to Storage.
  const prepared = objects.map(obj => {
    if (obj.kind !== 'label') return {obj};
    const props = {...(obj.props || {})};
    const legacy = photoPath(obj.sceneId, obj.id);
    const prefix = obj.sceneId + '/' + obj.id + '/gallery/';
    const gallery = Array.isArray(props.photoPaths) ? props.photoPaths.filter(path =>
      typeof path === 'string' && path.startsWith(prefix) &&
      /\.(jpg|webp)$/.test(path) &&
      UUID_RE.test(path.slice(prefix.length).replace(/\.(jpg|webp)$/,''))
    ).slice(0, 6) : [];
    const paths = [...new Set([...(props.photoPath === legacy ? [legacy] : []),...gallery])];
    const thumbs = Array.isArray(props.photoThumbPaths)
      ? gallery.map(thumbnailPathForGallery).filter(path => props.photoThumbPaths.includes(path)) : [];
    return {obj,props,legacy,paths,thumbs};
  });
  const signed = await signPaths(prepared.flatMap(row => [...(row.paths||[]),...(row.thumbs||[])]));
  return prepared.map(({obj,props,legacy,paths,thumbs}) => {
    if (!props) return obj;
    const thumbPaths=new Set(thumbs);
    const items = paths.flatMap(path => {
      if (!signed.get(path)) return [];
      const thumb = path.endsWith('/photo.jpg') ? null : thumbnailPathForGallery(path);
      const thumbUrl = thumb && thumbPaths.has(thumb) ? signed.get(thumb) : null;
      return [{path,url:signed.get(path),...(thumbUrl ? {thumbUrl} : {})}];
    });
    // Response-only links: saveSceneObject strips these before any DB write.
    props.photoItems = items;
    props.photoUrls = items.map(item => item.url);
    props.photoUrl = props.photoPath === legacy
      ? items.find(item => item.path === legacy)?.url || null : null;
    return {...obj,props};
  });
}

async function uploadGalleryObject(path,bytes,contentType='image/jpeg') {
  await ensureBucket();
  if (!['image/jpeg','image/webp'].includes(contentType) ||
      !path.endsWith(contentType === 'image/webp' ? '.webp' : '.jpg')) {
    throw Object.assign(new Error('Photo type and extension do not match'),{status:400});
  }
  const {error}=await storageClient().storage.from(BUCKET).upload(path,bytes,{
    contentType,upsert:false,cacheControl:'300',
  });
  if(error)throw error;
}

async function copyGalleryPhotoPath(sourceSceneId,sourceObjectId,sourcePath,targetSceneId,targetObjectId) {
  const prefix=sourceSceneId+'/'+sourceObjectId+'/gallery/';
  const match=typeof sourcePath==='string' && sourcePath.startsWith(prefix)
    ? /^([0-9a-f-]{36})\.(jpg|webp)$/i.exec(sourcePath.slice(prefix.length)) : null;
  if (!match || !UUID_RE.test(match[1])) {
    throw Object.assign(new Error('Invalid source gallery photo'),{status:422});
  }
  const dest=targetSceneId+'/'+targetObjectId+'/gallery/'+match[1]+'.'+match[2];
  const {error}=await storageClient().storage.from(BUCKET).copy(sourcePath,dest);
  if(error)throw error;
  return dest;
}

async function copyGalleryThumbnailPath(sourceSceneId,sourceObjectId,sourcePath,targetSceneId,targetObjectId) {
  const prefix=sourceSceneId+'/'+sourceObjectId+'/gallery/';
  const match=typeof sourcePath==='string' && sourcePath.startsWith(prefix)
    ? /^([0-9a-f-]{36})\.thumb\.(jpg|webp)$/i.exec(sourcePath.slice(prefix.length)) : null;
  if (!match || !UUID_RE.test(match[1])) {
    throw Object.assign(new Error('Invalid source gallery thumbnail'),{status:422});
  }
  const dest=targetSceneId+'/'+targetObjectId+'/gallery/'+match[1]+'.thumb.'+match[2];
  const {error}=await storageClient().storage.from(BUCKET).copy(sourcePath,dest);
  if(error)throw error;
  return dest;
}

module.exports = { BUCKET, MAX_PHOTO_BYTES, MAX_THUMB_BYTES, photoPath,
  decodeJpegDataUrl, decodePhotoDataUrl, thumbnailPathForGallery,
  assertOwnsLabel, uploadPhoto, deletePhoto, signPhoto, signPhotoPaths, withSignedPhotos };

// Server-only image duplication: each copied scene gets its own private
// storage object, so deleting or editing either scene cannot alter the other.
async function copySceneLabelPhoto(sourceSceneId, sourceObjectId, targetSceneId, targetObjectId) {
  const source = photoPath(sourceSceneId, sourceObjectId);
  const target = photoPath(targetSceneId, targetObjectId);
  const { error } = await storageClient().storage.from(BUCKET).copy(source, target);
  if (error) throw error;
  return target;
}

async function removeClonedSceneLabelPhotos(paths) {
  if (!Array.isArray(paths) || !paths.length) return;
  const { error } = await storageClient().storage.from(BUCKET).remove(paths);
  if (error) throw error;
}

module.exports.uploadGalleryObject = uploadGalleryObject;
module.exports.copyGalleryPhotoPath = copyGalleryPhotoPath;
module.exports.copyGalleryThumbnailPath = copyGalleryThumbnailPath;
module.exports.copySceneLabelPhoto = copySceneLabelPhoto;
module.exports.removeClonedSceneLabelPhotos = removeClonedSceneLabelPhotos;
