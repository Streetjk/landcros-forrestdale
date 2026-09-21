import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const scenesDb = require('../scenes-db.js');

const SLUG = 'landcros';
const SCENE_OWNED = '00000000-0000-4000-8000-000000000001';
const OWNER_ID = '00000000-0000-4000-8000-000000000011';
const OTHER_ID = '00000000-0000-4000-8000-000000000012';

const pointPhotosDb = require('../point-photos-db.js');
const supabaseDb = require('../supabase-db.js');

test('scenesDb.deleteScene starts transaction, locks scene row FOR UPDATE, rechecks photos, rolls back and returns 409 when photos present', async () => {
  const origPool = supabaseDb.pool;
  const origGetSiteId = supabaseDb.getSiteId;

  const queries = [];
  let clientReleased = false;

  try {
    supabaseDb.getSiteId = async () => '00000000-0000-4000-8000-000000000099';
    supabaseDb.pool = () => ({
      async connect() {
        return {
          async query(sql, params) {
            queries.push({ sql, params });
            if (sql.includes('from scenes where id = $1 and site_id = $2 for update')) {
              return { rows: [{ id: SCENE_OWNED, name: 'Test Scene' }] };
            }
            if (sql.includes('from point_photos ph')) {
              return { rows: [{ '?column?': 1 }] };
            }
            return { rows: [] };
          },
          release() {
            clientReleased = true;
          },
        };
      },
    });

    await assert.rejects(
      async () => scenesDb.deleteScene(SLUG, SCENE_OWNED, OWNER_ID),
      (err) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, 'SCENE_HAS_POINT_PHOTOS');
        return true;
      }
    );

    // Verify exact transaction and lock ordering
    assert.equal(queries[0].sql, 'BEGIN');
    assert.match(queries[1].sql, /select id, name from scenes where id = \$1 and site_id = \$2 for update/);
    assert.deepEqual(queries[1].params, [SCENE_OWNED, '00000000-0000-4000-8000-000000000099']);
    assert.match(queries[2].sql, /select 1 from point_photos ph/);
    assert.deepEqual(queries[2].params, ['00000000-0000-4000-8000-000000000099', SCENE_OWNED]);
    assert.equal(queries[3].sql, 'ROLLBACK');
    assert.equal(queries.some(q => q.sql.includes('delete from scenes')), false, 'scene must not be deleted');
    assert.equal(queries.some(q => q.sql.includes('audit_log')), false, 'audit must not be written');
    assert.equal(clientReleased, true, 'client must be released');
  } finally {
    supabaseDb.pool = origPool;
    supabaseDb.getSiteId = origGetSiteId;
  }
});

test('scenesDb.deleteScene locks scene row, deletes scene and inserts audit in same transaction before commit when no photos', async () => {
  const origPool = supabaseDb.pool;
  const origGetSiteId = supabaseDb.getSiteId;

  const queries = [];
  let clientReleased = false;

  try {
    supabaseDb.getSiteId = async () => '00000000-0000-4000-8000-000000000099';
    supabaseDb.pool = () => ({
      async connect() {
        return {
          async query(sql, params) {
            queries.push({ sql, params });
            if (sql.includes('from scenes where id = $1 and site_id = $2 for update')) {
              return { rows: [{ id: SCENE_OWNED, name: 'Clean scene' }] };
            }
            if (sql.includes('from point_photos ph')) {
              return { rows: [] };
            }
            if (sql.includes('delete from scenes')) {
              return { rows: [{ name: 'Clean scene' }] };
            }
            return { rows: [] };
          },
          release() {
            clientReleased = true;
          },
        };
      },
    });

    await scenesDb.deleteScene(SLUG, SCENE_OWNED, OWNER_ID);

    // Verify ordering: BEGIN -> SELECT FOR UPDATE -> SELECT point_photos -> DELETE -> AUDIT -> COMMIT
    assert.equal(queries[0].sql, 'BEGIN');
    assert.match(queries[1].sql, /select id, name from scenes where id = \$1 and site_id = \$2 for update/);
    assert.match(queries[2].sql, /select 1 from point_photos ph/);
    assert.match(queries[3].sql, /delete from scenes where id = \$1 and site_id = \$2/);
    assert.deepEqual(queries[3].params, [SCENE_OWNED, '00000000-0000-4000-8000-000000000099']);
    assert.match(queries[4].sql, /insert into audit_log/);
    assert.deepEqual(queries[4].params, ['00000000-0000-4000-8000-000000000099', OWNER_ID, 'delete', 'scene', SCENE_OWNED, 'Clean scene']);
    assert.equal(queries[5].sql, 'COMMIT');
    assert.equal(clientReleased, true, 'client must be released');
  } finally {
    supabaseDb.pool = origPool;
    supabaseDb.getSiteId = origGetSiteId;
  }
});

