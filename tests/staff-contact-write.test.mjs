import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { saveContact } from '../db.js';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const dal = fs.readFileSync(new URL('../supabase-db.js', import.meta.url), 'utf8');
const admin = fs.readFileSync(new URL('../admin3d.js', import.meta.url), 'utf8');

test('staff contact client writes through a site-scoped URL and returns canonical JSON', async () => {
  const originalFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, options) => {
    seen = { url, options };
    return { ok: true, json: async () => ({ id: 'c1', name: 'Canonical', createdBy: 'actor-id' }) };
  };
  try {
    const saved = await saveContact('landcros', { id: 'c1', name: 'Draft', createdBy: 'spoof' });
    assert.equal(seen.url, '/api/sites/landcros/contacts');
    assert.equal(seen.options.method, 'POST');
    assert.deepEqual(saved, { id: 'c1', name: 'Canonical', createdBy: 'actor-id' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('staff contact client rejects a missing site before fetch', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('unexpected fetch'); };
  try {
    await assert.rejects(() => saveContact('  ', { id: 'c1' }), /Site slug is required/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('server separates public read from authenticated site-scoped writes', () => {
  assert.match(server, /staffContactsMatch[\s\S]*?req\.method === 'GET' \|\| req\.method === 'POST'/);
  assert.match(server, /_requireSiteEditor\(req, res, slug, \(session\) => \{[\s\S]*?sdb\.getContacts\(slug, \{ baseOnly: false \}\)[\s\S]*?writeStaffDataUnavailable\(res, \{[\s\S]*?route: 'GET-api-sites-contacts'/);
  assert.match(server, /_requireSiteEditor\(req, res, slug, \(session\) => \{[\s\S]*?sdb\.saveContact\(slug, contact, session\.profileId\)/);
  assert.match(server, /pathname === '\/api\/contacts' && req\.method === 'GET'[\s\S]*?sdb\.getContacts\(SITE, \{ baseOnly: true \}\)/);
  assert.match(server, /pathname === '\/api\/contacts' && req\.method === 'POST'[\s\S]*?req\.resume\(\);[\s\S]*?setHeader\('Allow', 'GET'\)[\s\S]*?405/);
  assert.doesNotMatch(server, /sdb\.saveContact\(SITE,/);
});

test('contact DAL ignores client createdBy and binds inserts to the authenticated actor', () => {
  const block = dal.slice(dal.indexOf('async function saveContact'), dal.indexOf('// ── Audit log', dal.indexOf('async function saveContact')));
  assert.match(block, /contact\.active \?\? true, changedBy/);
  assert.doesNotMatch(block, /contact\.createdBy/);
});

test('admin contact UI uses site scope and canonical saved records', () => {
  assert.equal((admin.match(/saveContact\(_slug,/g) || []).length, 2);
  const toggle = admin.slice(admin.indexOf('window._adminToggleActive'), admin.indexOf('window.addNewContact'));
  assert.match(toggle, /const saved = await saveContact\(_slug, \{ \.\.\.c, active \}\)/);
  assert.match(toggle, /_contactsAll\[allIndex\] = saved/);
  assert.match(toggle, /_contacts\[contactIndex\] = saved/);

  const create = admin.slice(admin.indexOf('window._adminSaveNewContact'), admin.indexOf('// ── Helpers', admin.indexOf('window._adminSaveNewContact')));
  assert.match(create, /const saved = await saveContact\(_slug, contact\)/);
  assert.match(create, /_contactsAll\.push\(saved\)/);
  assert.match(create, /_contacts\.push\(saved\)/);
  assert.doesNotMatch(create, /createdBy|createdAt/);
});
