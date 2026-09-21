import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scenesDb = require('../scenes-db.js');
const pointPhotosDb = require('../point-photos-db.js');
const supabaseDb = require('../supabase-db.js');

const SITE = '00000000-0000-4000-8000-000000000001';
const SCENE = '00000000-0000-4000-8000-000000000002';
const POINT = '00000000-0000-4000-8000-000000000003';
const CONTACT = '00000000-0000-4000-8000-000000000004';
const PHOTO = '00000000-0000-4000-8000-000000000005';
const CODE = 'abcde23456';

function withPool(fakePool, fn) {
  const original = supabaseDb.pool;
  supabaseDb.pool = () => fakePool;
  return Promise.resolve().then(fn).finally(() => { supabaseDb.pool = original; });
}

test('My Pins anonymous root bundle fails closed before workspace rows are read', async () => {
  const queries = [];
  await withPool({ async query(sql, params) {
    queries.push({ sql, params });
    if (queries.length > 1) throw new Error('workspace rows must not be queried');
    return { rows: [{ id: SCENE, site_id: SITE, name: 'My pins', camera: { purpose: 'my-pins-v1' }, kind: 'admin', created_by: 'owner' }] };
  } }, async () => {
    const bundle = await scenesDb.getSceneBundleByCode(CODE, null);
    assert.equal(bundle, null);
    assert.equal(queries.length, 1);
  });
});

test('point-qualified capability returns one shared pin and only its contact/photo metadata', async () => {
  const queries = [];
  const pool = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql.includes("s.camera->>'purpose'")) {
      return { rows: [{ id: SCENE, site_id: SITE, name: 'My pins', camera: { purpose: 'my-pins-v1' }, kind: 'admin' }] };
    }
    if (sql.includes('select * from points')) {
      assert.deepEqual(params, [POINT, SITE, SCENE]);
      return { rows: [{ id: POINT, site_id: SITE, scene_id: SCENE, label: 'Gate A', type: 'meet-point', scope: 'shared', position3d: { x: 1, y: 2, z: 3 }, contact_ids: [CONTACT], route_waypoints: [], route_waypoints3d: [], created_by: 'owner-internal' }] };
    }
    if (sql.includes('select * from contacts')) {
      assert.deepEqual(params, [SITE, [CONTACT]]);
      return { rows: [{ id: CONTACT, name: 'Public contact', role: 'Gate', phone: '000', email: 'public@example.invalid', active: true, created_by: 'internal', created_at: '2026-01-01T00:00:00Z' }] };
    }
    if (sql.includes('select ph.id')) {
      assert.deepEqual(params, [SITE, SCENE, POINT]);
      return { rows: [{ id: PHOTO, point_id: POINT, content_type: 'image/jpeg', original_name: 'gate.jpg', bytes: 100, original_bytes: 1000, width: 640, height: 480, created_at: '2026-01-01T00:00:00Z', expires_at: null }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  } };
  await withPool(pool, async () => {
    const bundle = await scenesDb.getSharedMyPinByCode(CODE, POINT);
    assert.equal(bundle.pins.length, 1);
    assert.equal(bundle.pins[0].id, POINT);
    assert.equal(Object.hasOwn(bundle.pins[0], 'createdBy'), false);
    assert.deepEqual(bundle.pins[0].contactIds, [CONTACT]);
    assert.equal(bundle.contacts.length, 1);
    assert.equal(bundle.contacts[0].id, CONTACT);
    assert.equal(Object.hasOwn(bundle.contacts[0], 'createdBy'), false);
    assert.equal(Object.hasOwn(bundle.contacts[0], 'createdAt'), false);
    assert.equal(bundle.photos.length, 1);
    assert.equal(bundle.photos[0].id, PHOTO);
    assert.equal(Object.hasOwn(bundle.photos[0], 'storagePath'), false);
    assert.equal(Object.hasOwn(bundle.photos[0], 'originalPath'), false);
    assert.deepEqual(bundle.objects, []);
    assert.deepEqual(bundle.viewer, { signedIn: false, isMine: false });
  });
});

test('personal/revoked or wrong-purpose point capability returns not found', async () => {
  let calls = 0;
  await withPool({ async query(sql) {
    calls++;
    if (calls === 1) return { rows: [{ id: SCENE, site_id: SITE, name: 'My pins', camera: { purpose: 'my-pins-v1' }, kind: 'admin' }] };
    if (sql.includes('select * from points')) return { rows: [] };
    throw new Error('no contact/photo query is allowed after point miss');
  } }, async () => {
    assert.equal(await scenesDb.getSharedMyPinByCode(CODE, POINT), null);
    assert.equal(calls, 2);
  });

  await withPool({ async query() { return { rows: [] }; } }, async () => {
    assert.equal(await scenesDb.getSharedMyPinByCode('wrong23456', POINT), null);
  });
});

test('public photo read binds scene code, My Pins purpose, shared point and photo before storage', async () => {
  const queries = [];
  let downloaded = null;
  const pool = { async query(sql, params) {
    queries.push({ sql, params });
    return { rows: [{ id: PHOTO, point_id: POINT, storage_path: 'site/point/photo.jpg', original_path: 'site/point/photo-original.png', original_name: 'photo.png' }] };
  } };
  const storage = {
    from(bucket) {
      assert.equal(bucket, 'point-photos');
      return { async download(path) {
        downloaded = path;
        const bytes = Uint8Array.from([1, 2, 3, 4]);
        return { data: { async arrayBuffer() { return bytes.buffer; } }, error: null };
      } };
    }
  };

  pointPhotosDb._setStorageForTesting(storage, true);
  try {
    await withPool(pool, async () => {
      const photo = await pointPhotosDb.readSharedScenePointPhotoByCode(CODE, POINT, PHOTO);
      assert.equal(photo.contentType, 'image/jpeg');
      assert.deepEqual([...photo.buffer], [1, 2, 3, 4]);
      assert.equal(downloaded, 'site/point/photo.jpg');
      assert.equal(queries.length, 1);
      assert.deepEqual(queries[0].params, [CODE, POINT, PHOTO]);
      assert.match(queries[0].sql, /s\.share_code = \$1/);
      assert.match(queries[0].sql, /s\.camera->>'purpose' = 'my-pins-v1'/);
      assert.match(queries[0].sql, /p\.id = \$2/);
      assert.match(queries[0].sql, /p\.scope = 'shared'/);
      assert.match(queries[0].sql, /ph\.id = \$3/);
      assert.match(queries[0].sql, /expires_at is null or ph\.expires_at > now\(\)/);
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
      assert.equal(await pointPhotosDb.readSharedScenePointPhotoByCode(CODE, POINT, PHOTO), null);
      assert.equal(storageCalled, false);
    });
  } finally {
    pointPhotosDb._setStorageForTesting(null, false);
  }
});

test('server exposes only point-qualified My Pins public routes with conservative cache policy', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /my-pin-public-point/);
  assert.match(source, /my-pin-public-photo/);
  assert.match(source, /readSharedScenePointPhotoByCode/);
  assert.match(source, /getSharedMyPinByCode/);
  assert.match(source, /Cache-Control': 'private, no-store'/);
  assert.match(source, /isMyPinsWorkspace/);
  assert.match(source, /bundle\.viewer\?\.isMine/);
});