test('scenesDb.deleteScene commits cleanly without deleting or auditing if scene row not found', async () => {
  const origPool = supabaseDb.pool;
  const origGetSiteId = supabaseDb.getSiteId;

  const queries = [];
  let clientReleased = false;

  try {
    supabaseDb.getSiteId = async () => '00000000-0000-4000-8000-000000000099';
    supabaseDb.pool = () => ({
      async connect() {
        return {
          async query(sql, params) {
            queries.push({ sql, params });
            return { rows: [] };
          },
          release() {
            clientReleased = true;
          },
        };
      },
    });

    await scenesDb.deleteScene(SLUG, SCENE_OWNED, OWNER_ID);

    assert.equal(queries[0].sql, 'BEGIN');
    assert.match(queries[1].sql, /select id, name from scenes where id = \$1 and site_id = \$2 for update/);
    assert.equal(queries[2].sql, 'COMMIT');
    assert.equal(queries.some(q => q.sql.includes('delete from scenes')), false);
    assert.equal(queries.some(q => q.sql.includes('audit_log')), false);
    assert.equal(clientReleased, true);
  } finally {
    supabaseDb.pool = origPool;
    supabaseDb.getSiteId = origGetSiteId;
  }
});

test('scene DELETE HTTP logic: 409 refused for photo-bearing scene without touching hazard storage or scene deletion', async () => {
  // Simulates the exact server.js DELETE handler logic
  const calls = [];
  const fakeScenesDb = {
    async getSceneMeta(slug, id) {
      calls.push(['getSceneMeta', slug, id]);
      return { id, createdBy: OWNER_ID, name: 'Owned scene' };
    },
    async sceneHasPointPhotos(slug, id) {
      calls.push(['sceneHasPointPhotos', slug, id]);
      return true; // Has photos!
    },
    async deleteScene(slug, id, actor) {
      calls.push(['deleteScene', slug, id, actor]);
      return { ok: true };
    },
    async unsubscribe(id, actor) {
      calls.push(['unsubscribe', id, actor]);
    },
  };
  const fakeHazardDb = {
    async deletePhotosForScene(slug, id) {
      calls.push(['deletePhotosForScene', slug, id]);
    },
  };

  async function handleDelete(slug, id, session, isPlatformAdmin = false) {
    const meta = await fakeScenesDb.getSceneMeta(slug, id);
    if (!meta) return { status: 404, body: { error: 'not found' } };
    if (meta.createdBy && meta.createdBy !== session.profileId && !isPlatformAdmin) {
      await fakeScenesDb.unsubscribe(id, session.profileId);
      return { status: 200, body: { ok: true, removed: 'subscription' } };
    }
    if (await fakeScenesDb.sceneHasPointPhotos(slug, id)) {
      return { status: 409, body: { error: 'SCENE_HAS_POINT_PHOTOS' } };
    }
    if (meta.kind === 'hazard') {
      await fakeHazardDb.deletePhotosForScene(slug, id);
    }
    try {
      await fakeScenesDb.deleteScene(slug, id, session.profileId);
      return { status: 200, body: { ok: true } };
    } catch (e) {
      if (e && (e.status === 409 || e.code === 'SCENE_HAS_POINT_PHOTOS')) {
        return { status: 409, body: { error: 'SCENE_HAS_POINT_PHOTOS' } };
      }
      throw e;
    }
  }

  // 1. Owner deleting admin scene with photos -> 409 early refusal
  const ownerResult = await handleDelete(SLUG, SCENE_OWNED, { profileId: OWNER_ID });
  assert.equal(ownerResult.status, 409);
  assert.equal(ownerResult.body.error, 'SCENE_HAS_POINT_PHOTOS');
  assert.deepEqual(calls, [
    ['getSceneMeta', SLUG, SCENE_OWNED],
    ['sceneHasPointPhotos', SLUG, SCENE_OWNED],
  ]);
  assert.equal(calls.some(c => c[0] === 'deletePhotosForScene'), false, 'Hazard cleanup must never run on 409');
  assert.equal(calls.some(c => c[0] === 'deleteScene'), false, 'deleteScene must not be called when photos present');

  // 2. Non-owner deleting scene -> unsubscription only, does not check photos or delete scene
  calls.length = 0;
  const nonOwnerResult = await handleDelete(SLUG, SCENE_OWNED, { profileId: OTHER_ID });
  assert.equal(nonOwnerResult.status, 200);
  assert.equal(nonOwnerResult.body.removed, 'subscription');
  assert.deepEqual(calls, [
    ['getSceneMeta', SLUG, SCENE_OWNED],
    ['unsubscribe', SCENE_OWNED, OTHER_ID],
  ]);

  // 3. Owner deleting admin scene with NO photos -> 200 ok, never invokes hazard cleanup
  calls.length = 0;
  fakeScenesDb.sceneHasPointPhotos = async (slug, id) => {
    calls.push(['sceneHasPointPhotos', slug, id]);
    return false;
  };
  fakeScenesDb.getSceneMeta = async (slug, id) => {
    calls.push(['getSceneMeta', slug, id]);
    return { id, createdBy: OWNER_ID, name: 'Admin scene', kind: 'admin' };
  };
  const adminCleanResult = await handleDelete(SLUG, SCENE_OWNED, { profileId: OWNER_ID });
  assert.equal(adminCleanResult.status, 200);
  assert.equal(adminCleanResult.body.ok, true);
  assert.deepEqual(calls, [
    ['getSceneMeta', SLUG, SCENE_OWNED],
    ['sceneHasPointPhotos', SLUG, SCENE_OWNED],
    ['deleteScene', SLUG, SCENE_OWNED, OWNER_ID],
  ]);
  assert.equal(calls.some(c => c[0] === 'deletePhotosForScene'), false, 'Admin scene deletion must never invoke hazard cleanup');

  // 4. Owner deleting actual hazard scene -> invokes hazard cleanup
  calls.length = 0;
  const HAZARD_SCENE_ID = '00000000-0000-4000-8000-000000000033';
  fakeScenesDb.getSceneMeta = async (slug, id) => {
    calls.push(['getSceneMeta', slug, id]);
    return { id, createdBy: OWNER_ID, name: 'Hazard report', kind: 'hazard' };
  };
  const hazardCleanResult = await handleDelete(SLUG, HAZARD_SCENE_ID, { profileId: OWNER_ID });
  assert.equal(hazardCleanResult.status, 200);
  assert.equal(hazardCleanResult.body.ok, true);
  assert.deepEqual(calls, [
    ['getSceneMeta', SLUG, HAZARD_SCENE_ID],
    ['sceneHasPointPhotos', SLUG, HAZARD_SCENE_ID],
    ['deletePhotosForScene', SLUG, HAZARD_SCENE_ID],
    ['deleteScene', SLUG, HAZARD_SCENE_ID, OWNER_ID],
  ]);

  // 5. Admin scene deletion race: concurrent photo upload causes transactional deleteScene 409
  // Proves admin scene deletion does not invoke hazard cleanup even when deleteScene rolls back with 409
  calls.length = 0;
  fakeScenesDb.getSceneMeta = async (slug, id) => {
    calls.push(['getSceneMeta', slug, id]);
    return { id, createdBy: OWNER_ID, name: 'Admin scene', kind: 'admin' };
  };
  fakeScenesDb.deleteScene = async () => {
    calls.push(['deleteScene', SLUG, SCENE_OWNED, OWNER_ID]);
    const err = new Error('SCENE_HAS_POINT_PHOTOS');
    err.status = 409;
    err.code = 'SCENE_HAS_POINT_PHOTOS';
    throw err;
  };
  const raceResult = await handleDelete(SLUG, SCENE_OWNED, { profileId: OWNER_ID });
  assert.equal(raceResult.status, 409);
  assert.equal(raceResult.body.error, 'SCENE_HAS_POINT_PHOTOS');
  assert.deepEqual(calls, [
    ['getSceneMeta', SLUG, SCENE_OWNED],
    ['sceneHasPointPhotos', SLUG, SCENE_OWNED],
    ['deleteScene', SLUG, SCENE_OWNED, OWNER_ID],
  ]);
  assert.equal(calls.some(c => c[0] === 'deletePhotosForScene'), false, 'Hazard cleanup must NOT be invoked on admin scene even during concurrent photo race');
});

