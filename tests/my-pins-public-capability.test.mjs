import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scenesDb = require('../scenes-db.js');
const pointPhotosDb = require('../point-photos-db.js');
const caps = require('../my-pin-capabilities-db.js');
const supabaseDb = require('../supabase-db.js');

const SITE = '00000000-0000-4000-8000-000000000001';
const SCENE = '00000000-0000-4000-8000-000000000002';
const POINT = '00000000-0000-4000-8000-000000000003';
const CONTACT = '00000000-0000-4000-8000-000000000004';
const PHOTO = '00000000-0000-4000-8000-000000000005';
const INACTIVE_CONTACT = '00000000-0000-4000-8000-000000000006';
const CODE = 'abcde23456';
const TOKEN = 'A'.repeat(43);
const WRONG_TOKEN = 'B'.repeat(43);

function withPool(fakePool, fn) {
  const original = supabaseDb.pool;
  supabaseDb.pool = () => fakePool;
  return Promise.resolve().then(fn).finally(() => { supabaseDb.pool = original; });
}

function sharedBinding(overrides = {}) {
  return {
    site_id: SITE, scene_id: SCENE, point_id: POINT,
    scene_name: 'My pins', scene_kind: 'admin', scene_camera: { purpose: caps.PURPOSE },
    id: POINT, label: 'Gate A', type: 'meet-point', scope: 'shared',
    position3d: { x: 1, y: 2, z: 3 }, latlng: null,
    contact_ids: [CONTACT, INACTIVE_CONTACT], phone_override: null,
    route_waypoints: [], route_waypoints3d: [], created_by: 'owner-internal',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

test('anonymous My Pins workspace root still fails closed', async () => {
  const queries = [];
  await withPool({ async query(sql) {
    queries.push(sql);
    if (queries.length > 1) throw new Error('workspace rows must not be queried');
    return { rows: [{ id: SCENE, site_id: SITE, name: 'My pins', camera: { purpose: caps.PURPOSE }, kind: 'admin', created_by: 'owner' }] };
  } }, async () => {
    assert.equal(await scenesDb.getSceneBundleByCode(CODE, null), null);
    assert.equal(queries.length, 1);
  });
});

test('public capability resolver binds token hash to exact point/site/scene/purpose/shared scope', async () => {
  const queries = [];
  await withPool({ async query(sql, params) {
    queries.push({ sql, params });
    return { rows: [sharedBinding()] };
  } }, async () => {
    const row = await caps.resolveActivePublicBinding(TOKEN, POINT);
    assert.equal(row.point_id, POINT);
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].params, [caps.hashToken(TOKEN), POINT, caps.PURPOSE]);
    assert.match(queries[0].sql, /c\.token_hash = \$1/);
    assert.match(queries[0].sql, /c\.point_id = \$2::uuid/);
    assert.match(queries[0].sql, /c\.purpose = \$3/);
    assert.match(queries[0].sql, /c\.revoked_at is null/);
    assert.match(queries[0].sql, /s\.id = c\.scene_id and s\.site_id = c\.site_id/);
    assert.match(queries[0].sql, /p\.id = c\.point_id and p\.scene_id = c\.scene_id and p\.site_id = c\.site_id/);
    assert.match(queries[0].sql, /s\.camera->>'purpose' = \$3/);
    assert.match(queries[0].sql, /p\.scope = 'shared'/);
  });

  let called = false;
  await withPool({ async query() { called = true; return { rows: [] }; } }, async () => {
    assert.equal(await caps.resolveActivePublicBinding('bad-token', POINT), null);
    assert.equal(await caps.resolveActivePublicBinding(TOKEN, 'bad-point'), null);
    assert.equal(called, false);
  });
});

test('capability returns exactly one shared pin with minimal contact/photo metadata', async () => {
  const queries = [];
  const pool = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql.includes('from my_pin_capabilities c')) return { rows: [sharedBinding()] };
    if (sql.includes('from contacts')) {
      assert.deepEqual(params, [SITE, [CONTACT, INACTIVE_CONTACT]]);
      return { rows: [{ id: CONTACT, name: 'Public contact', role: 'Gate', phone: '000', active: true }] };
    }
    if (sql.includes('from point_photos ph')) {
      assert.deepEqual(params, [SITE, POINT]);
      return { rows: [{ id: PHOTO, point_id: POINT, bytes: 100, width: 640, height: 480, expires_at: null }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  } };

  await withPool(pool, async () => {
    const bundle = await scenesDb.getSharedMyPinByCapability(TOKEN, POINT);
    assert.equal(bundle.pins.length, 1);
    assert.equal(bundle.pins[0].id, POINT);
    assert.equal(Object.hasOwn(bundle.pins[0], 'createdBy'), false);
    assert.equal(Object.hasOwn(bundle.pins[0], 'sceneId'), false);
    assert.deepEqual(bundle.pins[0].contactIds, [CONTACT]);
    assert.deepEqual(bundle.contacts, [{ id: CONTACT, name: 'Public contact', role: 'Gate', phone: '000', active: true }]);
    assert.deepEqual(bundle.photos, [{ id: PHOTO, pointId: POINT, contentType: 'image/jpeg', bytes: 100, width: 640, height: 480, expiresAt: null }]);
    assert.deepEqual(bundle.objects, []);
    assert.deepEqual(bundle.viewer, { signedIn: false, isMine: false });
    assert.equal(JSON.stringify(bundle).includes('created_by'), false);
  });
});

