import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key';

const db = await import(`../supabase/db.mjs?direct-read-contract=${Date.now()}`);

function captureSelect(client = {}) {
  const calls = [];
  const chain = {
    select(columns) { calls.push(columns); return chain; },
    eq() { return chain; },
    single() { return chain; },
  };
  client.from = () => chain;
  return calls;
}

test('explicit public helpers request only anon-granted site columns', () => {
  const client = {};
  const calls = captureSelect(client);
  db.listPublicSites(client);
  db.getPublicSite(client, 'landcros');
  assert.deepEqual(calls, [
    'id,slug,name,title,address,logo,published',
    'id,slug,name,title,address,logo,published',
  ]);
});

test('explicit public helpers request only anon-granted point/contact columns', () => {
  const client = {};
  const calls = captureSelect(client);
  db.listPublicPoints(client, 'site-id');
  db.listPublicContacts(client, 'site-id');
  assert.deepEqual(calls, [
    'id,site_id,label,type,scope,latlng,position3d,notes,contact_ids,route_waypoints,route_waypoints3d,camera_preset3d,building_ref',
    'id,site_id,name,role,phone,active',
  ]);
});

test('existing authenticated/general helper read shapes remain unchanged', () => {
  const client = {};
  const calls = captureSelect(client);
  db.listSites(client);
  db.getSite(client, 'landcros');
  db.listPoints(client, 'site-id');
  db.listContacts(client, 'site-id');
  assert.deepEqual(calls, [
    'slug,name,title,address,logo,config,published',
    '*',
    '*',
    '*',
  ]);
});

test('public vs staff read shape is explicit and independent of client auth transitions', () => {
  const client = {};
  const calls = captureSelect(client);
  db.listPublicContacts(client, 'site-id');
  db.listContacts(client, 'site-id');
  db.listPublicContacts(client, 'site-id');
  assert.deepEqual(calls, [
    'id,site_id,name,role,phone,active',
    '*',
    'id,site_id,name,role,phone,active',
  ]);
});