// ── addScenePointPhoto transaction, lock ordering, and rollback cleanup ───

const POINT_ID = '00000000-0000-4000-8000-000000000002';
const SITE_ID = '00000000-0000-4000-8000-000000000099';
const SAMPLE_PHOTO = {
  compressed: Buffer.from('compressed-image-data'),
  original: Buffer.from('original-image-data'),
  contentType: 'image/jpeg',
  originalName: 'photo.jpg',
  width: 800,
  height: 600,
  keepIndefinitely: false,
};

function makeFakeStorage(events = []) {
  const uploads = [];
  const removals = [];
  return {
    uploads,
    removals,
    storage: {
      from(bucket) {
        return {
          async upload(path, buffer, opts) {
            events.push(['storage:upload', path]);
            uploads.push({ path, buffer, opts });
            return { data: { path }, error: null };
          },
          async remove(paths) {
            events.push(['storage:remove', paths]);
            removals.push(paths);
            return { data: paths, error: null };
          },
        };
      },
      async createBucket() { return { data: null, error: null }; },
    },
  };
}

test('addScenePointPhoto: uploads Storage before transaction, locks scene row FOR UPDATE, revalidates point and limit, inserts metadata and commits', async () => {
  const origPool = supabaseDb.pool;
  const origGetSiteId = supabaseDb.getSiteId;

  const events = [];
  const fakeStorage = makeFakeStorage(events);
  let clientReleased = false;

  try {
    pointPhotosDb._setStorageForTesting(fakeStorage.storage);
    supabaseDb.getSiteId = async () => SITE_ID;
    supabaseDb.pool = () => ({
      async query(sql, params) {
        // Pre-upload queries
        if (sql.includes('from points where id = $1 and site_id = $2 and scene_id = $3')) {
          events.push(['db:precheck:point', params]);
          return { rows: [{ id: POINT_ID }] };
        }
        if (sql.includes('from point_photos ph') && sql.includes('count(*)::int')) {
          events.push(['db:precheck:count', params]);
          return { rows: [{ n: 0 }] };
        }
        return { rows: [] };
      },
      async connect() {
        return {
          async query(sql, params) {
            if (sql === 'BEGIN') {
              events.push(['db:BEGIN']);
              return { rows: [] };
            }
            if (sql.includes('from scenes where id = $1 and site_id = $2 for update')) {
              events.push(['db:scene-lock', params]);
              return { rows: [{ id: SCENE_OWNED }] };
            }
            if (sql.includes('from points where id = $1 and site_id = $2 and scene_id = $3')) {
              events.push(['db:point-revalidate', params]);
              return { rows: [{ id: POINT_ID }] };
            }
            if (sql.includes('from point_photos ph') && sql.includes('count(*)::int')) {
              events.push(['db:count-recheck', params]);
              return { rows: [{ n: 0 }] };
            }
            if (sql.includes('insert into point_photos')) {
              events.push(['db:insert', params]);
              return {
                rows: [{
                  id: params[0],
                  point_id: POINT_ID,
                  content_type: 'image/jpeg',
                  original_name: 'photo.jpg',
                  bytes: params[7],
                  original_bytes: params[8],
                  width: 800,
                  height: 600,
                  created_at: new Date().toISOString(),
                  expires_at: null,
                }],
              };
            }
            if (sql === 'COMMIT') {
              events.push(['db:COMMIT']);
              return { rows: [] };
            }
            return { rows: [] };
          },
          release() {
            clientReleased = true;
          },
        };
      },
    });

    const photo = await pointPhotosDb.addScenePointPhoto(SLUG, SCENE_OWNED, POINT_ID, SAMPLE_PHOTO, OWNER_ID);
    assert.ok(photo.id);
    assert.equal(photo.pointId, POINT_ID);

    // Verify storage upload happened BEFORE transaction BEGIN
    const firstUploadIdx = events.findIndex(e => e[0] === 'storage:upload');
    const secondUploadIdx = events.findLastIndex(e => e[0] === 'storage:upload');
    const beginIdx = events.findIndex(e => e[0] === 'db:BEGIN');
    const sceneLockIdx = events.findIndex(e => e[0] === 'db:scene-lock');
    const pointRevalIdx = events.findIndex(e => e[0] === 'db:point-revalidate');
    const countRecheckIdx = events.findIndex(e => e[0] === 'db:count-recheck');
    const insertIdx = events.findIndex(e => e[0] === 'db:insert');
    const commitIdx = events.findIndex(e => e[0] === 'db:COMMIT');

    assert.ok(firstUploadIdx !== -1, 'first storage upload must happen');
    assert.ok(secondUploadIdx > firstUploadIdx, 'second storage upload must happen');
    assert.ok(secondUploadIdx < beginIdx, 'Storage upload must finish BEFORE db transaction BEGIN');
    assert.ok(beginIdx < sceneLockIdx, 'BEGIN must precede scene row lock');
    assert.ok(sceneLockIdx < pointRevalIdx, 'Scene lock must precede point revalidation');
    assert.ok(pointRevalIdx < countRecheckIdx, 'Point revalidation must precede count recheck');
    assert.ok(countRecheckIdx < insertIdx, 'Count recheck must precede insert');
    assert.ok(insertIdx < commitIdx, 'Insert must precede COMMIT');

    // Verify exact bindings on scene row lock
    assert.deepEqual(events[sceneLockIdx][1], [SCENE_OWNED, SITE_ID]);

    // Verify no removals were triggered on success
    assert.equal(events.some(e => e[0] === 'storage:remove'), false, 'storage.remove must not be called on success');
    assert.equal(clientReleased, true, 'client connection must be released');
  } finally {
    pointPhotosDb._setStorageForTesting(null);
    supabaseDb.pool = origPool;
    supabaseDb.getSiteId = origGetSiteId;
  }
});

