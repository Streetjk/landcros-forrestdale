import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createScenePointHandler } = require('../scene-points-routes.js');
const { PointError } = require('../scene-points-db.js');

const SCENE = '00000000-0000-4000-8000-000000000001';
const POINT = '00000000-0000-4000-8000-000000000002';
const BASE = `/api/sites/landcros/scenes/${SCENE}/points`;

function response() {
  return {
    writableEnded: false, headers: {}, statusCode: null, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(v) { this.body = v; this.writableEnded = true; },
  };
}
function req(method, url = BASE) { return { method, url }; }
function make(overrides = {}) {
  const calls = [];
  const db = {
    async getScenePoints(slug, scene) { calls.push(['list', slug, scene]); return [{ id: POINT }]; },
    async saveScenePoint(slug, scene, body, actor) { calls.push(['save', slug, scene, body, actor]); return { id: body.id, sceneId: scene }; },
    async deleteScenePoint(slug, scene, id, actor) { calls.push(['delete', slug, scene, id, actor]); },
  };
  const deps = {
    requireEditor(_req, _res, _slug, cb) { calls.push(['editor']); cb({ profileId: '00000000-0000-4000-8000-000000000009' }); },
    async managedScene(_res, _slug, _scene, _session) { calls.push(['scene']); return { id: SCENE }; },
    readJson(_req, cb) { cb(null, { id: POINT, label: 'Synthetic pin', position3d: { x: 0, y: 0, z: 0 } }); },
    db,
    ...overrides,
  };
  return { handle: createScenePointHandler(deps), calls, db };
}
async function settle() { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); }
function jsonBody(res) { return JSON.parse(res.body); }

test('scene list authorizes before DB and returns only handler DB result', async () => {
  const { handle, calls } = make(); const res = response();
  assert.equal(handle(req('GET'), res, new URL('http://local' + BASE)), true);
  await settle();
  assert.deepEqual(calls.slice(0, 3).map(x => x[0]), ['editor', 'scene', 'list']);
  assert.equal(res.statusCode, 200); assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('failed editor authorization never resolves scene or point data', async () => {
  const { handle, calls } = make({ requireEditor(_req, res) { calls.push(['editor-denied']); res.statusCode = 403; res.end('{}'); } });
  const res = response(); handle(req('GET'), res, new URL('http://local' + BASE)); await settle();
  assert.deepEqual(calls, [['editor-denied']]); assert.equal(res.statusCode, 403);
});

test('failed scene ownership never reaches point DB', async () => {
  const { handle, calls } = make({ async managedScene(res) { calls.push(['scene-denied']); res.statusCode = 403; res.end('{}'); return null; } });
  const res = response(); handle(req('GET'), res, new URL('http://local' + BASE)); await settle();
  assert.deepEqual(calls.map(x => x[0]), ['editor', 'scene-denied']);
});

test('POST derives actor from authenticated session and passes body without owner trust', async () => {
  const { handle, calls } = make({ readJson(_req, cb) { cb(null, { id: POINT, label: 'Synthetic', createdBy: 'attacker', sceneId: SCENE, position3d: { x: 1, y: 2, z: 3 } }); } });
  const res = response(); handle(req('POST'), res, new URL('http://local' + BASE)); await settle();
  const save = calls.find(x => x[0] === 'save');
  assert.equal(save[4], '00000000-0000-4000-8000-000000000009'); assert.equal(res.statusCode, 200);
});

test('DELETE authorizes scene before delete without invoking storage cleanup', async () => {
  const { handle, calls } = make(); const url = `${BASE}/${POINT}`; const res = response();
  handle(req('DELETE', url), res, new URL('http://local' + url)); await settle();
  assert.deepEqual(calls.map(x => x[0]), ['editor', 'scene', 'delete']);
  assert.equal(res.statusCode, 200);
});

test('malformed route UUID returns 400 before authorization or DB', async () => {
  const { handle, calls } = make(); const bad = '/api/sites/landcros/scenes/not-a-uuid/points'; const res = response();
  handle(req('GET', bad), res, new URL('http://local' + bad)); await settle();
  assert.equal(res.statusCode, 400); assert.equal(jsonBody(res).error, 'INVALID_SCENE_ID'); assert.deepEqual(calls, []);
});

test('known PointError is sanitized to status/code and generic errors become 500', async () => {
  for (const [error, status, code] of [[new PointError(409, 'POINT_CONFLICT'), 409, 'POINT_CONFLICT'], [new Error('secret database detail'), 500, 'INTERNAL_SERVER_ERROR']]) {
    const { handle } = make({ db: { async getScenePoints() { throw error; }, async saveScenePoint() {}, async deleteScenePoint() {} } });
    const res = response(); handle(req('GET'), res, new URL('http://local' + BASE)); await settle();
    assert.equal(res.statusCode, status); assert.equal(jsonBody(res).error, code); assert.doesNotMatch(res.body, /secret database detail/);
  }
});

test('malformed JSON and null/array bodies give a real 400 without invalid status errors', async () => {
  for (const [err,body] of [[new Error('parse detail'),null],[null,null],[null,[]]]) {
    const { handle,calls }=make({readJson(_req,cb){cb(err,body);}});const res=response();
    handle(req('POST'),res,new URL('http://local'+BASE));await settle();
    assert.equal(res.statusCode,400);assert.equal(jsonBody(res).error,'INVALID_JSON_BODY');
    assert.equal(calls.some(call=>call[0]==='save'),false);
  }
});
test('rejected authorization promise and synchronous read failures terminate safely', async () => {
  for(const overrides of [{async managedScene(){throw new Error('internal lookup');}}, {readJson(){throw new Error('read failed');}}]) {
    const {handle}=make(overrides);const res=response();handle(req('POST'),res,new URL('http://local'+BASE));await settle();
    assert.equal(res.writableEnded,true);assert.ok([400,500].includes(res.statusCode));assert.doesNotMatch(res.body,/internal lookup|read failed/);
  }
});
