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

// Explicit platform-admin override emails (comma-separated env). These may log
// in regardless of domain and are seeded as 'owner' on the auth site — used to
// bootstrap a platform owner whose email is outside the corporate domain.
// SECURITY NOTE: the first PIN for any account is set via an emailed link, so
// listing an email here only helps someone who also controls that inbox.
// Keep this list minimal regardless.
const PLATFORM_ADMIN_EMAILS = new Set(
  (process.env.PLATFORM_ADMIN_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);
function isPlatformAdmin(email) {
  return typeof email === 'string' && PLATFORM_ADMIN_EMAILS.has(email.trim().toLowerCase());
}

function emailAllowed(email) {
  if (!email || typeof email !== 'string') return false;
  email = email.trim();
  if (isPlatformAdmin(email)) return true;
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
    // Platform admins (override list) → active + owner on the auth site.
    // Otherwise contact-match on the pinned site → active + editor, else pending.
    let status, memberships, upgradeRole;
    if (isPlatformAdmin(email)) {
      status = 'active';
      memberships = [authSiteId];
      upgradeRole = 'owner';
    } else {
      const { rows: contactRows } = await client.query(
        'select distinct site_id from contacts where lower(email) = lower($1) and site_id = $2',
        [email, authSiteId]
      );
      status = contactRows.length ? 'active' : 'pending';
      memberships = contactRows.map((r) => r.site_id);
      upgradeRole = 'editor';
    }
    await client.query(
      `insert into profiles (id, email, status) values ($1, $2, $3)
       on conflict (id) do update set email = excluded.email, status = excluded.status
       returning id`,
      [userId, email, status]
    );
    for (const siteId of memberships) {
      await client.query(
        // Platform-admin bootstrap must set 'owner' even if a row exists;
        // contact-editor grants use do-nothing to preserve manual promotions.
        upgradeRole === 'owner'
          ? `insert into site_members (site_id, user_id, role) values ($1, $2, 'owner')
             on conflict (site_id, user_id) do update set role = 'owner'`
          : `insert into site_members (site_id, user_id, role) values ($1, $2, 'editor')
             on conflict (site_id, user_id) do nothing`,
        [siteId, userId]
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

// Enum comparison uses declaration order from 0001_schema.sql: viewer < editor < admin < owner.
const ROLE_RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 };

async function getSiteRole(profileId, slug) {
  if (!profileId) return null;
  const { rows } = await _getPool().query(
    `select sm.role from site_members sm
     join sites s on s.id = sm.site_id
     where sm.user_id = $1 and s.slug = $2`,
    [profileId, slug]
  );
  return rows.length ? rows[0].role : null;
}

function roleAtLeast(role, min) {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[min];
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

// ── Login PINs ───────────────────────────────────────────────────────────
// 6-digit PIN required on every login (0009_login_pins.sql). Stored as
// scrypt("<salt>$<hash>") in profile_pins — a table with RLS enabled and no
// policies, so only this service-role pool can read it. The PIN space is
// only 10^6, so the real brute-force defence is the per-profile lockout in
// verifyPin(), not the hash cost.

const PIN_RE = /^\d{6}$/;
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;      // 15 min
const PIN_TOKEN_TTL_MS = 30 * 60 * 1000; // setup/reset link validity
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

// Rejects the handful of PINs that a guesser tries first. Not a strength
// meter — just enough to keep 000000 / 123456 out.
function pinIsAcceptable(pin) {
  if (typeof pin !== 'string' || !PIN_RE.test(pin)) return false;
  if (/^(\d)\1{5}$/.test(pin)) return false;                   // 111111
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return false; // 123456, 654321
  return true;
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, 32, SCRYPT_PARAMS);
  return `${_b64urlEncode(salt)}$${_b64urlEncode(hash)}`;
}

function verifyPinHash(pin, stored) {
  if (typeof pin !== 'string' || typeof stored !== 'string') return false;
  const [saltB64, hashB64] = stored.split('$');
  if (!saltB64 || !hashB64) return false;
  const expected = _b64urlDecode(hashB64);
  const actual = crypto.scryptSync(pin, _b64urlDecode(saltB64), expected.length, SCRYPT_PARAMS);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// { hasPin, lockedUntil: Date|null }
async function getPinState(profileId) {
  const { rows } = await _getPool().query(
    'select locked_until from profile_pins where profile_id = $1', [profileId]
  );
  if (!rows.length) return { hasPin: false, lockedUntil: null };
  const lu = rows[0].locked_until;
  return { hasPin: true, lockedUntil: lu && lu > new Date() ? lu : null };
}

// Sets (or replaces) the PIN and clears any lockout. Callers must have
// already proven identity — a consumed reset token, or the current PIN.
async function setPin(profileId, pin, client = null) {
  if (!pinIsAcceptable(pin)) throw new PinError('pin-unacceptable');
  await (client || _getPool()).query(
    `insert into profile_pins (profile_id, pin_hash, set_at, failed_attempts, locked_until)
     values ($1, $2, now(), 0, null)
     on conflict (profile_id) do update
       set pin_hash = excluded.pin_hash, set_at = now(), failed_attempts = 0, locked_until = null`,
    [profileId, hashPin(pin)]
  );
}

class PinError extends Error {
  constructor(code, extra = {}) { super(code); this.code = code; Object.assign(this, extra); }
}

// Resolves { ok: true } or { ok: false, reason: 'no-pin' | 'locked' | 'invalid',
// remaining?, lockedUntil? }. Failures are counted in the same statement that
// reads the row, so concurrent guesses cannot race past the limit.
async function verifyPin(profileId, pin) {
  const pool = _getPool();
  const { rows } = await pool.query(
    'select pin_hash, failed_attempts, locked_until from profile_pins where profile_id = $1',
    [profileId]
  );
  if (!rows.length) return { ok: false, reason: 'no-pin' };
  const row = rows[0];
  if (row.locked_until && row.locked_until > new Date()) {
    return { ok: false, reason: 'locked', lockedUntil: row.locked_until };
  }
  if (PIN_RE.test(String(pin)) && verifyPinHash(String(pin), row.pin_hash)) {
    if (row.failed_attempts) {
      await pool.query(
        'update profile_pins set failed_attempts = 0, locked_until = null where profile_id = $1',
        [profileId]
      );
    }
    return { ok: true };
  }
  const { rows: upd } = await pool.query(
    `update profile_pins
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= $2
                               then now() + ($3 || ' milliseconds')::interval
                               else locked_until end
     where profile_id = $1
     returning failed_attempts, locked_until`,
    [profileId, PIN_MAX_FAILURES, String(PIN_LOCK_MS)]
  );
  const after = upd[0];
  if (after.locked_until && after.locked_until > new Date()) {
    return { ok: false, reason: 'locked', lockedUntil: after.locked_until };
  }
  return { ok: false, reason: 'invalid', remaining: Math.max(0, PIN_MAX_FAILURES - after.failed_attempts) };
}

function _sha256b64url(s) {
  return _b64urlEncode(crypto.createHash('sha256').update(s).digest());
}

// Issues a single-use setup/reset token for the profile and returns the RAW
// token (only its hash is stored). Any earlier unused tokens for the same
// profile are invalidated so a forgotten old email can't be replayed later.
async function createPinToken(profileId) {
  const raw = _b64urlEncode(crypto.randomBytes(32));
  const client = await _getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'update pin_reset_tokens set used_at = now() where profile_id = $1 and used_at is null',
      [profileId]
    );
    await client.query(
      `insert into pin_reset_tokens (token_hash, profile_id, expires_at)
       values ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
      [_sha256b64url(raw), profileId, String(PIN_TOKEN_TTL_MS)]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { token: raw, ttlMinutes: PIN_TOKEN_TTL_MS / 60000 };
}

// Validates + burns the token and sets the new PIN atomically. Resolves
// { profileId, email } for the caller to open a session with, or throws
// PinError('token-invalid' | 'pin-unacceptable').
async function consumePinToken(rawToken, newPin) {
  if (typeof rawToken !== 'string' || rawToken.length < 20) throw new PinError('token-invalid');
  if (!pinIsAcceptable(newPin)) throw new PinError('pin-unacceptable');
  const client = await _getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `update pin_reset_tokens t set used_at = now()
       from profiles p
       where t.token_hash = $1 and t.used_at is null and t.expires_at > now()
         and p.id = t.profile_id
       returning t.profile_id, p.email`,
      [_sha256b64url(rawToken)]
    );
    if (!rows.length) throw new PinError('token-invalid');
    await setPin(rows[0].profile_id, newPin, client);
    await client.query('COMMIT');
    return { profileId: rows[0].profile_id, email: rows[0].email };
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
  isPlatformAdmin,
  emailAllowed,
  checkProfile,
  createProfile,
  listPendingProfiles,
  approveProfile,
  getSiteRole,
  roleAtLeast,
  withClaims,
  signSession,
  verifySession,
  // PINs
  PinError,
  pinIsAcceptable,
  hashPin,
  verifyPinHash,
  getPinState,
  setPin,
  verifyPin,
  createPinToken,
  consumePinToken,
};