test('addScenePointPhoto: rolls back transaction and removes uploaded storage objects when scene vanished under lock (race with deleteScene)', async () => {
  const origPool = supabaseDb.pool;
  const origGetSiteId = supabaseDb.getSiteId;

  const events = [];
  const fakeStorage = makeFakeStorage(events);
  let clientReleased = false;

  try {
    pointPhotosDb._setStorageForTesting(fakeStorage.storage);
    supabaseDb.getSiteId = async () => SITE_ID;
    supabaseDb.pool = () => ({
      async query(sql) {
        if (sql.includes('from points where id = $1')) return { rows: [{ id: POINT_ID }] };
        if (sql.includes('count(*)::int')) return { rows: [{ n: 0 }] };
        return { rows: [] };
      },
      async connect() {
        return {
          async query(sql) {
            if (sql === 'BEGIN') {
              events.push(['db:BEGIN']);
              return { rows: [] };
            }
            if (sql.includes('from scenes where id = $1 and site_id = $2 for update')) {
              events.push(['db:scene-lock']);
              // Scene was deleted by concurrent deleteScene!
              return { rows: [] };
            }
            if (sql === 'ROLLBACK') {
              events.push(['db:ROLLBACK']);
              return { rows: [] };
            }
            return { rows: [] };
          },
          release() {
            clientReleased = true;
          },
        };
      },
    });

    await assert.rejects(
      async () => pointPhotosDb.addScenePointPhoto(SLUG, SCENE_OWNED, POINT_ID, SAMPLE_PHOTO, OWNER_ID),
      (err) => {
        assert.equal(err.code, 'point-not-found');
        return true;
      }
    );

    // Verify rollback and storage cleanup
    assert.ok(events.some(e => e[0] === 'db:ROLLBACK'), 'ROLLBACK must be issued');
    const removeEvent = events.find(e => e[0] === 'storage:remove');
    assert.ok(removeEvent, 'Storage removal must be triggered to prevent orphaned bytes');
    assert.equal(removeEvent[1].length, 2, 'both thumbnail and original must be removed');
    assert.match(removeEvent[1][0], /\.jpg$/);
    assert.match(removeEvent[1][1], /-original\.jpg$/);
    assert.equal(clientReleased, true, 'client connection must be released');
  } finally {
    pointPhotosDb._setStorageForTesting(null);
    supabaseDb.pool = origPool;
    supabaseDb.getSiteId = origGetSiteId;
  }
});

