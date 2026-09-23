// scenes-db.js — server-side CRUD for scenes (Scenes feature, Slice 2).
//
// A scene is a named, shareable set of scene-scoped objects/pins. Admin CRUD
// is editor+ (enforced by the caller — server.js's _requireSiteEditor). The
// share_code is a global opaque capability token, generated server-side (a
// client can never set it); the public read path (Slice 3) resolves a scene
// by that code. Mirrors scripts-db.js/webhooks-db.js: shared pool,
// getSiteId, appendAudit, cross-tenant guard.

const crypto = require('crypto');
const supabaseDb = require('./supabase-db');
const { j } = supabaseDb;
const { staffScene, publicSharedScene, publicMyPinScene, publicSharedPoint, publicContact, publicPointPhoto } = require('./data-projections');
const { sceneObjectToJson } = require('./scene-db');
const hazardDb = require('./hazard-db');
const myPinCapabilities = require('./my-pin-capabilities-db');

// 'admin' scenes are the public admin map (share link open to anyone);
// 'hazard' scenes are the hazard report map (share link needs a session).
const KINDS = new Set(['admin', 'hazard']);
const STATUSES = new Set(['open', 'escalated', 'resolved']);

function _getPool() {
  return supabaseDb.pool();
}
function getSiteId(slug) {
  return supabaseDb.getSiteId(slug);
}
function appendAudit(...args) {
  return supabaseDb.appendAudit(...args);
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



function _validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LEN) {
    throw new Error(`name must be a non-empty string of at most ${MAX_NAME_LEN} characters`);
  }
}

// A user's list for one kind: scenes they created, scenes they opened via a
// share link (scene_subscriptions), and ownerless legacy scenes. Without a
// profileId (should not happen — the route requires a session) it degrades
// to the ownerless set.
async function listScenes(slug, { kind = 'admin', profileId = null } = {}) {
  if (!KINDS.has(kind)) throw new Error('invalid scene kind');
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    `select s.id, s.name, s.share_code, s.camera, s.kind, s.status, s.status_changed_at,
            s.created_by, s.created_at, s.updated_at,
            p.email as created_by_email, sc.email as status_changed_by_email,
            (s.created_by is not null and s.created_by = $3::uuid) as is_mine,
            exists (select 1 from scene_subscriptions ss where ss.scene_id = s.id and ss.profile_id = $3::uuid) as subscribed
     from scenes s
     left join profiles p  on p.id = s.created_by
     left join profiles sc on sc.id = s.status_changed_by
     where s.site_id = $1 and s.kind = $2
       and (s.created_by is null or s.created_by = $3::uuid
            or exists (select 1 from scene_subscriptions ss where ss.scene_id = s.id and ss.profile_id = $3::uuid))
     order by s.created_at`,
    [siteId, kind, profileId]
  );
  return rows.map(staffScene);
}

async function setSceneStatus(sceneId, status, changedBy) {
  if (!STATUSES.has(status)) throw new Error('invalid status');
  const { rows } = await _getPool().query(
    `update scenes set status = $2, status_changed_at = now(), status_changed_by = $3
     where id = $1 returning id, status, status_changed_at, site_id, name`,
    [sceneId, status, changedBy]
  );
  if (!rows.length) throw new Error('scene not found');
  await appendAudit(rows[0].site_id, changedBy, `status:${status}`, 'scene', sceneId, rows[0].name);
  return { id: rows[0].id, status: rows[0].status, statusChangedAt: rows[0].status_changed_at };
}

async function subscribe(sceneId, profileId) {
  if (!profileId) return;
  await _getPool().query(
    'insert into scene_subscriptions (scene_id, profile_id) values ($1, $2) on conflict do nothing',
    [sceneId, profileId]
  );
}

async function unsubscribe(sceneId, profileId) {
  await _getPool().query('delete from scene_subscriptions where scene_id = $1 and profile_id = $2', [sceneId, profileId]);
}

