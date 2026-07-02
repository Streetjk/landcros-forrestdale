// supabase/db.mjs
//
// Portable Supabase data-access layer. Two client constructors, two trust levels:
//
//   browserClient(accessToken) — uses SUPABASE_PUBLISHABLE_KEY (anon key).
//     - No token: runs as `anon`. Postgres RLS policies decide what anon may
//       see/do (published sites, shared points, active contacts, etc).
//     - With a user's JWT (accessToken): runs AS that authenticated user.
//       RLS policies keyed on auth.uid()/is_site_member() apply, so a member
//       can read/write their site's data and nothing else.
//     This is the client type both the public viewer and the signed-in editor
//     portal should use — safe to construct in a browser context.
//
//   serverClient() — uses SUPABASE_SECRET_KEY (service_role key). BYPASSES
//     RLS entirely. Never send this key to a browser; only use it in trusted
//     server code for privileged operations (e.g. visit counters, admin user
//     management) where the caller has already authorized the action itself.
//
// The data helpers below are thin wrappers over supabase-js query builders.
// They take a `client` (either kind) as the first argument and return
// `{ data, error }` exactly as supabase-js does — callers decide how to
// handle errors. Writes (savePoint, saveContact) rely entirely on RLS: pass
// an authenticated client whose user is an editor+ of the target site. An
// anon client will have its write rejected by the `_write` policies — that
// rejection is the correct, intended behaviour, not a bug.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

export function browserClient(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY must be set');
  }
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} },
    auth: { persistSession: false },
  });
}

export function serverClient() {
  if (!SUPABASE_URL) {
    throw new Error('SUPABASE_URL must be set');
  }
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('SUPABASE_SECRET_KEY must be set (server-only, never expose to a browser)');
  }
  return createClient(SUPABASE_URL, secretKey, { auth: { persistSession: false } });
}

// ── Sites ────────────────────────────────────────────────────────────────

export function listSites(client) {
  return client.from('sites').select('slug,name,title,address,logo,config,published');
}

export function getSite(client, slug) {
  return client.from('sites').select('*').eq('slug', slug).single();
}

// ── Points ───────────────────────────────────────────────────────────────

export function listPoints(client, siteId) {
  return client.from('points').select('*').eq('site_id', siteId);
}

export function savePoint(client, point) {
  return client.from('points').upsert(point).select().single();
}

export function deletePoint(client, id) {
  return client.from('points').delete().eq('id', id);
}

// ── Contacts ─────────────────────────────────────────────────────────────

export function listContacts(client, siteId) {
  return client.from('contacts').select('*').eq('site_id', siteId);
}

export function saveContact(client, contact) {
  return client.from('contacts').upsert(contact).select().single();
}

// ── Visits (privileged — server-side only) ──────────────────────────────
// Increments two rows: (site_id, pointId) and the site-total row
// (site_id, null). Must be called with serverClient() — the `visits` table
// has no client write policy (see 0002_rls.sql), so an authenticated or anon
// client would be rejected by RLS.

export async function recordVisit(client, siteId, pointId) {
  // Atomic + orphan-safe increment via the increment_visit RPC (0004_visit_rpc.sql).
  // The RPC updates the site-total row and, only if the point belongs to the site,
  // the per-point row — in single INSERT..ON CONFLICT statements (no lost updates).
  return client.rpc('increment_visit', { p_site_id: siteId, p_point_id: pointId ?? null });
}
