// hazard-db.js — server-side data layer for the hazard report map: photo
// storage (Supabase Storage, private bucket), notification emails with the
// original photos attached, and the 30-day photo sweep.
//
// Trust boundary: same as scenes-db.js — service-role pool + service-role
// Storage client, authorization enforced by server.js before calling in.
// Every query filters by the site_id derived from the slug, never from the
// request body.

const { createClient } = require('@supabase/supabase-js');
const { pool: sharedPool, getSiteId } = require('./supabase-db');
const mailer = require('./mailer');

const BUCKET = 'hazard-photos';
const RETENTION_DAYS = 30;
const MAX_COMPRESSED_BYTES = 400 * 1024;        // client targets <=300 KB; small headroom
const MAX_ORIGINAL_BYTES = 15 * 1024 * 1024;    // phone photos are 3-8 MB
const MAX_PHOTOS_PER_OBJECT = 6;
const MAX_ATTACHMENT_TOTAL = 30 * 1024 * 1024;  // Resend hard limit is 40 MB per email
const ALLOWED_DOMAIN = 'hcma.com.au';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

function _getPool() { return sharedPool(); }

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
    objectId: r.object_id,
    sceneId: r.scene_id,
    contentType: r.content_type,
    originalName: r.original_name,
    bytes: r.bytes,
    originalBytes: r.original_bytes,
    width: r.width,
    height: r.height,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

class HazardError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function recipientsValid(list) {
  if (!Array.isArray(list) || !list.length || list.length > 20) return false;
  return list.every((e) => typeof e === 'string' && /^[^@\s]+@[^@\s]+$/.test(e)
    && e.slice(e.lastIndexOf('@') + 1).toLowerCase() === ALLOWED_DOMAIN);
}

// Confirms the object exists, is a hazard pin, and belongs to (slug, sceneId).
async function _resolveHazardObject(siteId, objectId) {
  const { rows } = await _getPool().query(
    `select id, scene_id from scene_objects where id = $1 and site_id = $2 and kind = 'hazard'`,
    [objectId, siteId]
  );
  if (!rows.length) throw new HazardError('not-found', 'hazard object not found');
  return rows[0];
}

async function listPhotos(slug, objectId) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    'select * from hazard_photos where object_id = $1 and site_id = $2 order by created_at',
    [objectId, siteId]
  );
  return rows.map(photoToJson);
}

// Photos for every hazard object in a scene — attached to the by-code bundle.
async function listPhotosForScene(siteId, sceneId) {
  const { rows } = await _getPool().query(
    'select * from hazard_photos where scene_id = $1 and site_id = $2 order by created_at',
    [sceneId, siteId]
  );
  return rows.map(photoToJson);
}

// Stores one photo (compressed + original buffers) and returns its row.
async function addPhoto(slug, objectId, { compressed, original, contentType, originalName, width, height }, changedBy) {
  if (!Buffer.isBuffer(compressed) || !compressed.length) throw new HazardError('bad-request', 'compressed image required');
  if (!Buffer.isBuffer(original) || !original.length) throw new HazardError('bad-request', 'original image required');
  if (compressed.length > MAX_COMPRESSED_BYTES) throw new HazardError('too-large', 'compressed image over 400 KB');
  if (original.length > MAX_ORIGINAL_BYTES) throw new HazardError('too-large', 'original image over 15 MB');
  if (!IMAGE_TYPES.has(contentType)) throw new HazardError('bad-type', 'unsupported image type');

  const siteId = await getSiteId(slug);
  const obj = await _resolveHazardObject(siteId, objectId);

  const { rows: cnt } = await _getPool().query('select count(*)::int as n from hazard_photos where object_id = $1', [objectId]);
  if (cnt[0].n >= MAX_PHOTOS_PER_OBJECT) throw new HazardError('limit', `at most ${MAX_PHOTOS_PER_OBJECT} photos per pin`);

  await _ensureBucket();
  const id = require('crypto').randomUUID();
  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : /heic|heif/.test(contentType) ? 'heic' : 'jpg';
  const base = `${siteId}/${obj.scene_id}/${objectId}/${id}`;
  const storagePath = `${base}.jpg`;
  const originalPath = `${base}-original.${ext}`;

  const st = _getStorage().from(BUCKET);
  const up1 = await st.upload(storagePath, compressed, { contentType: 'image/jpeg', upsert: false });
  if (up1.error) throw new Error(`storage upload failed: ${up1.error.message}`);
  const up2 = await st.upload(originalPath, original, { contentType, upsert: false });
  if (up2.error) { await st.remove([storagePath]); throw new Error(`storage upload failed: ${up2.error.message}`); }

  try {
    const { rows } = await _getPool().query(
      `insert into hazard_photos (id, site_id, scene_id, object_id, storage_path, original_path, original_name,
         content_type, bytes, original_bytes, width, height, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *`,
      [id, siteId, obj.scene_id, objectId, storagePath, originalPath, originalName ?? null,
       contentType, compressed.length, original.length, width ?? null, height ?? null, changedBy]
    );
    return photoToJson(rows[0]);
  } catch (e) {
    await st.remove([storagePath, originalPath]).catch(() => {});
    throw e;
  }
}

