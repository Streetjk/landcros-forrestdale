import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pointPhotosDb = require('../point-photos-db.js');

const SITE_UUID = '00000000-0000-4000-8000-000000000001';
const SCENE_UUID = '00000000-0000-4000-8000-000000000002';
const POINT_UUID = '00000000-0000-4000-8000-000000000003';
const PHOTO_UUID = '00000000-0000-4000-8000-000000000004';
const ACTOR_UUID = '00000000-0000-4000-8000-000000000009';

test('static source analysis: legacy queries remain base-only and all scene queries bind site+scene+point', async () => {
  const code = await readFile(new URL('../point-photos-db.js', import.meta.url), 'utf8');

  // Legacy queries must check scene_id is null
  assert.match(code, /select id from points where id = \$1 and site_id = \$2 and scene_id is null/);
  assert.match(code, /where ph\.id = \$1 and p\.scene_id is null/);
  assert.match(code, /where ph\.id = \$1 and ph\.site_id = \$2 and p\.scene_id is null/);
  assert.match(code, /and p\.site_id = point_photos\.site_id and p\.scene_id is null/);

  // Scene resolvePoint must bind point, site, scene
  assert.match(code, /select id from points where id = \$1 and site_id = \$2 and scene_id = \$3/);

  // listScenePointPhotos query must bind site, scene, point
  const listMatch = code.match(/select ph\.\* from point_photos ph\s+join points p on p\.id = ph\.point_id and p\.site_id = ph\.site_id\s+where ph\.site_id = \$1 and p\.scene_id = \$2 and ph\.point_id = \$3/);
  assert.ok(listMatch, 'listScenePointPhotos must query point_photos joining points with site, scene, point bindings');

  // addScenePointPhoto count query must bind site, scene, point
  const countMatch = code.match(/select count\(\*\)::int as n\s+from point_photos ph\s+join points p on p\.id = ph\.point_id and p\.site_id = ph\.site_id\s+where ph\.site_id = \$1 and p\.scene_id = \$2 and ph\.point_id = \$3/);
  assert.ok(countMatch, 'addScenePointPhoto must count photos joining points with site, scene, point bindings');

  // addScenePointPhoto insert query must bind site, scene, point from points table
  assert.match(code, /where p\.id = \$3 and p\.site_id = \$2 and p\.scene_id = \$15/);

  // readScenePointPhoto query must bind photo, site, scene, point
  const readMatch = code.match(/where ph\.id = \$1 and ph\.site_id = \$2 and p\.scene_id = \$3 and ph\.point_id = \$4/);
  assert.ok(readMatch, 'readScenePointPhoto must bind photo, site, scene, point');

  // setScenePointPhotoRetention query must bind photo, site, point, scene
  assert.match(code, /where id = \$1 and site_id = \$2 and point_id = \$3\s+and exists \(select 1 from points p where p\.id = point_photos\.point_id\s+and p\.site_id = point_photos\.site_id and p\.scene_id = \$4\)/);

  // deleteScenePointPhoto query must bind photo, site, scene, point
  const deleteMatch = code.match(/deleteScenePointPhoto[\s\S]*?where ph\.id = \$1 and ph\.site_id = \$2 and p\.scene_id = \$3 and ph\.point_id = \$4/);
  assert.ok(deleteMatch, 'deleteScenePointPhoto must bind photo, site, scene, point');

  // sceneHasPointPhotos helper must join points and bind site, scene
  const hasPhotosMatch = code.match(/select 1 from point_photos ph\s+join points p on p\.id = ph\.point_id and p\.site_id = ph\.site_id\s+where ph\.site_id = \$1 and p\.scene_id = \$2/);
  assert.ok(hasPhotosMatch, 'sceneHasPointPhotos must join points and filter site and scene');
});

test('DAL: sceneHasPointPhotos queries exact site and scene', async () => {
  const executed = [];
  const fakePool = {
    async query(sql, params) {
      executed.push({ sql, params });
      return { rows: [{ '?column?': 1 }] };
    },
  };

  const supabaseDb = require('../supabase-db.js');
  const origPool = supabaseDb.pool;
  const origGetSiteId = supabaseDb.getSiteId;

  try {
    supabaseDb.pool = () => fakePool;
    supabaseDb.getSiteId = async (slug) => {
      assert.equal(slug, 'landcros');
      return SITE_UUID;
    };

    const has = await pointPhotosDb.sceneHasPointPhotos('landcros', SCENE_UUID);
    assert.equal(has, true);
    assert.equal(executed.length, 1);
    assert.match(executed[0].sql, /select 1 from point_photos ph\s+join points p on p\.id = ph\.point_id and p\.site_id = ph\.site_id\s+where ph\.site_id = \$1 and p\.scene_id = \$2/);
    assert.deepEqual(executed[0].params, [SITE_UUID, SCENE_UUID]);
  } finally {
    supabaseDb.pool = origPool;
    supabaseDb.getSiteId = origGetSiteId;
  }
});

