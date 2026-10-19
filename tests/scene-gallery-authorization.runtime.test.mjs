import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const SCENE_ID = '72498bef-b15b-4d2f-afd1-10c4e99d850a';
const OBJECT_ID = 'e8f1ac0e-36ab-4052-aec6-29050802eead';
const SITE_ID = '6457d082-8a4d-4f64-8397-ad978b0eb7f7';

function loadSceneMeta({ rows = [{ id: SCENE_ID, created_by: 'author' }] } = {}) {
  const queries = [];
  const mod = { exports: {} };
  runInNewContext(source('scenes-db.js'), {
    module: mod,
    exports: mod.exports,
    require: id => {
      if (id === 'crypto') return { randomBytes: () => Buffer.alloc(10) };
      if (id === './scene-db') return { sceneObjectToJson: x => x };
      if (id === './supabase-db') return {
        pool: () => ({ query: async (sql, params) => {
          queries.push({ sql, params });
          return { rows };
        } }),
        getSiteId: async slug => {
          assert.equal(slug, 'landcros');
          return SITE_ID;
        },
      };
      throw new Error('Unexpected dependency ' + id);
    },
  }, { filename: 'scenes-db.js' });
  return { lookup: mod.exports.getSceneMeta, queries };
}

function loadGalleryAuthorization({ object = { sceneId: SCENE_ID },
  owner = 'author', sceneExists = true } = {}) {
  const text = source('server.js');
  const begin = text.indexOf('async function _managedSceneOrRespond(');
  const end = text.indexOf('// Phase 3: admin+ role', begin);
  assert.ok(begin >= 0 && end > begin, 'authorization helper exists');
  const calls = { objects: [], scenes: [] };
  const sandbox = {
    sceneDb: { getSceneObjectMeta: async (slug, id) => {
      calls.objects.push([slug, id]);
      return object;
    } },
    scenesDb: { getSceneMeta: async (slug, id) => {
      calls.scenes.push([slug, id]);
      return sceneExists ? { id, createdBy: owner } : null;
    } },
    auth: { isPlatformAdmin: () => false },
    canManageScene: (scene, session) => scene.createdBy === session.profileId,
    _json: (res, status, body) => res.responses.push({ status, error: body.error }),
  };
  runInNewContext(text.slice(begin, end) +
    '\nthis.resolveGallery = _managedGallerySceneOrRespond;', sandbox);
  const response = () => ({ responses: [] });
  return { lookup: sandbox.resolveGallery, calls, response };
}

test('real scene metadata lookup accepts canonical UUIDs and scopes by site', async () => {
  const { lookup, queries } = loadSceneMeta();
  const result = await lookup('landcros', SCENE_ID);
  assert.equal(result.id, SCENE_ID);
  assert.equal(result.createdBy, 'author');
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /where id = \$1 and site_id = \$2/);
  assert.deepEqual(Array.from(queries[0].params), [SCENE_ID, SITE_ID]);
});

test('scene metadata rejects malformed IDs and absent site-scoped records', async () => {
  const found = loadSceneMeta();
  assert.equal(await found.lookup('landcros', 'invalid'), null);
  assert.equal(await found.lookup('landcros', SCENE_ID.slice(0, -5)), null);
  assert.equal(found.queries.length, 0);
  const absent = loadSceneMeta({ rows: [] });
  assert.equal(await absent.lookup('landcros', SCENE_ID), null);
  assert.equal(absent.queries.length, 1);
});

test('gallery uses stored scene ID when client omits it, or supplies matching ID', async () => {
  const { lookup, calls, response } = loadGalleryAuthorization();
  const session = { profileId: 'author', email: 'editor@example.test' };
  for (const supplied of [undefined, SCENE_ID]) {
    const res = response();
    assert.equal(await lookup(res, 'landcros', OBJECT_ID, supplied, session), SCENE_ID);
    assert.equal(res.responses.length, 0);
  }
  assert.equal(calls.objects.length, 2);
  assert.equal(calls.scenes.length, 2);
  assert.deepEqual(Array.from(calls.scenes[0]), ['landcros', SCENE_ID]);
});

test('gallery denies wrong owner before reporting stale scene; rejects missing pins', async () => {
  const owner = { profileId: 'author', email: 'owner@example.test' };
  const stranger = { profileId: 'stranger', email: 'other@example.test' };
  const handler = loadGalleryAuthorization();
  const stale = handler.response();
  assert.equal(await handler.lookup(stale, 'landcros', OBJECT_ID,
    '11111111-2222-3333-4444-555555555555', owner), null);
  assert.equal(stale.responses[0].status, 409);
  const denied = handler.response();
  assert.equal(await handler.lookup(denied, 'landcros', OBJECT_ID,
    '11111111-2222-3333-4444-555555555555', stranger), null);
  assert.equal(denied.responses[0].status, 403);
  const missing = loadGalleryAuthorization({ object: null });
  const missingRes = missing.response();
  assert.equal(await missing.lookup(missingRes, 'landcros', OBJECT_ID,
    undefined, owner), null);
  assert.equal(missingRes.responses[0].status, 404);
  assert.equal(missing.calls.scenes.length, 0);
  const missingScene = loadGalleryAuthorization({ sceneExists: false });
  const missingSceneRes = missingScene.response();
  assert.equal(await missingScene.lookup(missingSceneRes, 'landcros', OBJECT_ID,
    undefined, owner), null);
  assert.equal(missingSceneRes.responses[0].status, 404);
});
