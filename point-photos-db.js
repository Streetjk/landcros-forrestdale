// point-photos-db.js — server-side data layer for photos on admin-map pins
// (the `points` table), stored in a private Supabase Storage bucket.
//
// Modelled directly on hazard-db.js. Two differences, both deliberate:
//   - photos hang off points(id), not scene_objects(id), so this is a
//     separate table (see 0012_point_photos.sql for why);
//   - expires_at is nullable — 30 days by default, NULL meaning "keep
//     indefinitely", chosen per photo. Hazard photos always expire.
//
// Trust boundary: same as hazard-db.js — service-role pool + service-role
// Storage client, authorization enforced by server.js before calling in.
// Every query filters by the site_id derived from the slug, never from the
// request body.

const { createClient } = require('@supabase/supabase-js');
const supabaseDb = require('./supabase-db');

const BUCKET = 'point-photos';
const RETENTION_DAYS = 30;
const MAX_COMPRESSED_BYTES = 400 * 1024;        // client targets <=300 KB; small headroom
const MAX_ORIGINAL_BYTES = 15 * 1024 * 1024;    // phone photos are 3-8 MB
const MAX_PHOTOS_PER_POINT = 6;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

function _getPool() { return supabaseDb.pool(); }
function getSiteId(slug) { return supabaseDb.getSiteId(slug); }

let _storage = null;
let _bucketReady = null;
function _getStorage() {
  if (!_storage) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY must be set for photo storage');
    _storage = createClient(url, key, { auth: { persistSession: false } }).storage;
  }
  return _storage;
}

function _setStorageForTesting(storage, bucketReady = true) {
  _storage = storage;
  _bucketReady = bucketReady ? Promise.resolve() : null;
}

// Creates the private bucket on first use; "already exists" is fine.
async function _ensureBucket() {
  if (!_bucketReady) {
    _bucketReady = (async () => {
      const { error } = await _getStorage().createBucket(BUCKET, { public: false, fileSizeLimit: MAX_ORIGINAL_BYTES });
      if (error && !/already exists|duplicate/i.test(error.message || '')) {
        _bucketReady = null;
        throw new Error(`createBucket failed: ${error.message}`);
      }
    })();
  }
  return _bucketReady;
}

function photoToJson(r) {
  return {
    id: r.id,
    pointId: r.point_id,
    contentType: r.content_type,
    originalName: r.original_name,
    bytes: r.bytes,
    originalBytes: r.original_bytes,
    width: r.width,
    height: r.height,
    createdAt: r.created_at,
    expiresAt: r.expires_at,   // null = kept indefinitely
  };
}

class PointPhotoError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

// Legacy photo endpoints are BASE-only until scene-bound media capabilities
// are implemented. A private scene pin must not inherit these public-byte routes.
// Confirms the pin exists and belongs to this site. Personal browser pins never reach
// here — they live only in the browser's localStorage, so there is no row.
async function _resolvePoint(siteId, pointId) {
  const { rows } = await _getPool().query(
    'select id from points where id = $1 and site_id = $2 and scene_id is null',
    [pointId, siteId]
  );
  if (!rows.length) throw new PointPhotoError('not-found', 'pin not found (only shared pins can hold photos)');
  return rows[0];
}

async function listPhotos(slug, pointId) {
  const siteId = await getSiteId(slug);
  await _resolvePoint(siteId, pointId);
  const { rows } = await _getPool().query(
    'select * from point_photos where point_id = $1 and site_id = $2 order by created_at',
    [pointId, siteId]
  );
  return rows.map(photoToJson);
}

