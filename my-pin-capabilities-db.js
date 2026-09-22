'use strict';

const crypto = require('node:crypto');
const supabaseDb = require('./supabase-db');

const PointError = supabaseDb.PointWriteError;
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURPOSE = 'my-pins-v1';

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function isValidToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

function hashToken(token) {
  if (!isValidToken(token)) return null;
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function canonicalUuid(value, code) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new PointError(400, code);
  return value.toLowerCase();
}
function cameraPurpose(camera) {
  if (camera && typeof camera === 'object' && !Array.isArray(camera)) return camera.purpose || null;
  if (typeof camera === 'string') {
    try {
      const parsed = JSON.parse(camera);
      return parsed && typeof parsed === 'object' ? parsed.purpose || null : null;
    } catch (_) {}
  }
  return null;
}

async function lockOwnedMyPin(client, siteId, sceneId, pointId, actorId, { requireShared = false } = {}) {
  const { rows } = await client.query(
    `select p.id, p.label, p.scope, s.kind as scene_kind, s.camera as scene_camera,
            s.created_by as scene_created_by
       from points p
       join scenes s on s.id = p.scene_id and s.site_id = p.site_id
      where p.site_id = $1::uuid and p.scene_id = $2::uuid and p.id = $3::uuid
      for update of p, s`,
    [siteId, sceneId, pointId]
  );
  if (!rows.length) throw new PointError(404, 'MY_PIN_NOT_FOUND');
  const row = rows[0];
  const owner = typeof row.scene_created_by === 'string' ? row.scene_created_by.toLowerCase() : null;
  if (row.scene_kind !== 'admin' || cameraPurpose(row.scene_camera) !== PURPOSE || owner !== actorId) {
    throw new PointError(403, 'MY_PIN_OWNER_REQUIRED');
  }
  if (requireShared && row.scope !== 'shared') throw new PointError(409, 'MY_PIN_NOT_SHARED');
  return row;
}

async function issueOrRotate(slug, sceneId, pointId, actorId) {
  const scene = canonicalUuid(sceneId, 'INVALID_SCENE_ID');
  const point = canonicalUuid(pointId, 'INVALID_POINT_ID');
  const actor = canonicalUuid(actorId, 'INVALID_ACTOR_ID');
  const siteId = await supabaseDb.getSiteId(slug);
  const client = await supabaseDb.pool().connect();
  try {
    await client.query('BEGIN');
    const current = await lockOwnedMyPin(client, siteId, scene, point, actor, { requireShared: true });
    const active = await client.query(
      `select id from my_pin_capabilities
        where site_id = $1::uuid and scene_id = $2::uuid and point_id = $3::uuid
          and purpose = $4 and revoked_at is null
        for update`,
      [siteId, scene, point, PURPOSE]
    );
    let rotatedFrom = null;
    if (active.rows.length) {
      rotatedFrom = active.rows[0].id;
      await client.query(
        `update my_pin_capabilities set revoked_at = now(), revoked_by = $4::uuid
          where site_id = $1::uuid and scene_id = $2::uuid and point_id = $3::uuid
            and purpose = $5 and revoked_at is null`,
        [siteId, scene, point, actor, PURPOSE]
      );
    }
    const token = generateToken();
    const tokenHash = hashToken(token);
    const inserted = await client.query(
      `insert into my_pin_capabilities
        (site_id, scene_id, point_id, purpose, token_hash, issued_by, rotated_from)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::uuid)
       returning id, issued_at`,
      [siteId, scene, point, PURPOSE, tokenHash, actor, rotatedFrom]
    );
    await client.query(
      `insert into audit_log (site_id, changed_by, action, entity_type, entity_id, entity_label)
       values ($1::uuid, $2::uuid, $3, 'point', $4::uuid, $5)`,
      [siteId, actor, rotatedFrom ? 'rotate-share-capability' : 'issue-share-capability', point, current.label]
    );
    await client.query('COMMIT');
    return {
      pointId: point,
      sceneId: scene,
      purpose: PURPOSE,
      token,
      capabilityId: inserted.rows[0].id,
      issuedAt: inserted.rows[0].issued_at,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
async function revoke(slug, sceneId, pointId, actorId) {
  const scene = canonicalUuid(sceneId, 'INVALID_SCENE_ID');
  const point = canonicalUuid(pointId, 'INVALID_POINT_ID');
  const actor = canonicalUuid(actorId, 'INVALID_ACTOR_ID');
  const siteId = await supabaseDb.getSiteId(slug);
  const client = await supabaseDb.pool().connect();
  try {
    await client.query('BEGIN');
    const current = await lockOwnedMyPin(client, siteId, scene, point, actor);
    const result = await client.query(
      `update my_pin_capabilities set revoked_at = now(), revoked_by = $4::uuid
        where site_id = $1::uuid and scene_id = $2::uuid and point_id = $3::uuid
          and purpose = $5 and revoked_at is null
        returning id`,
      [siteId, scene, point, actor, PURPOSE]
    );
    if (result.rows.length) {
      await client.query(
        `insert into audit_log (site_id, changed_by, action, entity_type, entity_id, entity_label)
         values ($1::uuid, $2::uuid, 'revoke-share-capability', 'point', $3::uuid, $4)`,
        [siteId, actor, point, current.label]
      );
    }
    await client.query('COMMIT');
    return { ok: true, revoked: result.rows.length > 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
module.exports = {
  TOKEN_BYTES,
  TOKEN_RE,
  PURPOSE,
  generateToken,
  isValidToken,
  hashToken,
  issueOrRotate,
  revoke,
};
