import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scenesDb = require('../scenes-db.js');
const supabaseDb = require('../supabase-db.js');

const SITE = '00000000-0000-4000-8000-000000000001';
const SCENE = '00000000-0000-4000-8000-000000000002';
const POINT = '00000000-0000-4000-8000-000000000003';
const CONTACT = '00000000-0000-4000-8000-000000000004';
const CODE = 'abcde23456';

function withPool(fakePool, fn) {
  const original = supabaseDb.pool;
  supabaseDb.pool = () => fakePool;
  return Promise.resolve().then(fn).finally(() => { supabaseDb.pool = original; });
}

test('public scene capability keeps shared scene/site scope and minimizes active contacts', async () => {
  const queries = [];
  const pool = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql.includes('from scenes s left join profiles')) {
      return { rows: [{
        id: SCENE, site_id: SITE, name: 'Visitor guide', camera: null, kind: 'admin', status: 'open',
        status_changed_at: null, created_by: 'owner-profile', created_by_email: 'owner@example.invalid',
        status_changed_by_email: null,
      }] };
    }
    if (sql.includes('from scene_objects o')) return { rows: [] };
    if (sql.includes('select * from points')) {
      assert.deepEqual(params, [SCENE, SITE]);
      assert.match(sql, /scene_id = \$1 and site_id = \$2 and scope = 'shared'/);
      return { rows: [{
        id: POINT, scene_id: SCENE, label: 'Gate A', type: 'meet-point', scope: 'shared',
        latlng: null, position3d: { x: 1, y: 2, z: 3 }, notes: null, contact_ids: [CONTACT],
        route_waypoints: [], route_waypoints3d: [], camera_preset3d: null, building_ref: null,
        created_by: 'owner-profile', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      }] };
    }
    if (sql.includes('from contacts')) {
      assert.deepEqual(params, [SCENE, SITE]);
      assert.match(sql, /site_id = \$2 and active = true/);
      assert.match(sql, /unnest\(contact_ids\) from points where scene_id = \$1 and site_id = \$2 and scope = 'shared'/);
      return { rows: [{
        id: CONTACT, name: 'Reception', role: 'Visitor contact', phone: '+61 8 9000 0000', active: true,
        email: 'private@example.invalid', created_by: 'internal-profile', created_at: '2026-01-01T00:00:00Z',
      }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  } };

  await withPool(pool, async () => {
    const bundle = await scenesDb.getSceneBundleByCode(CODE, null);
    assert.equal(bundle.pins.length, 1);
    assert.equal(bundle.pins[0].id, POINT);
    assert.deepEqual(bundle.contacts, [{
      id: CONTACT, name: 'Reception', role: 'Visitor contact', phone: '+61 8 9000 0000', active: true,
    }]);
    assert.equal(Object.hasOwn(bundle.contacts[0], 'email'), false);
    assert.equal(Object.hasOwn(bundle.contacts[0], 'createdBy'), false);
    assert.equal(Object.hasOwn(bundle.contacts[0], 'createdAt'), false);
    assert.equal(JSON.stringify(bundle).includes('private@example.invalid'), false);
  });

  assert.equal(queries.length, 4);
});

test('signed-in share-code viewer gets the same minimal contact projection', async () => {
  const pool = { async query(sql) {
    if (sql.includes('from scenes s left join profiles')) return { rows: [{
      id: SCENE, site_id: SITE, name: 'Visitor guide', camera: null, kind: 'admin', status: 'open',
      created_by: 'viewer-profile', created_by_email: 'viewer@example.invalid', status_changed_by_email: null,
    }] };
    if (sql.includes('from scene_objects o')) return { rows: [] };
    if (sql.includes('select * from points')) return { rows: [] };
    if (sql.includes('from contacts')) return { rows: [{
      id: CONTACT, name: 'Reception', role: null, phone: '08 9000 0000', active: true,
      email: 'private@example.invalid', created_by: 'internal-profile', created_at: '2026-01-01T00:00:00Z',
    }] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  await withPool(pool, async () => {
    const bundle = await scenesDb.getSceneBundleByCode(CODE, 'viewer-profile');
    assert.deepEqual(Object.keys(bundle.contacts[0]).sort(), ['active', 'id', 'name', 'phone', 'role']);
    assert.equal(bundle.contacts[0].email, undefined);
  });
});