test('addScenePointPhoto: rolls back transaction and removes uploaded storage objects when point vanished under lock', async () => {
  const origPool = supabaseDb.pool;
  const origGetSiteId = supabaseDb.getSiteId;

  const events = [];
  const fakeStorage = makeFakeStorage(events);
  let clientReleased = false;

  try {
    pointPhotosDb._setStorageForTesting(fakeStorage.storage);
    supabaseDb.getSiteId = async () => SITE_ID;
    supabaseDb.pool = () => ({
      async query(sql) {
        if (sql.includes('from points where id = $1')) return { rows: [{ id: POINT_ID }] };
        if (sql.includes('count(*)::int')) return { rows: [{ n: 0 }] };
        return { rows: [] };
      },
      async connect() {
        return {
          async query(sql) {
            if (sql === 'BEGIN') {
              events.push(['db:BEGIN']);
              return { rows: [] };
            }
            if (sql.includes('from scenes where id = $1 and site_id = $2 for update')) {
              return { rows: [{ id: SCENE_OWNED }] };
            }
            if (sql.includes('from points where id = $1 and site_id = $2 and scene_id = $3')) {
              // Point deleted!
              return { rows: [] };
            }
            if (sql === 'ROLLBACK') {
              events.push(['db:ROLLBACK']);
              return { rows: [] };
            }
            return { rows: [] };
          },
          release() {
            clientReleased = true;
          },
        };
      },
    });

    await assert.rejects(
      async () => pointPhotosDb.addScenePointPhoto(SLUG, SCENE_OWNED, POINT_ID, SAMPLE_PHOTO, OWNER_ID),
      (err) => {
        assert.equal(err.code, 'point-not-found');
        return true;
      }
    );

    assert.ok(events.some(e => e[0] === 'db:ROLLBACK'));
    const removeEvent = events.find(e => e[0] === 'storage:remove');
    assert.ok(removeEvent, 'Storage removal must be triggered to prevent orphaned bytes');
    assert.equal(removeEvent[1].length, 2);
    assert.equal(clientReleased, true);
  } finally {
    pointPhotosDb._setStorageForTesting(null);
    supabaseDb.pool = origPool;
    supabaseDb.getSiteId = origGetSiteId;
  }
});

