// site-admin.js — platform-admin site management (Phase 2 SLICE 1: "grand editor" entry).
//
// Server-side only, service creds. Reuses supabase-db.js's exported pool
// (SUPABASE_DB_URL, pooler/service credentials — same connection auth-db.js
// shares) so site creation runs with a direct privileged insert, bypassing
// RLS the same way auth-db.js's createProfile/approveProfile do. This is
// deliberate: 0003's @hcma.com.au sites_insert RLS guard must not block a
// gmail platform owner (see PLATFORM_ADMIN_EMAILS in auth-db.js).
//
// Callers MUST gate every export behind auth.isPlatformAdmin(email) — this
// module performs no authorization checks of its own.

const { pool: sharedPool } = require('./supabase-db');

function _getPool() {
  return sharedPool();
}

// Matches the `sites.slug` CHECK constraint in supabase/migrations/0001_schema.sql.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

async function createSite({ slug, name, title, address, logo, createdByProfileId }) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new Error('invalid slug');
  if (typeof name !== 'string' || !name.trim()) throw new Error('name is required');
  if (!createdByProfileId) throw new Error('createdByProfileId is required');

  const client = await _getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `insert into sites (slug, name, title, address, logo, published, created_by, config)
       values ($1, $2, $3, $4, $5, false, $6, '{}'::jsonb)
       on conflict (slug) do nothing
       returning id, slug, name, published`,
      [slug, name, title ?? null, address ?? null, logo ?? null, createdByProfileId]
    );
    if (!rows.length) throw new Error('slug already exists');
    const site = rows[0];
    await client.query(
      `insert into site_members (site_id, user_id, role) values ($1, $2, 'owner')
       on conflict (site_id, user_id) do update set role = 'owner'`,
      [site.id, createdByProfileId]
    );
    await client.query('COMMIT');
    return site;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listAllSites() {
  const { rows } = await _getPool().query(
    'select id, slug, name, title, published, created_at from sites order by created_at'
  );
  return rows;
}

async function setPublished(slug, published) {
  const { rows } = await _getPool().query(
    'update sites set published = $2 where slug = $1 returning slug, published',
    [slug, !!published]
  );
  if (!rows.length) throw new Error('site not found');
  return rows[0];
}

module.exports = {
  createSite,
  listAllSites,
  setPublished,
};
