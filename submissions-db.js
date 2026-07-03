// submissions-db.js — server-side data-access layer for the public "drop a
// pin + notes" submissions feature (Phase 3).
//
// Mirrors scene-db.js's shape: shared pool, getSiteId, j() for jsonb columns,
// same trust boundary (service-role pool; authorization enforced by the
// caller — server.js — not by RLS).

const { pool: sharedPool, getSiteId, j } = require('./supabase-db');

function _getPool() {
  return sharedPool();
}

const MAX_TEXT_LEN = 2000; // pointLabel / meta size guard — cheap DB-abuse resistance
const DAILY_SITE_CAP = 200; // per-site rolling-24h submission cap — blunts a single IP-rotating actor

function submissionToJson(r) {
  return {
    id: r.id,
    pointLabel: r.point_label,
    latlng: r.latlng,
    position3d: r.position3d,
    photoPath: r.photo_path,
    meta: r.meta,
    status: r.status,
    createdAt: r.created_at,
  };
}

// Thrown when the per-site daily cap is hit — server.js maps this to a 429.
class SubmissionCapError extends Error {}

async function createSubmission(slug, { pointLabel, latlng, position3d, meta } = {}) {
  const siteId = await getSiteId(slug);

  if (pointLabel != null && (typeof pointLabel !== 'string' || pointLabel.length > MAX_TEXT_LEN)) {
    throw new Error('pointLabel invalid');
  }
  const metaJson = meta && typeof meta === 'object' ? meta : {};
  if (JSON.stringify(metaJson).length > MAX_TEXT_LEN) throw new Error('meta too large');

  const { rows: countRows } = await _getPool().query(
    `select count(*)::int as n from submissions
     where site_id = $1 and created_at > now() - interval '24 hours'`,
    [siteId]
  );
  if (countRows[0].n >= DAILY_SITE_CAP) throw new SubmissionCapError('daily submission cap reached');

  const { rows } = await _getPool().query(
    `insert into submissions (site_id, point_label, latlng, position3d, meta)
     values ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)
     returning *`,
    [siteId, pointLabel ?? null, j(latlng ?? null), j(position3d ?? null), j(metaJson)]
  );
  return { siteId, submission: submissionToJson(rows[0]) };
}

module.exports = {
  SubmissionCapError,
  createSubmission,
};
