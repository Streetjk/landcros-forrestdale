// MIGRATION: Set USE_SHAREPOINT = true and swap fetch() calls below with sp-migration.js equivalents.
// SP endpoint pattern: /_api/web/lists/getbytitle('SiteMapContacts')/items
const USE_SHAREPOINT = false;

const DATA_BASE = './data';

async function _fetch(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

// ── Contacts ──────────────────────────────────────────────────────────────

export async function getContacts() {
  return _fetch(`${DATA_BASE}/contacts.json`);
}

export async function getContact(id) {
  const all = await getContacts();
  return all.find(c => c.id === id) ?? null;
}

export async function saveContact(contact) {
  const all = await getContacts();
  const idx = all.findIndex(c => c.id === contact.id);
  if (idx >= 0) {
    all[idx] = contact;
  } else {
    all.push(contact);
  }
  await _writeJSON(`${DATA_BASE}/contacts.json`, all);
  await _appendChangelog({ action: 'save', entityType: 'contact', entityId: contact.id, entityLabel: contact.name });
  return contact;
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
  return _fetch(`${DATA_BASE}/points.json`);
}

export async function getPoint(id) {
  const all = await getPoints();
  return all.find(p => p.id === id) ?? null;
}

export async function savePoint(point) {
  const all = await getPoints();
  const idx = all.findIndex(p => p.id === point.id);
  point.updatedAt = new Date().toISOString();
  if (idx >= 0) {
    all[idx] = point;
  } else {
    all.push(point);
  }
  await _writeJSON(`${DATA_BASE}/points.json`, all);
  await _appendChangelog({ action: 'save', entityType: 'point', entityId: point.id, entityLabel: point.label });
  return point;
}

export async function deletePoint(id) {
  const all = await getPoints();
  const point = all.find(p => p.id === id);
  const filtered = all.filter(p => p.id !== id);
  await _writeJSON(`${DATA_BASE}/points.json`, filtered);
  if (point) {
    await _appendChangelog({ action: 'delete', entityType: 'point', entityId: id, entityLabel: point.label });
  }
}

// ── Changelog ─────────────────────────────────────────────────────────────

async function _appendChangelog(entry) {
  let log = [];
  try { log = await _fetch(`${DATA_BASE}/changelog.json`); } catch {}
  log.push({
    timestamp: new Date().toISOString(),
    changedBy: window._spPageContextInfo?.userDisplayName ?? 'browser',
    ...entry,
  });
  await _writeJSON(`${DATA_BASE}/changelog.json`, log);
}

export async function getChangelog() {
  try { return await _fetch(`${DATA_BASE}/changelog.json`); } catch { return []; }
}

// ── Write helper (works only when served by a writable backend) ────────────
// For the flat-JSON version without a write API, changes are in-memory only.
// Swap this with a POST to your backend or SharePoint REST when ready.
async function _writeJSON(path, data) {
  // In-browser flat-file mode: no-op — data changes are ephemeral.
  // Replace with: await fetch('/api/write', { method:'POST', body: JSON.stringify({ path, data }) })
  console.debug('[db] write (in-memory):', path, data);
}