test('phone override replaces public contact phone without leaking internal contact fields', async () => {
  const originalPhone = '0411 222 333';
  const overridePhone = '+61 499 888 777';
  const pool = { async query(sql) {
    if (sql.includes('from my_pin_capabilities c')) return { rows: [sharedBinding({ contact_ids: [CONTACT], phone_override: overridePhone })] };
    if (sql.includes('from contacts')) return { rows: [{ id: CONTACT, name: 'Warehouse Supervisor', role: 'Logistics', phone: originalPhone, active: true }] };
    if (sql.includes('from point_photos ph')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  await withPool(pool, async () => {
    const bundle = await scenesDb.getSharedMyPinByCapability(TOKEN, POINT);
    assert.equal(bundle.pins[0].phoneOverride, overridePhone);
    assert.equal(bundle.contacts[0].phone, overridePhone);
    assert.equal(JSON.stringify(bundle).includes(originalPhone), false);
    assert.deepEqual(Object.keys(bundle.contacts[0]).sort(), ['active', 'id', 'name', 'phone', 'role']);
  });
});

test('wrong/revoked/personal/cross-point capability misses uniformly before metadata projection', async () => {
  for (const token of [TOKEN, WRONG_TOKEN]) {
    let calls = 0;
    await withPool({ async query(sql, params) {
      calls++;
      assert.match(sql, /from my_pin_capabilities c/);
      assert.equal(params[1], POINT);
      assert.equal(params[0], caps.hashToken(token));
      return { rows: [] };
    } }, async () => {
      assert.equal(await scenesDb.getSharedMyPinByCapability(token, POINT), null);
      assert.equal(calls, 1);
    });
  }
  assert.equal(scenesDb.getSharedMyPinByCode, undefined);
});

test('public photo capability authorizes exact token/point/photo before compressed storage download', async () => {
  const queries = [];
  let downloaded = null;
  const pool = { async query(sql, params) {
    queries.push({ sql, params });
    return { rows: [{ id: PHOTO, point_id: POINT, storage_path: 'site/point/photo.jpg', original_path: 'site/point/photo-original.png' }] };
  } };
  const storage = { from(bucket) {
    assert.equal(bucket, 'point-photos');
    return { async download(path) {
      downloaded = path;
      const bytes = Uint8Array.from([1, 2, 3, 4]);
      return { data: { async arrayBuffer() { return bytes.buffer; } }, error: null };
    } };
  } };

  pointPhotosDb._setStorageForTesting(storage, true);
  try {
    await withPool(pool, async () => {
      const photo = await pointPhotosDb.readSharedScenePointPhotoByCapability(TOKEN, POINT, PHOTO);
      assert.equal(photo.contentType, 'image/jpeg');
      assert.deepEqual([...photo.buffer], [1, 2, 3, 4]);
      assert.equal(downloaded, 'site/point/photo.jpg');
      assert.equal(queries.length, 1);
      assert.deepEqual(queries[0].params, [caps.hashToken(TOKEN), POINT, caps.PURPOSE, PHOTO]);
      assert.match(queries[0].sql, /c\.token_hash = \$1/);
      assert.match(queries[0].sql, /c\.point_id = \$2::uuid/);
      assert.match(queries[0].sql, /c\.purpose = \$3/);
      assert.match(queries[0].sql, /p\.scope = 'shared'/);
      assert.match(queries[0].sql, /ph\.id = \$4::uuid/);
      assert.match(queries[0].sql, /expires_at is null or ph\.expires_at > now\(\)/);
      assert.notEqual(downloaded, 'site/point/photo-original.png');
    });
  } finally {
    pointPhotosDb._setStorageForTesting(null, false);
  }
});

test('public photo miss never reaches storage', async () => {
  let storageCalled = false;
  pointPhotosDb._setStorageForTesting({ from() { storageCalled = true; throw new Error('must not read storage'); } }, true);
  try {
    await withPool({ async query() { return { rows: [] }; } }, async () => {
      assert.equal(await pointPhotosDb.readSharedScenePointPhotoByCapability(TOKEN, POINT, PHOTO), null);
      assert.equal(storageCalled, false);
    });
  } finally {
    pointPhotosDb._setStorageForTesting(null, false);
  }
});

test('server exposes bearer-only My Pins point/photo routes and retains ordinary scene sharing', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /\^Bearer \(\[A-Za-z0-9_-\]\{43\}\)\$/);
  assert.match(source, /my-pin-public-point/);
  assert.match(source, /my-pin-public-photo/);
  assert.match(source, /readSharedScenePointPhotoByCapability\(_capToken/);
  assert.match(source, /getSharedMyPinByCapability\(_capToken/);
  assert.match(source, /\/api\\\/my-pins\\\/points/);
  assert.doesNotMatch(source, /\/api\\\/scenes\\\/by-code\\\/\(\[a-z0-9\]\{10\}\)\\\/points/);
  assert.match(source, /Cache-Control': 'private, no-store'/);
  assert.match(source, /Referrer-Policy': 'no-referrer'/);
  assert.match(source, /_sceneCodeMatch = \/\^\\\/api\\\/scenes\\\/by-code/);
});