// Scene + its site slug from a share code (for the by-code status/escalate
// routes, which have no :slug in the URL).
async function getSceneByCode(code) {
  if (typeof code !== 'string' || !code) return null;
  const { rows } = await _getPool().query(
    `select s.id, s.site_id, s.kind, s.status, s.share_code, s.name, s.camera, s.created_by, si.slug
     from scenes s join sites si on si.id = s.site_id where s.share_code = $1`,
    [code]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { id: r.id, siteId: r.site_id, slug: r.slug, kind: r.kind, status: r.status, shareCode: r.share_code, name: r.name, camera: r.camera, createdBy: r.created_by };
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Minimal row for authorization decisions (owner / kind) — no joins.
async function getSceneMeta(slug, id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    'select id, kind, status, created_by, share_code, name, camera from scenes where id = $1 and site_id = $2', [id, siteId]
  );
  return rows.length ? { id: rows[0].id, kind: rows[0].kind, status: rows[0].status, createdBy: rows[0].created_by, shareCode: rows[0].share_code, name: rows[0].name, camera: rows[0].camera } : null;
}

async function createScene(slug, { name, camera, kind = 'admin' } = {}, changedBy = null) {
  _validateName(name);
  if (!KINDS.has(kind)) throw new Error('invalid scene kind');
  const siteId = await getSiteId(slug);
  // Retry on the (astronomically unlikely) share_code collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = _genCode();
    try {
      const { rows } = await _getPool().query(
        `insert into scenes (site_id, name, share_code, camera, created_by, kind)
         values ($1, $2, $3, $4::jsonb, $5, $6)
         returning id, name, share_code, camera, kind, created_by, created_at, updated_at`,
        [siteId, name, code, j(camera ?? null), changedBy, kind]
      );
      await appendAudit(siteId, changedBy, 'create', 'scene', rows[0].id, name);
      return staffScene(rows[0]);
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
     returning id, name, share_code, camera, kind, created_by, created_at, updated_at`,
    [id, siteId, name ?? null, camera !== undefined ? j(camera) : null]
  );
  if (!rows.length) throw new Error(`Scene ${id} belongs to a different site`);
  await appendAudit(siteId, changedBy, 'update', 'scene', id, rows[0].name);
  return staffScene(rows[0]);
}

// ── Public read-by-code (Scenes feature, Slice 3) — SECURITY-CRITICAL ─────
//
// Resolves a share code to exactly one scene's bundle for an ANONYMOUS
// visitor. This is the ONLY path that returns scene data without a session,
// and it deliberately bypasses the site's published gate — because the code
// IS the authorization for this one scene's (intentionally-shared) content,
// which is strictly narrower than "the whole site is published".
//
// Invariants that make it safe (a single missing one = cross-tenant leak,
// since the service-role pool bypasses RLS):
//   * site_id is derived FROM the scene row (line below), NEVER from the
//     request — so the caller cannot pivot to another tenant.
//   * every subsequent query filters by BOTH scene_id AND that derived
//     site_id — so no base data (scene_id IS NULL), no other scene, and no
//     other site can ever be returned.
//   * only scope='shared' scene pins are exposed by the capability; personal
//     pins remain owner-only through authenticated management routes.
//   * contacts are the union of THIS scene's SHARED pins' contact_ids only.
//   * unknown/deleted code → null (server returns a uniform 404, no
//     existence or timing distinction).
async function getSceneBundleByCode(code, viewerProfileId = null) {
  if (typeof code !== 'string' || !code) return null;
  const pool = _getPool();

  const sceneRes = await pool.query(
    `select s.id, s.site_id, s.name, s.camera, s.kind, s.status, s.status_changed_at, s.created_by,
            p.email as created_by_email, sc.email as status_changed_by_email
     from scenes s left join profiles p on p.id = s.created_by left join profiles sc on sc.id = s.status_changed_by
     where s.share_code = $1`,
    [code]
  );
  if (!sceneRes.rows.length) return null;
  const scene = sceneRes.rows[0];
  const sceneId = scene.id;
  const siteId = scene.site_id; // authoritative — from the scene row, not the request

  // My Pins is an account-owned workspace, not a scene-wide public guide.
  // Anonymous recipients must use the point-qualified capability below so a
  // scene code can never reveal every published pin in the workspace.
  const isMyPins = (scene.kind || 'admin') === 'admin'
    && scene.camera && typeof scene.camera === 'object'
    && scene.camera.purpose === 'my-pins-v1';
  if (isMyPins && !viewerProfileId) return null;

  const objectsRes = await pool.query(
    `select o.*, s.source as script_source
     from scene_objects o
     left join scripts s on s.id = o.script_id and s.site_id = o.site_id
     where o.scene_id = $1 and o.site_id = $2
     order by o.z_index, o.created_at`,
    [sceneId, siteId]
  );

  const pinsRes = await pool.query(
    "select * from points where scene_id = $1 and site_id = $2 and scope = 'shared' order by created_at",
    [sceneId, siteId]
  );

  const contactsRes = await pool.query(
    `select * from contacts
     where site_id = $2 and active = true
     and id = any(select distinct unnest(contact_ids) from points where scene_id = $1 and site_id = $2 and scope = 'shared')`,
    [sceneId, siteId]
  );

  // Hazard scenes carry their photo index (bytes served via the login-gated
  // /api/hazard-photos/:id proxy, never a public URL).
  const photos = scene.kind === 'hazard' ? await hazardDb.listPhotosForScene(siteId, sceneId) : [];

  return {
    scene: publicSharedScene(scene, { includeAuditEmails: Boolean(viewerProfileId) }),
    // Present only for signed-in viewers (server fills it in).
    viewer: viewerProfileId ? { signedIn: true, isMine: scene.created_by === viewerProfileId } : { signedIn: false, isMine: false },
    objects: objectsRes.rows.map(sceneObjectToJson),
    pins: pinsRes.rows.map(publicSharedPoint),
    contacts: contactsRes.rows.map(row => publicContact(row)),
    photos,
  };
}

// Public per-pin bearer capability for account-owned My Pins. The capability
// resolver binds the token hash to one active shared point and its exact
// site/scene/purpose before any contact or photo metadata is projected.
async function getSharedMyPinByCapability(token, pointId) {
  const binding = await myPinCapabilities.resolveActivePublicBinding(token, pointId);
  if (!binding) return null;
  const pool = _getPool();
  const siteId = binding.site_id;
  const pointIdBound = binding.point_id;

  const contactIds = Array.isArray(binding.contact_ids) ? binding.contact_ids : [];
  const contactsRes = contactIds.length
    ? await pool.query(
        `select id, name, role, phone, active
           from contacts
          where site_id = $1::uuid and id = any($2::uuid[]) and active = true`,
        [siteId, contactIds]
      )
    : { rows: [] };

  const photosRes = await pool.query(
    `select ph.id, ph.point_id, ph.bytes, ph.width, ph.height, ph.expires_at
       from point_photos ph
      where ph.site_id = $1::uuid and ph.point_id = $2::uuid
        and (ph.expires_at is null or ph.expires_at > now())
      order by ph.created_at`,
    [siteId, pointIdBound]
  );

  const point = publicSharedPoint(binding);
  const phoneOverride = point.phoneOverride || null;
  const contacts = contactsRes.rows.map(row => publicContact(row, { phoneOverride }));
  point.contactIds = contacts.map(contact => contact.id);
  const photos = photosRes.rows.map(publicPointPhoto);

  return {
    scene: publicMyPinScene({ name: binding.scene_name, kind: 'admin' }),
    viewer: { signedIn: false, isMine: false },
    objects: [],
    pins: [point],
    contacts,
    photos,
  };
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

async function deleteScene(slug, id, changedBy = null) {
  const siteId = await getSiteId(slug);
  const pool = _getPool();
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  try {
    await client.query('BEGIN');
    const sceneRes = await client.query(
      'select id, name from scenes where id = $1 and site_id = $2 for update',
      [id, siteId]
    );
    if (!sceneRes.rows.length) {
      await client.query('COMMIT');
      return;
    }
    const photoRes = await client.query(
      `select 1 from point_photos ph
         join points p on p.id = ph.point_id and p.site_id = ph.site_id
       where ph.site_id = $1 and p.scene_id = $2
       limit 1`,
      [siteId, id]
    );
    if (photoRes.rows.length) {
      const err = new Error('SCENE_HAS_POINT_PHOTOS');
      err.status = 409;
      err.code = 'SCENE_HAS_POINT_PHOTOS';
      throw err;
    }
    const sceneName = sceneRes.rows[0].name;
    await client.query(
      'delete from scenes where id = $1 and site_id = $2',
      [id, siteId]
    );
    await client.query(
      `insert into audit_log (site_id, changed_by, action, entity_type, entity_id, entity_label)
       values ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
      [siteId, changedBy, 'delete', 'scene', id, sceneName]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    if (typeof client.release === 'function') client.release();
  }
}

module.exports = {
  KINDS,
  STATUSES,
  listScenes,
  getSceneMeta,
  getSceneByCode,
  setSceneStatus,
  subscribe,
  unsubscribe,
  createScene,
  updateScene,
  deleteScene,
  sceneHasPointPhotos,
  getSceneBundleByCode,
  getSharedMyPinByCapability,
};