test('addScenePointPhoto: rolls back transaction and removes uploaded storage objects when photo count limit exceeded under lock', async () => {
  const origPool = supabaseDb.pool;
  const origGetSiteId = supabaseDb.getSiteId;

  const events = [];
  const fakeStorage = makeFakeStorage(events);
  let clientReleased = false;

  try {
    pointPhotosDb._setStorageForTesting(fakeStorage.storage);
    supabaseDb.getSiteId = async () => SITE_ID;
    supabaseDb.pool = () => ({
      async query(sql) {
        if (sql.includes('from points where id = $1')) return { rows: [{ id: POINT_ID }] };
        if (sql.includes('count(*)::int')) return { rows: [{ n: 0 }] };
        return { rows: [] };
      },
      async connect() {
        return {
          async query(sql) {
            if (sql === 'BEGIN') {
              events.push(['db:BEGIN']);
              return { rows: [] };
            }
            if (sql.includes('from scenes where id = $1 and site_id = $2 for update')) {
              return { rows: [{ id: SCENE_OWNED }] };
            }
            if (sql.includes('from points where id = $1 and site_id = $2 and scene_id = $3')) {
              return { rows: [{ id: POINT_ID }] };
            }
            if (sql.includes('count(*)::int')) {
              // Concurrently reached 6 photos!
              return { rows: [{ n: 6 }] };
            }
            if (sql === 'ROLLBACK') {
              events.push(['db:ROLLBACK']);
              return { rows: [] };
            }
            return { rows: [] };
          },
          release() {
            clientReleased = true;
          },
        };
      },
    });

    await assert.rejects(
      async () => pointPhotosDb.addScenePointPhoto(SLUG, SCENE_OWNED, POINT_ID, SAMPLE_PHOTO, OWNER_ID),
      (err) => {
        assert.equal(err.code, 'limit');
        return true;
      }
    );

    assert.ok(events.some(e => e[0] === 'db:ROLLBACK'));
    const removeEvent = events.find(e => e[0] === 'storage:remove');
    assert.ok(removeEvent, 'Storage removal must be triggered when limit is exceeded');
    assert.equal(removeEvent[1].length, 2);
    assert.equal(clientReleased, true);
  } finally {
    pointPhotosDb._setStorageForTesting(null);
    supabaseDb.pool = origPool;
    supabaseDb.getSiteId = origGetSiteId;
  }
});

