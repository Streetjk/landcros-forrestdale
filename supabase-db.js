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
function pointToJson(r) {
  return {
    id: r.id,
    label: r.label,
    type: r.type,
    scope: r.scope,
    latlng: r.latlng,
    position3d: r.position3d,
    notes: r.notes,
    contactIds: r.contact_ids,
    routeWaypoints: r.route_waypoints,
    routeWaypoints3d: r.route_waypoints3d,
    cameraPreset3d: r.camera_preset3d,
    buildingRef: r.building_ref,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function contactToJson(r) {
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    phone: r.phone,
    email: r.email,
    active: r.active,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

// ── Points ──────────────────────────────────────────────────────────────────
// baseOnly (public path): return only vanilla base pins (scene_id IS NULL).
// Scene-scoped pins never reach the public /api/points route — they load
// only through a scene's share-code bundle. The editor passes baseOnly:false
// to see everything.
async function getPoints(slug, { baseOnly = false } = {}) {
  const siteId = await getSiteId(slug);
  const sql = baseOnly
    ? 'select * from points where site_id = $1 and scene_id is null order by created_at'
    : 'select * from points where site_id = $1 order by created_at';
  const { rows } = await _getPool().query(sql, [siteId]);
  return rows.map(pointToJson);
}

async function savePoint(slug, point, changedBy = null) {
  const siteId = await getSiteId(slug);
  if (!point || !point.id) throw new Error('point.id is required');
  const { rows } = await _getPool().query(
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
     where points.site_id = excluded.site_id
     returning *`,
    [
      point.id, siteId, point.label, point.type || 'drop-off', point.scope || 'shared',
      j(point.latlng), j(point.position3d), point.notes ?? null,
      point.contactIds || [], j(point.routeWaypoints || []), j(point.routeWaypoints3d || []),
      j(point.cameraPreset3d), point.buildingRef ?? null, point.createdBy ?? 'browser',
    ]
  );
  // WHERE points.site_id = excluded.site_id blocks the update if `id` already
  // belongs to a different site — surface that as an error instead of
  // silently no-op'ing (see savePoint contract note below).
  if (!rows.length) throw new Error(`Point ${point.id} belongs to a different site`);
  const saved = pointToJson(rows[0]);
  await _appendAudit(siteId, changedBy, 'save', 'point', saved.id, saved.label);
  return saved;
}

async function deletePoint(slug, id, changedBy = null) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    'delete from points where id = $1::uuid and site_id = $2::uuid returning label',
    [id, siteId]
  );
  if (rows.length) await _appendAudit(siteId, changedBy, 'delete', 'point', id, rows[0].label);
}

// ── Contacts ──────────────────────────────────────────────────────────────
// baseOnly (public path): exclude "scene-only" contacts — those referenced
// ONLY by scene-scoped pins and by no base pin. Contacts have no scene_id of
// their own (they're referenced by pins' contact_ids[]), so a contact is
// treated as public if a base pin references it OR no scene pin references it.
// This keeps scene-created contacts (PII) from leaking via the public
// /api/contacts route (Fable amendment). The editor passes baseOnly:false.
async function getContacts(slug, { baseOnly = false } = {}) {
  const siteId = await getSiteId(slug);
  const sql = baseOnly
    ? `select * from contacts c where c.site_id = $1 and (
         exists (select 1 from points p where p.site_id = $1 and p.scene_id is null and c.id = any(p.contact_ids))
         or not exists (select 1 from points p where p.site_id = $1 and p.scene_id is not null and c.id = any(p.contact_ids))
       ) order by c.created_at`
    : 'select * from contacts where site_id = $1 order by created_at';
  const { rows } = await _getPool().query(sql, [siteId]);
  return rows.map(contactToJson);
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
  isConfigured,
  pool: _getPool, // exported so auth-db.js can share this pool instead of opening a second one
  getSiteId,
  j, // exported so other data-access modules (submissions-db.js, events-db.js) don't duplicate it
  appendAudit: _appendAudit, // exported so new modules reuse this instead of a third copy (scene-db.js already has one)
  getPoints,
  savePoint,
  deletePoint,
  getContacts,
  saveContact,
  getVisits,
  recordVisit,
};
