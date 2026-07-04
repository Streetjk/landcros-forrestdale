// scripts-db.js — server-side CRUD for admin-authored widget scripts
// (Phase 2 Slice 4 remainder). Mirrors webhooks-db.js's shape: admin-gated
// CRUD (enforced by the caller — server.js's _requireSiteAdmin — not by this
// module), audit-logged mutations. Unlike webhooks.secret, script source is
// not a secret — it MUST reach the visitor's browser to execute (see
// viewer3d.js's sandboxed iframe) — so, unlike webhooks-db.js, this module
// has no "never return this field" concern.

const { pool: sharedPool, getSiteId, appendAudit } = require('./supabase-db');

function _getPool() {
  return sharedPool();
}

const MAX_NAME_LEN = 100;
const MAX_SOURCE_LEN = 20_000; // generous for a small interaction script, bounds DB/transport bloat

function scriptToJson(r) {
  return {
    id: r.id,
    name: r.name,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function _validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LEN) {
    throw new Error(`name must be a non-empty string of at most ${MAX_NAME_LEN} characters`);
  }
}

function _validateSource(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > MAX_SOURCE_LEN) {
    throw new Error(`source must be a non-empty string of at most ${MAX_SOURCE_LEN} characters`);
  }
}

async function listScripts(slug) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    'select id, name, source, created_at, updated_at from scripts where site_id = $1 order by created_at',
    [siteId]
  );
  return rows.map(scriptToJson);
}

async function createScript(slug, { name, source } = {}, changedBy = null) {
  _validateName(name);
  _validateSource(source);
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    `insert into scripts (site_id, name, source, created_by) values ($1, $2, $3, $4)
     returning id, name, source, created_at, updated_at`,
    [siteId, name, source, changedBy]
  );
  await appendAudit(siteId, changedBy, 'create', 'script', rows[0].id, name);
  return scriptToJson(rows[0]);
}

async function updateScript(slug, id, { name, source } = {}, changedBy = null) {
  const siteId = await getSiteId(slug);
  if (name !== undefined) _validateName(name);
  if (source !== undefined) _validateSource(source);
  const { rows } = await _getPool().query(
    `update scripts set name = coalesce($3, name), source = coalesce($4, source)
     where id = $1 and site_id = $2
     returning id, name, source, created_at, updated_at`,
    [id, siteId, name ?? null, source ?? null]
  );
  if (!rows.length) throw new Error(`Script ${id} belongs to a different site`);
  await appendAudit(siteId, changedBy, 'update', 'script', id, rows[0].name);
  return scriptToJson(rows[0]);
}

async function deleteScript(slug, id, changedBy = null) {
  const siteId = await getSiteId(slug);
  const { rows } = await _getPool().query(
    'delete from scripts where id = $1 and site_id = $2 returning name',
    [id, siteId]
  );
  if (rows.length) await appendAudit(siteId, changedBy, 'delete', 'script', id, rows[0].name);
}

module.exports = {
  listScripts,
  createScript,
  updateScript,
  deleteScript,
};
