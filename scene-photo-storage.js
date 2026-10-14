// Photos live in private Supabase Storage and are signed at read time.
const { createClient } = require('@supabase/supabase-js');
const { pool, getSiteId } = require('./supabase-db');
const BUCKET = 'sitenav-scene-photos';
const MAX_PHOTO_BYTES = 650_000;
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

function decodeJpegDataUrl(dataUrl) {
  const prefix = 'data:image/jpeg;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
    throw Object.assign(new Error('A JPEG photo is required'), { status: 400 });
  }
  const encoded = dataUrl.slice(prefix.length);
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded) ||
      encoded.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 4) {
    throw Object.assign(new Error('Invalid or oversized JPEG'), { status: 413 });
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 4 || bytes.length > MAX_PHOTO_BYTES ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff ||
      bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw Object.assign(new Error('Invalid or oversized JPEG'), { status: 400 });
  }
  return bytes;
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
  } else {
    if (error && !/not found|404|does not exist/i.test(String(error.message || ''))) throw error;
    const { error: createError } = await storage.createBucket(BUCKET, {
      public: false, fileSizeLimit: '1MB', allowedMimeTypes: ['image/jpeg'],
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

async function withSignedPhotos(objects) {
  return Promise.all(objects.map(async obj => {
    if (obj.kind !== 'label') return obj;
    const props = { ...(obj.props || {}) };
    // The signed object must belong to THIS scene and THIS object.
    props.photoUrl = props.photoPath === photoPath(obj.sceneId, obj.id)
      ? await signPhoto(props.photoPath) : null;
    return { ...obj, props };
  }));
}

module.exports = { BUCKET, MAX_PHOTO_BYTES, photoPath, decodeJpegDataUrl,
  assertOwnsLabel, uploadPhoto, deletePhoto, signPhoto, withSignedPhotos };

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

module.exports.copySceneLabelPhoto = copySceneLabelPhoto;
module.exports.removeClonedSceneLabelPhotos = removeClonedSceneLabelPhotos;