test('DAL: listScenePointPhotos verifies scene point and binds site, scene, point', async () => {
  const executed = [];
  const fakePool = {
    async query(sql, params) {
      executed.push({ sql, params });
      if (sql.includes('from points where id = $1')) {
        return { rows: [{ id: POINT_UUID }] };
      }
      return {
        rows: [{
          id: PHOTO_UUID,
          point_id: POINT_UUID,
          content_type: 'image/jpeg',
          original_name: 'pic.jpg',
          bytes: 1234,
          original_bytes: 5678,
          width: 640,
          height: 480,
          created_at: '2026-09-21T00:00:00Z',
          expires_at: null,
        }],
      };
    },
  };

  const supabaseDb = require('../supabase-db.js');
  const origPool = supabaseDb.pool;
  const origGetSiteId = supabaseDb.getSiteId;

  try {
    supabaseDb.pool = () => fakePool;
    supabaseDb.getSiteId = async () => SITE_UUID;

    const photos = await pointPhotosDb.listScenePointPhotos('landcros', SCENE_UUID, POINT_UUID);
    assert.equal(photos.length, 1);
    assert.equal(photos[0].id, PHOTO_UUID);
    assert.equal(photos[0].pointId, POINT_UUID);

    // Verify resolvePoint check
    assert.match(executed[0].sql, /select id from points where id = \$1 and site_id = \$2 and scene_id = \$3/);
    assert.deepEqual(executed[0].params, [POINT_UUID, SITE_UUID, SCENE_UUID]);

    // Verify list query
    assert.match(executed[1].sql, /where ph\.site_id = \$1 and p\.scene_id = \$2 and ph\.point_id = \$3/);
    assert.deepEqual(executed[1].params, [SITE_UUID, SCENE_UUID, POINT_UUID]);
  } finally {
    supabaseDb.pool = origPool;
    supabaseDb.getSiteId = origGetSiteId;
  }
});

test('DAL: setScenePointPhotoRetention binds photo, site, point, scene', async () => {
  const executed = [];
  const fakePool = {
    async query(sql, params) {
      executed.push({ sql, params });
      return {
        rows: [{
          id: PHOTO_UUID,
          point_id: POINT_UUID,
          content_type: 'image/jpeg',
          original_name: 'pic.jpg',
          bytes: 1234,
          original_bytes: 5678,
          width: 640,
          height: 480,
          created_at: '2026-09-21T00:00:00Z',
          expires_at: null,
        }],
      };
    },
  };

  const supabaseDb = require('../supabase-db.js');
  const origPool = supabaseDb.pool;
  const origGetSiteId = supabaseDb.getSiteId;

  try {
    supabaseDb.pool = () => fakePool;
    supabaseDb.getSiteId = async () => SITE_UUID;

    const updated = await pointPhotosDb.setScenePointPhotoRetention('landcros', SCENE_UUID, POINT_UUID, PHOTO_UUID, true);
    assert.equal(updated.id, PHOTO_UUID);
    assert.equal(executed.length, 1);
    assert.match(executed[0].sql, /where id = \$1 and site_id = \$2 and point_id = \$3/);
    assert.deepEqual(executed[0].params.slice(0, 5), [PHOTO_UUID, SITE_UUID, POINT_UUID, SCENE_UUID, true]);
  } finally {
    supabaseDb.pool = origPool;
    supabaseDb.getSiteId = origGetSiteId;
  }
});

test('DAL: deleteScenePointPhoto queries photo with site, scene, point bindings', async () => {
  const executed = [];
  const fakePool = {
    async query(sql, params) {
      executed.push({ sql, params });
      if (sql.includes('select ph.* from point_photos ph')) {
        return {
          rows: [{
            id: PHOTO_UUID,
            storage_path: 'path/to/thumb.jpg',
            original_path: 'path/to/orig.jpg',
          }],
        };
      }
      return { rows: [] };
    },
  };

  const supabaseDb = require('../supabase-db.js');
  const origPool = supabaseDb.pool;
  const origGetSiteId = supabaseDb.getSiteId;

  try {
    supabaseDb.pool = () => fakePool;
    supabaseDb.getSiteId = async () => SITE_UUID;

    // Test with mock storage
    const origStorage = pointPhotosDb.storage;
    await assert.rejects(
      async () => pointPhotosDb.deleteScenePointPhoto('landcros', SCENE_UUID, POINT_UUID, PHOTO_UUID),
      /SUPABASE_URL \/ SUPABASE_SECRET_KEY/
    );

    // Verify select query had exact bindings before storage call
    assert.match(executed[0].sql, /where ph\.id = \$1 and ph\.site_id = \$2 and p\.scene_id = \$3 and ph\.point_id = \$4/);
    assert.deepEqual(executed[0].params, [PHOTO_UUID, SITE_UUID, SCENE_UUID, POINT_UUID]);
  } finally {
    supabaseDb.pool = origPool;
    supabaseDb.getSiteId = origGetSiteId;
  }
});

test('DAL: _resolveScenePoint throws point-not-found when pin is missing in scene', async () => {
  const fakePool = {
    async query() {
      return { rows: [] };
    },
  };

  const supabaseDb = require('../supabase-db.js');
  const origPool = supabaseDb.pool;
  const origGetSiteId = supabaseDb.getSiteId;

  try {
    supabaseDb.pool = () => fakePool;
    supabaseDb.getSiteId = async () => SITE_UUID;

    await assert.rejects(
      async () => pointPhotosDb.listScenePointPhotos('landcros', SCENE_UUID, POINT_UUID),
      (err) => {
        assert.ok(err instanceof pointPhotosDb.PointPhotoError);
        assert.equal(err.code, 'point-not-found');
        return true;
      }
    );
  } finally {
    supabaseDb.pool = origPool;
    supabaseDb.getSiteId = origGetSiteId;
  }
});
