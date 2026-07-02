// MIGRATION: Set USE_SHAREPOINT = true and swap fetch() calls below with sp-migration.js equivalents.
// SP endpoint pattern: /_api/web/lists/getbytitle('SiteMapContacts')/items
const USE_SHAREPOINT = false;

const DATA_BASE = './data';

async function _fetch(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

// Write helper — points/contacts are now backed by Supabase (see
// supabase-db.js); server.js's /api/points and /api/contacts routes handle
// the upsert. SharePoint migration note below still applies.
async function _write(path, method, data) {
  if (USE_SHAREPOINT) {
    // TODO: swap with SP REST — /_api/web/lists/getbytitle('SiteMap...')/items
    throw new Error('SharePoint write not yet implemented');
  }
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': window.__SN_ADMIN_TOKEN || '' },
    body: method === 'DELETE' ? undefined : JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Write failed: ${res.status}`);
  return method === 'DELETE' ? null : res.json();
}

// ── Contacts ──────────────────────────────────────────────────────────────

export async function getContacts() {
  return _fetch('/api/contacts');
}

export async function getContact(id) {
  const all = await getContacts();
  return all.find(c => c.id === id) ?? null;
}

export async function saveContact(contact) {
  return _write('/api/contacts', 'POST', contact);
}

export async function searchContacts(query) {
  const all = await getContacts();
  const q = query.toLowerCase();
  return all.filter(c =>
    c.name.toLowerCase().includes(q) ||
    c.role.toLowerCase().includes(q) ||
    c.phone.includes(q)
  );
}

// ── Points ────────────────────────────────────────────────────────────────

export async function getPoints() {
  return _fetch('/api/points');
}

export async function getPoint(id) {
  const all = await getPoints();
  return all.find(p => p.id === id) ?? null;
}

export async function savePoint(point) {
  point.updatedAt = new Date().toISOString();
  return _write('/api/points', 'POST', point);
}

export async function deletePoint(id) {
  await _write(`/api/points/${id}`, 'DELETE');
}

// ── Changelog ─────────────────────────────────────────────────────────────
// Legacy, read-only: the write side moved to Supabase's audit_log table
// (see supabase-db.js), so this file is frozen at its last git-committed
// state. No UI currently reads it; kept for API-shape compatibility.
export async function getChangelog() {
  try { return await _fetch(`${DATA_BASE}/changelog.json`); } catch { return []; }
}
