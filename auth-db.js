// auth-db.js — server-side auth data layer for internal, email-only login.
//
// Stage 2a: backend only (wiring into server.js/db.js is Stage 2b). Two
// trust boundaries, matching supabase-db.js / supabase/db.mjs:
//
//   - @supabase/supabase-js serverClient (SUPABASE_SECRET_KEY, service_role):
//     used ONLY for the Supabase Auth admin API (creating/looking up the
//     auth.users identity). Never exposed to a browser.
//
//   - node-postgres pool (SUPABASE_DB_URL, pooler/service credentials):
//     used for everything else — profiles/contacts/site_members reads and
//     writes. Reuses supabase-db.js's pool (see its exported _pool getter)
//     so we don't open a second connection pool to the same database.
//
// RLS enforcement model (approved): rather than mint a real Supabase JWT for
// every request, the server runs authenticated queries inside a transaction
// that impersonates the user's claims directly on this pg connection:
//   BEGIN; SET LOCAL ROLE authenticated;
//   select set_config('request.jwt.claims', '{"sub":...,"role":"authenticated","email":...}', true);
// Postgres's RLS policies (is_site_member(), current_email(), etc. from
// 0002_rls.sql / 0003_auth_domain.sql) read auth.uid()/request.jwt.claims
// exactly as they would from a real Supabase Auth JWT, so per-user isolation
// is enforced by the same policies — no duplicate authorization logic here.
// See withClaims() below.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { pool: sharedPool } = require('./supabase-db');

const ALLOWED_DOMAIN = 'hcma.com.au';

// Stage 2a login/profiles apply to ONE site only. Sites can share contact
// lists (e.g. greenfields' is byte-identical to landcros' today), so contact
// matching and default approval scope must be pinned to this slug, not "any
// site" — otherwise the same email would silently pick up membership on
// every site that happens to list it as a contact.
const AUTH_SITE_SLUG = process.env.AUTH_SITE_SLUG || 'landcros';