// Stores one photo (compressed + original buffers) and returns its row.
// keepIndefinitely=true stores expires_at NULL instead of the 30-day default.
async function addPhoto(slug, pointId, { compressed, original, contentType, originalName, width, height, keepIndefinitely }, changedBy) {
  if (!Buffer.isBuffer(compressed) || !compressed.length) throw new PointPhotoError('bad-request', 'compressed image required');
  if (!Buffer.isBuffer(original) || !original.length) throw new PointPhotoError('bad-request', 'original image required');
  if (compressed.length > MAX_COMPRESSED_BYTES) throw new PointPhotoError('too-large', 'compressed image over 400 KB');
  if (original.length > MAX_ORIGINAL_BYTES) throw new PointPhotoError('too-large', 'original image over 15 MB');
  if (!IMAGE_TYPES.has(contentType)) throw new PointPhotoError('bad-type', 'unsupported image type');

  const siteId = await getSiteId(slug);
  await _resolvePoint(siteId, pointId);

  const { rows: cnt } = await _getPool().query('select count(*)::int as n from point_photos where point_id = $1', [pointId]);
  if (cnt[0].n >= MAX_PHOTOS_PER_POINT) throw new PointPhotoError('limit', `at most ${MAX_PHOTOS_PER_POINT} photos per pin`);

  await _ensureBucket();
  const id = require('crypto').randomUUID();
  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : /heic|heif/.test(contentType) ? 'heic' : 'jpg';
  const base = `${siteId}/${pointId}/${id}`;
  const storagePath = `${base}.jpg`;
  const originalPath = `${base}-original.${ext}`;

  const st = _getStorage().from(BUCKET);
  const up1 = await st.upload(storagePath, compressed, { contentType: 'image/jpeg', upsert: false });
  if (up1.error) throw new Error(`storage upload failed: ${up1.error.message}`);
  const up2 = await st.upload(originalPath, original, { contentType, upsert: false });
  if (up2.error) { await st.remove([storagePath]); throw new Error(`storage upload failed: ${up2.error.message}`); }

  try {
    // Explicit expires_at: NULL for indefinite, otherwise the same 30-day
    // window the column default would have produced.
    const { rows } = await _getPool().query(
      `insert into point_photos (id, site_id, point_id, storage_path, original_path, original_name,
         content_type, bytes, original_bytes, width, height, created_by, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               case when $13::boolean then null else now() + ($14 || ' days')::interval end)
       returning *`,
      [id, siteId, pointId, storagePath, originalPath, originalName ?? null,
       contentType, compressed.length, original.length, width ?? null, height ?? null, changedBy,
       !!keepIndefinitely, String(RETENTION_DAYS)]
    );
    return photoToJson(rows[0]);
  } catch (e) {
    await st.remove([storagePath, originalPath]).catch(() => {});
    throw e;
  }
}

// Flips one photo between the 30-day window and "keep indefinitely".
async function setRetention(slug, photoId, keepIndefinitely) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    `update point_photos
        set expires_at = case when $3::boolean then null else now() + ($4 || ' days')::interval end
      where id = $1 and site_id = $2
        and exists (select 1 from points p where p.id = point_photos.point_id
          and p.site_id = point_photos.site_id and p.scene_id is null)
      returning *`,
    [photoId, siteId, !!keepIndefinitely, String(RETENTION_DAYS)]
  );
  if (!rows.length) throw new PointPhotoError('not-found');
  return photoToJson(rows[0]);
}

// Returns { buffer, contentType, row } for the compressed copy (panel proxy).
async function readPhoto(photoId, { original = false } = {}) {
  const { rows } = await _getPool().query(`select ph.* from point_photos ph join points p on p.id = ph.point_id and p.site_id = ph.site_id
     where ph.id = $1 and p.scene_id is null`, [photoId]);
  if (!rows.length) return null;
  const r = rows[0];
  const { data, error } = await _getStorage().from(BUCKET).download(original ? r.original_path : r.storage_path);
  if (error) throw new Error(`storage download failed: ${error.message}`);
  return { buffer: Buffer.from(await data.arrayBuffer()), contentType: original ? r.content_type : 'image/jpeg', row: r };
}

async function _removeRows(rows) {
  if (!rows.length) return 0;
  const paths = rows.flatMap((r) => [r.storage_path, r.original_path]);
  // Storage first; if that fails the rows stay and the next sweep retries.
  const { error } = await _getStorage().from(BUCKET).remove(paths);
  if (error) throw new Error(`storage remove failed: ${error.message}`);
  await _getPool().query('delete from point_photos where id = any($1::uuid[])', [rows.map((r) => r.id)]);
  return rows.length;
}

async function deletePhoto(slug, photoId) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(`select ph.* from point_photos ph join points p on p.id = ph.point_id and p.site_id = ph.site_id
     where ph.id = $1 and ph.site_id = $2 and p.scene_id is null`, [photoId, siteId]);
  if (!rows.length) throw new PointPhotoError('not-found');
  await _removeRows(rows);
}

// Called before a point row is deleted (the FK cascade would drop the rows
// but leave the files behind).
async function deletePhotosForPoint(slug, pointId) {
  const siteId = await getSiteId(slug);
  // Legacy helper is base-only like every other admin-pin photo operation.
  // Scene media must use a scene-qualified authorization path.
  await _resolvePoint(siteId, pointId);
  const { rows } = await _getPool().query('select * from point_photos where point_id = $1 and site_id = $2', [pointId, siteId]);
  return _removeRows(rows);
}

// Hourly sweep. `expires_at is not null` is redundant in SQL (NULL < now()
// evaluates to NULL, never true, so indefinite photos are already excluded)
// but stated explicitly so the intent survives future edits to this query.
let _sweeping = false;
async function sweepExpiredPhotos() {
  if (_sweeping) return 0;
  _sweeping = true;
  try {
    const { rows } = await _getPool().query(
      'select * from point_photos where expires_at is not null and expires_at < now() order by expires_at limit 200'
    );
    const n = await _removeRows(rows);
    if (n) console.log(`[point-photos] swept ${n} expired photo(s)`);
    return n;
  } finally {
    _sweeping = false;
  }
}

