// scenes-db.js — server-side CRUD for scenes (Scenes feature, Slice 2).
//
// A scene is a named, shareable set of scene-scoped objects/pins. Admin CRUD
// is editor+ (enforced by the caller — server.js's _requireSiteEditor). The
// share_code is a global opaque capability token, generated server-side (a
// client can never set it); the public read path (Slice 3) resolves a scene
// by that code. Mirrors scripts-db.js/webhooks-db.js: shared pool,
// getSiteId, appendAudit, cross-tenant guard.

const crypto = require('crypto');
const { pool: sharedPool, getSiteId, j, appendAudit } = require('./supabase-db');

function _getPool() {
  return sharedPool();
}

const MAX_NAME_LEN = 120;
// Unambiguous alphabet (no 0/o/1/l), 10 chars → ~32^10 ≈ 2^50 space. Crypto
// random, uniqueness enforced by the DB constraint + retry-on-conflict.
const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const CODE_LEN = 10;

function _genCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function sceneToJson(r) {
  return {
    id: r.id,
    name: r.name,
    shareCode: r.share_code,
    camera: r.camera,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function _validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LEN) {
    throw new Error(`name must be a non-empty string of at most ${MAX_NAME_LEN} characters`);
  }
}

async function listScenes(slug) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    'select id, name, share_code, camera, created_at, updated_at from scenes where site_id = $1 order by created_at',
    [siteId]
  );
  return rows.map(sceneToJson);
}

async function createScene(slug, { name, camera } = {}, changedBy = null) {
  _validateName(name);
  const siteId = await getSiteId(slug);
  // Retry on the (astronomically unlikely) share_code collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = _genCode();
    try {
      const { rows } = await _getPool().query(
        `insert into scenes (site_id, name, share_code, camera, created_by)
         values ($1, $2, $3, $4::jsonb, $5)
         returning id, name, share_code, camera, created_at, updated_at`,
        [siteId, name, code, j(camera ?? null), changedBy]
      );
      await appendAudit(siteId, changedBy, 'create', 'scene', rows[0].id, name);
      return sceneToJson(rows[0]);
    } catch (e) {
      if (e.code === '23505' && /share_code/.test(e.detail || e.message || '')) continue; // unique violation on code → retry
      throw e;
    }
  }
  throw new Error('could not generate a unique share code');
}

async function updateScene(slug, id, { name, camera } = {}, changedBy = null) {
  const siteId = await getSiteId(slug);
  if (name !== undefined) _validateName(name);
  const { rows } = await _getPool().query(
    `update scenes set name = coalesce($3, name), camera = coalesce($4::jsonb, camera)
     where id = $1 and site_id = $2
     returning id, name, share_code, camera, created_at, updated_at`,
    [id, siteId, name ?? null, camera !== undefined ? j(camera) : null]
  );
  if (!rows.length) throw new Error(`Scene ${id} belongs to a different site`);
  await appendAudit(siteId, changedBy, 'update', 'scene', id, rows[0].name);
  return sceneToJson(rows[0]);
}

async function deleteScene(slug, id, changedBy = null) {
  const siteId = await getSiteId(slug);
  // ON DELETE CASCADE removes this scene's scene_objects and scene-pins.
  const { rows } = await _getPool().query(
    'delete from scenes where id = $1 and site_id = $2 returning name',
    [id, siteId]
  );
  if (rows.length) await appendAudit(siteId, changedBy, 'delete', 'scene', id, rows[0].name);
}

module.exports = {
  listScenes,
  createScene,
  updateScene,
  deleteScene,
};