test('addScenePointPhoto: rolls back transaction and removes uploaded storage objects when metadata insert query fails', async () => {
  const origPool = supabaseDb.pool;
  const origGetSiteId = supabaseDb.getSiteId;

  const events = [];
  const fakeStorage = makeFakeStorage(events);
  let clientReleased = false;

  try {
    pointPhotosDb._setStorageForTesting(fakeStorage.storage);
    supabaseDb.getSiteId = async () => SITE_ID;
    supabaseDb.pool = () => ({
      async query(sql) {
        if (sql.includes('from points where id = $1')) return { rows: [{ id: POINT_ID }] };
        if (sql.includes('count(*)::int')) return { rows: [{ n: 0 }] };
        return { rows: [] };
      },
      async connect() {
        return {
          async query(sql) {
            if (sql === 'BEGIN') {
              events.push(['db:BEGIN']);
              return { rows: [] };
            }
            if (sql.includes('from scenes where id = $1 and site_id = $2 for update')) {
              return { rows: [{ id: SCENE_OWNED }] };
            }
            if (sql.includes('from points where id = $1 and site_id = $2 and scene_id = $3')) {
              return { rows: [{ id: POINT_ID }] };
            }
            if (sql.includes('count(*)::int')) {
              return { rows: [{ n: 0 }] };
            }
            if (sql.includes('insert into point_photos')) {
              throw new Error('simulated DB connection drop on insert');
            }
            if (sql === 'ROLLBACK') {
              events.push(['db:ROLLBACK']);
              return { rows: [] };
            }
            return { rows: [] };
          },
          release() {
            clientReleased = true;
          },
        };
      },
    });

    await assert.rejects(
      async () => pointPhotosDb.addScenePointPhoto(SLUG, SCENE_OWNED, POINT_ID, SAMPLE_PHOTO, OWNER_ID),
      /simulated DB connection drop on insert/
    );

    assert.ok(events.some(e => e[0] === 'db:ROLLBACK'));
    const removeEvent = events.find(e => e[0] === 'storage:remove');
    assert.ok(removeEvent, 'Storage removal must be triggered on insert error');
    assert.equal(removeEvent[1].length, 2);
    assert.equal(clientReleased, true);
  } finally {
    pointPhotosDb._setStorageForTesting(null);
    supabaseDb.pool = origPool;
    supabaseDb.getSiteId = origGetSiteId;
  }
});