module.exports = {
  PointPhotoError,
  MAX_COMPRESSED_BYTES,
  MAX_ORIGINAL_BYTES,
  MAX_PHOTOS_PER_POINT,
  RETENTION_DAYS,
  IMAGE_TYPES,
  listPhotos,
  addPhoto,
  setRetention,
  readPhoto,
  deletePhoto,
  deletePhotosForPoint,
  sweepExpiredPhotos,
  // Scene-qualified point photo operations
  listScenePointPhotos,
  addScenePointPhoto,
  readScenePointPhoto,
  readSharedScenePointPhotoByCode,
  setScenePointPhotoRetention,
  deleteScenePointPhoto,
  sceneHasPointPhotos,
  _setStorageForTesting,
};

// ── Scene-qualified point photos (authenticated scene-owner only) ─────────

async function _resolveScenePoint(siteId, sceneId, pointId) {
  const { rows } = await _getPool().query(
    'select id from points where id = $1 and site_id = $2 and scene_id = $3',
    [pointId, siteId, sceneId]
  );
  if (!rows.length) throw new PointPhotoError('point-not-found', 'point not found in this scene');
  return rows[0];
}

async function listScenePointPhotos(slug, sceneId, pointId) {
  const siteId = await getSiteId(slug);
  await _resolveScenePoint(siteId, sceneId, pointId);
  const { rows } = await _getPool().query(
    `select ph.* from point_photos ph
       join points p on p.id = ph.point_id and p.site_id = ph.site_id
     where ph.site_id = $1 and p.scene_id = $2 and ph.point_id = $3
     order by ph.created_at`,
    [siteId, sceneId, pointId]
  );
  return rows.map(photoToJson);
}