// Returns { buffer, contentType } for the compressed copy (viewer proxy).
async function readPhoto(photoId, { original = false } = {}) {
  const { rows } = await _getPool().query('select * from hazard_photos where id = $1', [photoId]);
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
  await _getPool().query('delete from hazard_photos where id = any($1::uuid[])', [rows.map((r) => r.id)]);
  return rows.length;
}

async function deletePhoto(slug, photoId) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query('select * from hazard_photos where id = $1 and site_id = $2', [photoId, siteId]);
  if (!rows.length) throw new HazardError('not-found');
  await _removeRows(rows);
}

// Called before a hazard object or scene row is deleted (the FK cascade
// would drop the rows but leave the files behind).
async function deletePhotosForObject(slug, objectId) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query('select * from hazard_photos where object_id = $1 and site_id = $2', [objectId, siteId]);
  return _removeRows(rows);
}
async function deletePhotosForScene(slug, sceneId) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query('select * from hazard_photos where scene_id = $1 and site_id = $2', [sceneId, siteId]);
  return _removeRows(rows);
}

// Hourly sweep: photos past expires_at (30 days). Batched so one slow run
// can't pin the pool.
let _sweeping = false;
async function sweepExpiredPhotos() {
  if (_sweeping) return 0;
  _sweeping = true;
  try {
    const { rows } = await _getPool().query('select * from hazard_photos where expires_at < now() order by expires_at limit 200');
    const n = await _removeRows(rows);
    if (n) console.log(`[hazard] swept ${n} expired photo(s)`);
    return n;
  } finally {
    _sweeping = false;
  }
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Emails the scene's hazard pins (title + description) with every original
// photo attached, plus the login-gated share link. Records the send.
async function notifyScene(slug, sceneId, { recipients, message, shareUrl }, sentBy) {
  if (!recipientsValid(recipients)) throw new HazardError('bad-recipients', `recipients must be 1-20 @${ALLOWED_DOMAIN} addresses`);
  if (message != null && (typeof message !== 'string' || message.length > 4000)) throw new HazardError('bad-request', 'message too long');
  if (!mailer.isConfigured()) throw new HazardError('mail-unconfigured', 'RESEND_API_KEY is not set');

  const siteId = await getSiteId(slug);
  const pool = _getPool();
  const sceneRes = await pool.query(`select id, name from scenes where id = $1 and site_id = $2 and kind = 'hazard'`, [sceneId, siteId]);
  if (!sceneRes.rows.length) throw new HazardError('not-found', 'hazard scene not found');
  const scene = sceneRes.rows[0];

  const { rows: objects } = await pool.query(
    `select id, props from scene_objects where scene_id = $1 and site_id = $2 and kind = 'hazard' order by created_at`,
    [sceneId, siteId]
  );
  const { rows: photos } = await pool.query(
    'select * from hazard_photos where scene_id = $1 and site_id = $2 order by created_at',
    [sceneId, siteId]
  );

  // Attach originals up to the size cap; anything beyond is listed in the body.
  const attachments = [];
  const skipped = [];
  let total = 0;
  const st = _getStorage().from(BUCKET);
  for (const p of photos) {
    if (total + p.original_bytes > MAX_ATTACHMENT_TOTAL) { skipped.push(p); continue; }
    const { data, error } = await st.download(p.original_path);
    if (error) { skipped.push(p); continue; }
    const buf = Buffer.from(await data.arrayBuffer());
    total += buf.length;
    const ext = (p.original_path.split('.').pop() || 'jpg');
    attachments.push({ filename: p.original_name || `hazard-${p.id.slice(0, 8)}.${ext}`, content: buf.toString('base64') });
  }

  const lines = objects.map((o, i) => {
    const t = o.props?.title || `Hazard ${i + 1}`;
    const d = o.props?.description || '';
    const n = photos.filter((p) => p.object_id === o.id).length;
    return { t, d, n };
  });
  const subject = `Hazard report: ${scene.name}`;
  const text = [
    `Hazard report "${scene.name}" (${objects.length} pin${objects.length === 1 ? '' : 's'}).`,
    message ? `\n${message}\n` : '',
    ...lines.map((l) => `• ${l.t}${l.n ? ` (${l.n} photo${l.n === 1 ? '' : 's'})` : ''}\n  ${l.d}`),
    '', `Open the map (sign-in required): ${shareUrl}`,
    skipped.length ? `\n${skipped.length} photo(s) exceeded the email size limit and are only viewable on the map.` : '',
    `\nPhotos are kept for ${RETENTION_DAYS} days.`,
  ].join('\n');
  const html = `
    <div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:600px">
      <h2 style="margin:0 0 8px;font-size:18px">Hazard report: ${_esc(scene.name)}</h2>
      ${message ? `<p style="white-space:pre-wrap">${_esc(message)}</p>` : ''}
      <ol style="padding-left:20px">${lines.map((l) => `<li style="margin-bottom:8px"><strong>${_esc(l.t)}</strong>${l.n ? ` <span style="color:#666">(${l.n} photo${l.n === 1 ? '' : 's'})</span>` : ''}<br><span style="white-space:pre-wrap">${_esc(l.d)}</span></li>`).join('')}</ol>
      <p><a href="${_esc(shareUrl)}" style="display:inline-block;background:#B45309;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Open on the map</a><br><span style="color:#666;font-size:13px">Sign-in with your @${ALLOWED_DOMAIN} email is required.</span></p>
      ${skipped.length ? `<p style="color:#666;font-size:13px">${skipped.length} photo(s) exceeded the email size limit and are only viewable on the map.</p>` : ''}
      <p style="color:#666;font-size:13px">Original photos are attached. Photos are kept for ${RETENTION_DAYS} days.</p>
    </div>`;

  const results = [];
  for (const to of recipients) {
    results.push(await mailer.sendMail({ to, subject, text, html, attachments }));
  }
  const { rows } = await pool.query(
    `insert into hazard_notifications (site_id, scene_id, recipients, message, photo_count, sent_by, provider_id)
     values ($1, $2, $3, $4, $5, $6, $7) returning id, sent_at`,
    [siteId, sceneId, recipients, message ?? null, attachments.length, sentBy, results.map((r) => r.id).filter(Boolean).join(',') || null]
  );
  return { id: rows[0].id, sentAt: rows[0].sent_at, recipients, attached: attachments.length, skipped: skipped.length };
}

async function listNotifications(slug, sceneId) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    `select n.id, n.recipients, n.message, n.photo_count, n.sent_at, p.email as sent_by_email
     from hazard_notifications n left join profiles p on p.id = n.sent_by
     where n.scene_id = $1 and n.site_id = $2 order by n.sent_at desc limit 50`,
    [sceneId, siteId]
  );
  return rows.map((r) => ({ id: r.id, recipients: r.recipients, message: r.message, photoCount: r.photo_count, sentAt: r.sent_at, sentBy: r.sent_by_email }));
}

module.exports = {
  HazardError,
  ALLOWED_DOMAIN,
  MAX_COMPRESSED_BYTES,
  MAX_ORIGINAL_BYTES,
  MAX_PHOTOS_PER_OBJECT,
  RETENTION_DAYS,
  recipientsValid,
  listPhotos,
  listPhotosForScene,
  addPhoto,
  readPhoto,
  deletePhoto,
  deletePhotosForObject,
  deletePhotosForScene,
  sweepExpiredPhotos,
  notifyScene,
  listNotifications,
};
