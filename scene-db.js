// scene-db.js — server-side data-access layer for scene_objects (Phase 2 SLICE 2a).
//
// Backs the drag-drop editor's persistence API (server.js /api/sites/:slug/objects).
// Mirrors supabase-db.js's patterns exactly (shared pool, getSiteId, j() for
// jsonb columns, cross-tenant upsert guard, _appendAudit) since this is the
// same trust boundary: service-role pool, authorization enforced by the
// caller (server.js), not by RLS.

const { pool: sharedPool, getSiteId } = require('./supabase-db');

function _getPool() {
  return sharedPool();
}

// jsonb columns: JSON.stringify explicitly (mirrors supabase-db.js's j();
// not imported since supabase-db.js doesn't export it — this task's
// acceptance expects supabase-db.js untouched).
function j(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

// Must match the scene_objects.kind CHECK constraint in
// supabase/migrations/0001_schema.sql.
const ALLOWED_KINDS = new Set(['pin', 'label', 'button', 'widget', 'model', 'zone', 'hazard']);

function sceneObjectToJson(r) {
  return {
    id: r.id,
    sceneId: r.scene_id,
    kind: r.kind,
    transform: r.transform,
    style: r.style,
    props: r.props,
    scriptId: r.script_id,
    scriptSource: r.script_source ?? null, // joined in by listSceneObjects for 'widget' kind
    zIndex: r.z_index,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── Audit log (shared table with supabase-db.js's points/contacts) ─────────
async function _appendAudit(siteId, changedBy, action, entityType, entityId, entityLabel) {
  await _getPool().query(
    `insert into audit_log (site_id, changed_by, action, entity_type, entity_id, entity_label)
     values ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
    [siteId, changedBy, action, entityType, entityId, entityLabel]
  );
}

async function listSceneObjects(slug, sceneId = null) {
  const siteId = await getSiteId(slug);
  // LEFT JOIN scripts: a widget's script source rides along on the same
  // fetch the viewer already makes for scene_objects — no separate public
  // scripts-read route needed, same published/no-existence-leak gate applies.
  // The FK (scene_objects_script_id_fkey, see 0006_scripts.sql) already
  // requires script_id to belong to the same site — the join's explicit
  // `and s.site_id = o.site_id` is defense in depth, not the only guard.
  // sceneId scopes the editor to the currently-selected scene (Scenes Slice 4)
  // — every object belongs to exactly one scene, so an unscoped list would mix
  // objects from every scene into one canvas.
  const sql = sceneId
    ? `select o.*, s.source as script_source
       from scene_objects o
       left join scripts s on s.id = o.script_id and s.site_id = o.site_id
       where o.site_id = $1 and o.scene_id = $2
       order by o.z_index, o.created_at`
    : `select o.*, s.source as script_source
       from scene_objects o
       left join scripts s on s.id = o.script_id and s.site_id = o.site_id
       where o.site_id = $1
       order by o.z_index, o.created_at`;
  const { rows } = await _getPool().query(sql, sceneId ? [siteId, sceneId] : [siteId]);
  return rows.map(sceneObjectToJson);
}

// Gates the public (no-auth) read path: unpublished sites' scene objects
// must not be readable without at least viewer membership (server.js checks
// that separately when this is false).
async function isSitePublished(slug) {
  const { rows } = await _getPool().query('select published from sites where slug = $1', [slug]);
  return rows.length ? !!rows[0].published : false;
}

async function saveSceneObject(slug, obj, changedBy = null) {
  const siteId = await getSiteId(slug);
  if (!obj || !obj.id) throw new Error('object.id is required');
  if (!obj.sceneId) throw new Error('object.sceneId is required');
  if (!ALLOWED_KINDS.has(obj.kind)) throw new Error(`Invalid scene object kind: ${obj.kind}`);
  const { rows } = await _getPool().query(
    `insert into scene_objects (id, site_id, scene_id, kind, transform, style, props, script_id, z_index)
     values ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::uuid, $9)
     on conflict (id) do update set
       kind = excluded.kind, transform = excluded.transform, style = excluded.style,
       props = excluded.props, script_id = excluded.script_id, z_index = excluded.z_index,
       updated_at = now()
     where scene_objects.site_id = excluded.site_id
     returning *`,
    [
      obj.id, siteId, obj.sceneId, obj.kind, j(obj.transform || {}), j(obj.style || {}), j(obj.props || {}),
      obj.scriptId ?? null, obj.zIndex ?? 0,
    ]
  );
  // WHERE scene_objects.site_id = excluded.site_id blocks the update if `id`
  // already belongs to a different site — surface that as an error instead of
  // silently no-op'ing (same contract as supabase-db.js's savePoint).
  if (!rows.length) throw new Error(`Scene object ${obj.id} belongs to a different site`);
  const saved = sceneObjectToJson(rows[0]);
  await _appendAudit(siteId, changedBy, 'save', 'scene_object', saved.id, saved.kind);
  return saved;
}

async function deleteSceneObject(slug, id, changedBy = null) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    'delete from scene_objects where id = $1::uuid and site_id = $2::uuid returning kind',
    [id, siteId]
  );
  if (rows.length) await _appendAudit(siteId, changedBy, 'delete', 'scene_object', id, rows[0].kind);
}

module.exports = {
  listSceneObjects,
  isSitePublished,
  saveSceneObject,
  deleteSceneObject,
  sceneObjectToJson, // exported so scenes-db.js's by-code bundle returns the exact viewer-expected object shape
};