async function addScenePointPhoto(slug, sceneId, pointId, { compressed, original, contentType, originalName, width, height, keepIndefinitely }, changedBy) {
  if (!Buffer.isBuffer(compressed) || !compressed.length) throw new PointPhotoError('bad-request', 'compressed image required');
  if (!Buffer.isBuffer(original) || !original.length) throw new PointPhotoError('bad-request', 'original image required');
  if (compressed.length > MAX_COMPRESSED_BYTES) throw new PointPhotoError('too-large', 'compressed image over 400 KB');
  if (original.length > MAX_ORIGINAL_BYTES) throw new PointPhotoError('too-large', 'original image over 15 MB');
  if (!IMAGE_TYPES.has(contentType)) throw new PointPhotoError('bad-type', 'unsupported image type');

  const siteId = await getSiteId(slug);
  await _resolveScenePoint(siteId, sceneId, pointId);

  const { rows: cnt } = await _getPool().query(
    `select count(*)::int as n
       from point_photos ph
       join points p on p.id = ph.point_id and p.site_id = ph.site_id
     where ph.site_id = $1 and p.scene_id = $2 and ph.point_id = $3`,
    [siteId, sceneId, pointId]
  );
  if (cnt[0].n >= MAX_PHOTOS_PER_POINT) throw new PointPhotoError('limit', `at most ${MAX_PHOTOS_PER_POINT} photos per pin`);

  await _ensureBucket();
  const id = require('crypto').randomUUID();
  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : /heic|heif/.test(contentType) ? 'heic' : 'jpg';
  const base = `${siteId}/${pointId}/${id}`;
  const storagePath = `${base}.jpg`;
  const originalPath = `${base}-original.${ext}`;

  const st = _getStorage().from(BUCKET);
  const up1 = await st.upload(storagePath, compressed, { contentType: 'image/jpeg', upsert: false });
  if (up1.error) throw new Error(`storage upload failed: ${up1.error.message}`);
  const up2 = await st.upload(originalPath, original, { contentType, upsert: false });
  if (up2.error) { await st.remove([storagePath]); throw new Error(`storage upload failed: ${up2.error.message}`); }

  const pool = _getPool();
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  try {
    await client.query('BEGIN');

    const sceneRes = await client.query(
      'select id from scenes where id = $1 and site_id = $2 for update',
      [sceneId, siteId]
    );
    if (!sceneRes.rows.length) {
      throw new PointPhotoError('point-not-found', 'scene not found');
    }

    const pointRes = await client.query(
      'select id from points where id = $1 and site_id = $2 and scene_id = $3',
      [pointId, siteId, sceneId]
    );
    if (!pointRes.rows.length) {
      throw new PointPhotoError('point-not-found', 'point not found in this scene');
    }

    const { rows: recheckCnt } = await client.query(
      `select count(*)::int as n
         from point_photos ph
         join points p on p.id = ph.point_id and p.site_id = ph.site_id
       where ph.site_id = $1 and p.scene_id = $2 and ph.point_id = $3`,
      [siteId, sceneId, pointId]
    );
    if ((recheckCnt[0]?.n ?? 0) >= MAX_PHOTOS_PER_POINT) {
      throw new PointPhotoError('limit', `at most ${MAX_PHOTOS_PER_POINT} photos per pin`);
    }

    const { rows } = await client.query(
      `insert into point_photos (id, site_id, point_id, storage_path, original_path, original_name,
         content_type, bytes, original_bytes, width, height, created_by, expires_at)
       select $1, $2, p.id, $4, $5, $6, $7, $8, $9, $10, $11, $12,
              case when $13::boolean then null else now() + ($14 || ' days')::interval end
       from points p
       where p.id = $3 and p.site_id = $2 and p.scene_id = $15
       returning *`,
      [id, siteId, pointId, storagePath, originalPath, originalName ?? null,
       contentType, compressed.length, original.length, width ?? null, height ?? null, changedBy,
       !!keepIndefinitely, String(RETENTION_DAYS), sceneId]
    );
    if (!rows.length) throw new PointPhotoError('point-not-found', 'pin not found in this scene');

    await client.query('COMMIT');
    return photoToJson(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    await st.remove([storagePath, originalPath]).catch(() => {});
    throw e;
  } finally {
    if (typeof client.release === 'function') client.release();
  }
}

async function readScenePointPhoto(slug, sceneId, pointId, photoId, { original = false } = {}) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    `select ph.* from point_photos ph
       join points p on p.id = ph.point_id and p.site_id = ph.site_id
     where ph.id = $1 and ph.site_id = $2 and p.scene_id = $3 and ph.point_id = $4`,
    [photoId, siteId, sceneId, pointId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  const { data, error } = await _getStorage().from(BUCKET).download(original ? r.original_path : r.storage_path);
  if (error) throw new Error(`storage download failed: ${error.message}`);
  return { buffer: Buffer.from(await data.arrayBuffer()), contentType: original ? r.content_type : 'image/jpeg', row: r };
}

// Anonymous My Pins photo read. The scene code is resolved inside the same
// query and the point must still be explicitly shared; revocation therefore
// takes effect before any storage bytes are fetched.
async function readSharedScenePointPhotoByCode(sceneCode, pointId, photoId) {
  const { rows } = await _getPool().query(
    `select ph.* from scenes s
       join points p on p.scene_id = s.id and p.site_id = s.site_id
       join point_photos ph on ph.point_id = p.id and ph.site_id = p.site_id
      where s.share_code = $1
        and s.kind = 'admin'
        and s.camera->>'purpose' = 'my-pins-v1'
        and p.id = $2
        and p.scope = 'shared'
        and ph.id = $3
        and (ph.expires_at is null or ph.expires_at > now())`,
    [sceneCode, pointId, photoId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  const { data, error } = await _getStorage().from(BUCKET).download(r.storage_path);
  if (error) throw new Error(`storage download failed: ${error.message}`);
  return { buffer: Buffer.from(await data.arrayBuffer()), contentType: 'image/jpeg', row: r };
}

async function setScenePointPhotoRetention(slug, sceneId, pointId, photoId, keepIndefinitely) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    `update point_photos
        set expires_at = case when $5::boolean then null else now() + ($6 || ' days')::interval end
      where id = $1 and site_id = $2 and point_id = $3
        and exists (select 1 from points p where p.id = point_photos.point_id
          and p.site_id = point_photos.site_id and p.scene_id = $4)
      returning *`,
    [photoId, siteId, pointId, sceneId, !!keepIndefinitely, String(RETENTION_DAYS)]
  );
  if (!rows.length) throw new PointPhotoError('not-found');
  return photoToJson(rows[0]);
}

async function deleteScenePointPhoto(slug, sceneId, pointId, photoId) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    `select ph.* from point_photos ph
       join points p on p.id = ph.point_id and p.site_id = ph.site_id
     where ph.id = $1 and ph.site_id = $2 and p.scene_id = $3 and ph.point_id = $4`,
    [photoId, siteId, sceneId, pointId]
  );
  if (!rows.length) throw new PointPhotoError('not-found');
  await _removeRows(rows);
}

async function sceneHasPointPhotos(slug, sceneId) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    `select 1 from point_photos ph
       join points p on p.id = ph.point_id and p.site_id = ph.site_id
     where ph.site_id = $1 and p.scene_id = $2
     limit 1`,
    [siteId, sceneId]
  );
  return rows.length > 0;
}
