// supabase-db.js — server-side Supabase/Postgres data-access layer.
//
// Backs server.js's admin CRUD (points, contacts) and visit analytics with
// the schema in supabase/migrations/*.sql, replacing the old per-site JSON
// files as the source of truth. Connects directly via `pg` using the same
// SUPABASE_DB_URL as supabase/import.mjs (pooler/service credentials, which
// bypass RLS) — authorization is enforced by server.js's existing
// ADMIN_TOKEN gate on writes, the same boundary the old file-based
// /api/write used. Per-user RLS (Supabase Auth JWT) is a later step (see
// SESSION_HANDOFF.md).
//
// PORTABLE by design, like the importer: plain node-postgres against a
// connection string, so it runs unchanged against Supabase or any Postgres.
//
// isConfigured() is false when SUPABASE_DB_URL is unset, so server.js can
// fall back to the legacy file-based behaviour for /api/visits + /api/visit.

const { Pool } = require('pg');
const {
  staffPoint,
  publicBasePoint,
  staffContact,
  publicContact,
} = require('./data-projections');

// Read lazily (not captured at module-load time): server.js loads .env into
// process.env *after* its top-level requires run, so a module-scope const
// here would always see an empty string.
let _pool = null;
function _getPool() {
  const connectionString = process.env.SUPABASE_DB_URL || '';
  if (!connectionString) throw new Error('SUPABASE_DB_URL is not set');
  if (!_pool) _pool = new Pool({ connectionString });
  return _pool;
}

function isConfigured() {
  return !!process.env.SUPABASE_DB_URL;
}