test('lock coordination symmetry: deleteScene and addScenePointPhoto lock the authoritative scene row using identical FOR UPDATE pattern', async () => {
  const fs = require('node:fs');
  const scenesDbCode = fs.readFileSync(new URL('../scenes-db.js', import.meta.url), 'utf8');
  const pointPhotosDbCode = fs.readFileSync(new URL('../point-photos-db.js', import.meta.url), 'utf8');

  // Both must select from scenes with for update
  assert.match(scenesDbCode, /select id, name from scenes where id = \$1 and site_id = \$2 for update/);
  assert.match(pointPhotosDbCode, /select id from scenes where id = \$1 and site_id = \$2 for update/);

  // deleteScene must execute BEGIN before locking
  const deleteSceneBody = scenesDbCode.slice(scenesDbCode.indexOf('async function deleteScene('));
  assert.ok(deleteSceneBody.indexOf("client.query('BEGIN')") < deleteSceneBody.indexOf('for update'));

  // addScenePointPhoto must execute BEGIN before locking
  const addScenePointPhotoBody = pointPhotosDbCode.slice(pointPhotosDbCode.indexOf('async function addScenePointPhoto('));
  assert.ok(addScenePointPhotoBody.indexOf("client.query('BEGIN')") < addScenePointPhotoBody.indexOf('for update'));

  // deleteScene must recheck point_photos while holding the lock
  assert.ok(deleteSceneBody.indexOf('for update') < deleteSceneBody.indexOf('from point_photos ph'));

  // deleteScene audit must be inserted in the transaction before final commit
  assert.ok(deleteSceneBody.indexOf('insert into audit_log') < deleteSceneBody.lastIndexOf("client.query('COMMIT')"));
});

test('server.js guards hazardDb.deletePhotosForScene on scene DELETE specifically for meta.kind === "hazard"', () => {
  const fs = require('node:fs');
  const serverCode = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

  // Verify deletePhotosForScene is guarded by meta.kind === 'hazard'
  const sceneItemSlice = serverCode.slice(serverCode.indexOf("const _sceneItemMatch ="));
  const handlerBody = sceneItemSlice.slice(0, sceneItemSlice.indexOf("_readJsonBody(req, async (err, body) =>"));

  assert.match(handlerBody, /if\s*\(\s*meta\.kind\s*===\s*['"]hazard['"]\s*\)\s*\{\s*await hazardDb\.deletePhotosForScene/);
  // Verify 409 handling is preserved
  assert.match(handlerBody, /if\s*\(await scenesDb\.sceneHasPointPhotos\(slug,\s*id\)\)\s*\{\s*return _json\(res,\s*409,\s*\{\s*error:\s*['"]SCENE_HAS_POINT_PHOTOS['"]\s*\}\);/);
  assert.match(handlerBody, /e\.status === 409 \|\| e\.code === 'SCENE_HAS_POINT_PHOTOS'/);
});