function emailAllowed(email) {
  if (!email || typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  return email.slice(at + 1).toLowerCase() === ALLOWED_DOMAIN;
}

// Service-role Supabase client — admin API only (createUser/getUserByEmail).
// Read lazily, same rationale as supabase-db.js's _getPool(): .env is loaded
// into process.env after this module's top-level requires run.
let _serverClient = null;
function _getServerClient() {
  if (!_serverClient) {
    const url = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    if (!url || !secretKey) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY must be set');
    _serverClient = createClient(url, secretKey, { auth: { persistSession: false } });
  }
  return _serverClient;
}

function _getPool() {
  return sharedPool();
}

// Resolves the pinned auth site's id (see AUTH_SITE_SLUG). Not cached: called
// at most once per createProfile/approveProfile call, on the same client/txn.
async function _getAuthSiteId(client) {
  const { rows } = await client.query('select id from sites where slug = $1', [AUTH_SITE_SLUG]);
  if (!rows.length) throw new Error(`No sites row for slug "${AUTH_SITE_SLUG}" (AUTH_SITE_SLUG)`);
  return rows[0].id;
}

// ── Profiles ─────────────────────────────────────────────────────────────

async function checkProfile(email) {
  const { rows } = await _getPool().query(
    'select id, status from profiles where lower(email) = lower($1)',
    [email]
  );
  if (!rows.length) return { status: 'none' };
  return { status: rows[0].status, profileId: rows[0].id };
}

async function createProfile(email) {
  if (!emailAllowed(email)) throw new Error(`Email domain not allowed: ${email}`);

  // 1. Create (or reuse) the auth.users identity. We never use the password
  // — internal login is email-only; this exists purely so an auth.users row
  // can back the profiles FK.
  const admin = _getServerClient();
  let userId;
  const randomPassword = crypto.randomBytes(24).toString('hex');
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password: randomPassword,
  });
  if (createErr) {
    // Reuse the existing identity if one already exists with no profile row
    // (e.g. a prior createProfile call failed after the auth user was made).
    const alreadyExists = /already been registered|already exists/i.test(createErr.message || '');
    if (!alreadyExists) throw new Error(`createUser failed: ${createErr.message}`);
    const { data: list, error: listErr } = await admin.auth.admin.listUsers();
    if (listErr) throw new Error(`listUsers failed (while resolving existing user): ${listErr.message}`);
    const existing = list.users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
    if (!existing) throw new Error(`createUser reported "already exists" but no matching auth user found: ${email}`);
    userId = existing.id;
  } else {
    userId = created.user.id;
  }

  // 2. Decide status by contact match on the pinned auth site ONLY (see
  // AUTH_SITE_SLUG), and insert the profile + membership in one transaction
  // (service role — bypasses RLS by design; this IS the privileged path that
  // grants access).
  const client = await _getPool().connect();
  try {
    await client.query('BEGIN');
    const authSiteId = await _getAuthSiteId(client);
    const { rows: contactRows } = await client.query(
      'select distinct site_id from contacts where lower(email) = lower($1) and site_id = $2',
      [email, authSiteId]
    );
    const status = contactRows.length ? 'active' : 'pending';
    await client.query(
      `insert into profiles (id, email, status) values ($1, $2, $3)
       on conflict (id) do update set email = excluded.email, status = excluded.status
       returning id`,
      [userId, email, status]
    );
    for (const row of contactRows) {
      await client.query(
        `insert into site_members (site_id, user_id, role) values ($1, $2, 'editor')
         on conflict (site_id, user_id) do nothing`,
        [row.site_id, userId]
      );
    }
    await client.query('COMMIT');
    return { status, profileId: userId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listPendingProfiles() {
  const { rows } = await _getPool().query(
    "select id, email, display_name, created_at from profiles where status = 'pending' order by created_at"
  );
  return rows;
}

async function approveProfile(profileId, siteId, role = 'editor') {
  const client = await _getPool().connect();
  try {
    await client.query('BEGIN');
    const targetSiteId = siteId || (await _getAuthSiteId(client));
    await client.query(`update profiles set status = 'active' where id = $1`, [profileId]);
    await client.query(
      `insert into site_members (site_id, user_id, role) values ($1, $2, $3)
       on conflict (site_id, user_id) do nothing`,
      [targetSiteId, profileId, role]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── RLS-enforced access ──────────────────────────────────────────────────
// Runs `fn(client)` inside a transaction impersonating (profileId, email) as
// the `authenticated` role, so the existing RLS policies (is_site_member(),
// current_email()) apply exactly as they would under a real Supabase Auth
// JWT. Always releases the client; rolls back on throw.
async function withClaims(profileId, email, fn) {
  const client = await _getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE authenticated');
    const claims = JSON.stringify({ sub: profileId, role: 'authenticated', email });
    await client.query('select set_config($1, $2, true)', ['request.jwt.claims', claims]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Session tokens ───────────────────────────────────────────────────────
// No external dep: base64url(payload) + HMAC-SHA256(SESSION_SECRET), with an
// expiry embedded in the payload. Not a JWT (no alg negotiation, no header) —
// deliberately minimal since the only consumer is this app's own server.

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function _b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function _sign(payloadB64) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return _b64urlEncode(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

function signSession({ profileId, email }) {
  const payload = { profileId, email, exp: Date.now() + SESSION_TTL_MS };
  const payloadB64 = _b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = _sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;

  let expectedSig;
  try {
    expectedSig = _sign(payloadB64);
  } catch {
    return null;
  }
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(_b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  return { profileId: payload.profileId, email: payload.email };
}

module.exports = {
  ALLOWED_DOMAIN,
  AUTH_SITE_SLUG,
  emailAllowed,
  checkProfile,
  createProfile,
  listPendingProfiles,
  approveProfile,
  withClaims,
  signSession,
  verifySession,
};