// Point write errors carry only stable public codes (never SQL or user data).
class PointWriteError extends Error {
  constructor(status, code) { super(code); this.name = 'PointWriteError'; this.status = status; this.code = code; }
}
const POINT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function pointUuid(value) {
  if (typeof value !== 'string' || !POINT_UUID_RE.test(value)) throw new PointWriteError(400, 'INVALID_POINT_ID');
  return value.toLowerCase();
}
async function pointTransaction(work) {
  const client = await _getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
async function pointAudit(client, siteId, actor, action, id, label) {
  await client.query(`insert into audit_log (site_id, changed_by, action, entity_type, entity_id, entity_label)
    values ($1::uuid, $2::uuid, $3, 'point', $4::uuid, $5)`, [siteId, actor, action, id, label]);
}

// ── Site resolution ─────────────────────────────────────────────────────────
const _siteIdCache = new Map();
async function getSiteId(slug) {
  if (_siteIdCache.has(slug)) return _siteIdCache.get(slug);
  const { rows } = await _getPool().query('select id from sites where slug = $1', [slug]);
  if (!rows.length) throw new Error(`No Supabase "sites" row for slug "${slug}" — run supabase/import.mjs first`);
  _siteIdCache.set(slug, rows[0].id);
  return rows[0].id;
}

// jsonb columns: JSON.stringify explicitly (see supabase/import.mjs for why).
function j(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

// ── Row <-> client JSON shape (DB is snake_case, client JSON is camelCase) ──
// Compatibility wrappers keep the established staff/editor contract while
// centralising the allowlists in data-projections.js.
function pointToJson(r) { return staffPoint(r); }
function contactToJson(r) { return staffContact(r); }
function publicContactToJson(r) { return publicContact(r); }

// ── Points ──────────────────────────────────────────────────────────────────
// baseOnly (public path): return only explicitly shared vanilla base pins
// (scene_id IS NULL AND scope = 'shared'). The server pool bypasses RLS, so
// this filter is an application-layer privacy boundary, not just a convenience.
// Scene-scoped and personal pins never reach the public /api/points route; the
// editor passes baseOnly:false to see the existing full staff set.
async function getPoints(slug, { baseOnly = false } = {}) {
  const siteId = await getSiteId(slug);
  const sql = baseOnly
    ? `select p.* from points p
         where p.site_id = $1 and p.scene_id is null and p.scope = 'shared'
           and exists (select 1 from sites s where s.id = $1 and s.published = true)
         order by p.created_at`
    : 'select * from points where site_id = $1 order by created_at';
  const { rows } = await _getPool().query(sql, [siteId]);
  return rows.map(baseOnly ? publicBasePoint : pointToJson);
}

// Legacy endpoint: base rows only. Scene pins use scene-points-db.js.
async function savePoint(slug, point, changedBy = null) {
  if (!point || typeof point !== 'object' || Array.isArray(point)) throw new PointWriteError(400, 'INVALID_POINT_PAYLOAD');
  if (point.sceneId != null || point.scene_id != null) throw new PointWriteError(400, 'SCENE_ROUTE_REQUIRED');
  const id = pointUuid(point.id), actor = pointUuid(changedBy);
  const siteId = await getSiteId(slug);
  return pointTransaction(async client => {
    const { rows } = await client.query(
      `insert into points (id, site_id, label, type, scope, latlng, position3d, notes,
         contact_ids, route_waypoints, route_waypoints3d, camera_preset3d, building_ref, created_by)
       values ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8,
         $9::uuid[], $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)
       on conflict (id) do update set
         label = excluded.label, type = excluded.type, scope = excluded.scope,
         latlng = excluded.latlng, position3d = excluded.position3d, notes = excluded.notes,
         contact_ids = excluded.contact_ids, route_waypoints = excluded.route_waypoints,
         route_waypoints3d = excluded.route_waypoints3d, camera_preset3d = excluded.camera_preset3d,
         building_ref = excluded.building_ref, updated_at = now()
       where points.site_id = excluded.site_id and points.scene_id is null
       returning *`,
      [id, siteId, point.label, point.type || 'drop-off', point.scope || 'shared',
       j(point.latlng), j(point.position3d), point.notes ?? null,
       point.contactIds || [], j(point.routeWaypoints || []), j(point.routeWaypoints3d || []),
       j(point.cameraPreset3d), point.buildingRef ?? null, actor]
    );
    if (!rows.length) throw new PointWriteError(409, 'POINT_CONFLICT');
    const saved = pointToJson(rows[0]);
    await pointAudit(client, siteId, actor, 'save', id, saved.label);
    return saved;
  });
}

async function deletePoint(slug, id, changedBy = null) {
  id = pointUuid(id);
  const actor = pointUuid(changedBy), siteId = await getSiteId(slug);
  return pointTransaction(async client => {
    const { rows } = await client.query(
      'select label from points where id = $1::uuid and site_id = $2::uuid and scene_id is null for update', [id, siteId]);
    if (!rows.length) throw new PointWriteError(404, 'POINT_NOT_FOUND');
    const photoRes = await client.query(
      'select 1 from point_photos where site_id = $1::uuid and point_id = $2::uuid limit 1', [siteId, id]);
    if (photoRes.rows.length) throw new PointWriteError(409, 'POINT_HAS_PHOTOS');
    await client.query('delete from points where id = $1::uuid and site_id = $2::uuid and scene_id is null', [id, siteId]);
    await pointAudit(client, siteId, actor, 'delete', id, rows[0].label);
  });
}

// ── Contacts ──────────────────────────────────────────────────────────────
// baseOnly is the anonymous public-contact path. A contact is public only when
// an explicitly shared base pin (scene_id IS NULL AND scope = 'shared') references
// it. Personal-base, unreferenced staff-directory, and scene-only contacts remain
// staff-only. The public
// projection also strips email/audit metadata; the editor passes baseOnly:false
// and receives the existing full staff shape.
async function getContacts(slug, { baseOnly = false } = {}) {
  const siteId = await getSiteId(slug);
  const sql = baseOnly
    ? `select c.* from contacts c where c.site_id = $1
         and c.active = true
         and exists (select 1 from sites s where s.id = $1 and s.published = true)
         and exists (
           select 1 from points p
            where p.site_id = $1 and p.scene_id is null and p.scope = 'shared'
              and c.id = any(p.contact_ids)
         )
       order by c.created_at`
    : 'select * from contacts where site_id = $1 order by created_at';
  const { rows } = await _getPool().query(sql, [siteId]);
  return rows.map(baseOnly ? publicContactToJson : contactToJson);
}

async function saveContact(slug, contact, changedBy = null) {
  const siteId = await getSiteId(slug);
  if (!contact || !contact.id) throw new Error('contact.id is required');
  const { rows } = await _getPool().query(
    `insert into contacts (id, site_id, name, role, phone, email, active, created_by)
     values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)
     on conflict (id) do update set
       name = excluded.name, role = excluded.role, phone = excluded.phone,
       email = excluded.email, active = excluded.active
     where contacts.site_id = excluded.site_id
     returning *`,
    [
      contact.id, siteId, contact.name, contact.role ?? null, contact.phone ?? null,
      contact.email ?? null, contact.active ?? true, contact.createdBy ?? 'browser',
    ]
  );
  if (!rows.length) throw new Error(`Contact ${contact.id} belongs to a different site`);
  const saved = contactToJson(rows[0]);
  await _appendAudit(siteId, changedBy, 'save', 'contact', saved.id, saved.name);
  return saved;
}

// ── Audit log (was changelog.json) ───────────────────────────────────────────
async function _appendAudit(siteId, changedBy, action, entityType, entityId, entityLabel) {
  await _getPool().query(
    `insert into audit_log (site_id, changed_by, action, entity_type, entity_id, entity_label)
     values ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
    [siteId, changedBy, action, entityType, entityId, entityLabel]
  );
}

// ── Visits (was visits.json) ─────────────────────────────────────────────────
// One row per (site, point) plus one site-total row (point_id null) — see the
// visits_site_point_uniq expression index in 0001_schema.sql.
async function getVisits(slug) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    'select point_id, count, first_visit, last_visit from visits where site_id = $1',
    [siteId]
  );
  const totalRow = rows.find(r => r.point_id === null);
  const points = {};
  for (const r of rows) if (r.point_id !== null) points[r.point_id] = Number(r.count);
  return {
    total: totalRow ? Number(totalRow.count) : 0,
    firstVisit: totalRow?.first_visit ?? null,
    lastVisit: totalRow?.last_visit ?? null,
    points,
  };
}

async function recordVisit(slug, pointId) {
  const siteId = await getSiteId(slug);
  // Atomic + orphan-safe: increment_visit (0004_visit_rpc.sql) bumps the
  // site-total row and — only if the point belongs to the site — the per-point
  // row, in a single call. Replaces the previous two-query partial-increment.
  await _getPool().query('select increment_visit($1::uuid, $2::uuid)', [siteId, pointId || null]);
}

module.exports = {
  PointWriteError,
  isConfigured,
  pool: _getPool, // exported so auth-db.js can share this pool instead of opening a second one
  getSiteId,
  j, // exported so other data-access modules (submissions-db.js, events-db.js) don't duplicate it
  appendAudit: _appendAudit, // exported so new modules reuse this instead of a third copy (scene-db.js already has one)
  pointToJson,   // exported so scenes-db.js's by-code bundle returns the exact viewer-expected pin shape
  contactToJson, // full authenticated/staff contact shape
  publicContactToJson, // anonymous projection: no email/audit metadata
  getPoints,
  savePoint,
  deletePoint,
  getContacts,
  saveContact,
  getVisits,
  recordVisit,
};
