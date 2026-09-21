import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createScenePointPhotoHandler } = require('../scene-point-photos-routes.js');
const { PointPhotoError } = require('../point-photos-db.js');

const SLUG = 'landcros';
const SCENE = '00000000-0000-4000-8000-000000000001';
const POINT = '00000000-0000-4000-8000-000000000002';
const PHOTO = '00000000-0000-4000-8000-000000000003';
const ACTOR = '00000000-0000-4000-8000-000000000009';

const COLL_URL = `/api/sites/${SLUG}/scenes/${SCENE}/points/${POINT}/photos`;
const ITEM_URL = `${COLL_URL}/${PHOTO}`;

function response() {
  return {
    writableEnded: false,
    headers: {},
    statusCode: null,
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(code, h = {}) { this.statusCode = code; Object.assign(this.headers, h); },
    end(v) { this.body = v; this.writableEnded = true; },
  };
}

function req(method, url = COLL_URL) {
  return { method, url };
}

function buildEnvelope(header, compressed, original) {
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(headerBuf.length);
  return Buffer.concat([lenBuf, headerBuf, compressed, original]);
}

function make(overrides = {}) {
  const calls = [];
  const db = {
    MAX_COMPRESSED_BYTES: 400 * 1024,
    MAX_ORIGINAL_BYTES: 15 * 1024 * 1024,
    IMAGE_TYPES: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']),
    async listScenePointPhotos(slug, scene, point) {
      calls.push(['list', slug, scene, point]);
      return [{ id: PHOTO, pointId: point }];
    },
    async addScenePointPhoto(slug, scene, point, meta, actor) {
      calls.push(['add', slug, scene, point, meta, actor]);
      return { id: PHOTO, pointId: point, contentType: meta.contentType };
    },
    async readScenePointPhoto(slug, scene, point, photo, opts) {
      calls.push(['read', slug, scene, point, photo, opts]);
      return {
        buffer: Buffer.from('jpeg-pixel-bytes'),
        contentType: 'image/jpeg',
        row: { id: photo, original_name: 'test.jpg' },
      };
    },
    async setScenePointPhotoRetention(slug, scene, point, photo, keep) {
      calls.push(['retention', slug, scene, point, photo, keep]);
      return { id: photo, expiresAt: keep ? null : '2026-10-21T00:00:00Z' };
    },
    async deleteScenePointPhoto(slug, scene, point, photo) {
      calls.push(['delete', slug, scene, point, photo]);
      return;
    },
    ...overrides.db,
  };

  const deps = {
    requireEditor(_req, _res, _slug, cb) {
      calls.push(['editor']);
      cb({ profileId: ACTOR });
    },
    async managedScene(_res, _slug, _scene, _session) {
      calls.push(['scene']);
      return { id: SCENE, createdBy: ACTOR };
    },
    readRawBody(_req, _limit, cb) {
      const header = { compressedBytes: 4, contentType: 'image/jpeg' };
      const envelope = buildEnvelope(header, Buffer.from('comp'), Buffer.from('orig'));
      cb(null, envelope);
    },
    readJson(_req, cb) {
      cb(null, { keep: true });
    },
    db,
    ...overrides,
  };

  return { handle: createScenePointPhotoHandler(deps), calls, db };
}

async function settle() {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

function jsonBody(res) {
  return JSON.parse(res.body);
}

test('syntax validation runs before any authorization or DB call', async () => {
  const badUrls = [
    ['/api/sites/BAD-SLUG!/scenes/' + SCENE + '/points/' + POINT + '/photos', 404, 'SITE_NOT_FOUND'],
    ['/api/sites/' + SLUG + '/scenes/not-a-uuid/points/' + POINT + '/photos', 400, 'INVALID_SCENE_ID'],
    ['/api/sites/' + SLUG + '/scenes/' + SCENE + '/points/not-a-uuid/photos', 400, 'INVALID_POINT_ID'],
    ['/api/sites/' + SLUG + '/scenes/' + SCENE + '/points/' + POINT + '/photos/not-a-uuid', 400, 'INVALID_PHOTO_ID'],
  ];

  for (const [url, expectedStatus, expectedError] of badUrls) {
    const { handle, calls } = make();
    const res = response();
    const handled = handle(req('GET', url), res, new URL('http://local' + url));
    assert.equal(handled, true);
    assert.equal(res.statusCode, expectedStatus);
    assert.equal(jsonBody(res).error, expectedError);
    assert.deepEqual(calls, [], `No auth or DB calls should happen for ${url}`);
  }
});

test('method validation enforces allowed methods for collection and item before auth/DAL', async () => {
  const { handle: handleColl, calls: callsColl } = make();
  const resColl = response();
  assert.equal(handleColl(req('DELETE', COLL_URL), resColl, new URL('http://local' + COLL_URL)), true);
  assert.equal(resColl.statusCode, 405);
  assert.equal(resColl.headers['Allow'], 'GET, POST');
  assert.equal(jsonBody(resColl).error, 'METHOD_NOT_ALLOWED');
  assert.deepEqual(callsColl, []);

  const { handle: handleItem, calls: callsItem } = make();
  const resItem = response();
  assert.equal(handleItem(req('POST', ITEM_URL), resItem, new URL('http://local' + ITEM_URL)), true);
  assert.equal(resItem.statusCode, 405);
  assert.equal(resItem.headers['Allow'], 'GET, HEAD, PATCH, DELETE');
  assert.equal(jsonBody(resItem).error, 'METHOD_NOT_ALLOWED');
  assert.deepEqual(callsItem, []);
});

test('unauthenticated or denied editor stops before managedScene or DAL', async () => {
  const { handle: unauthHandle, calls: unauthCalls } = make({
    requireEditor(_req, res) {
      unauthCalls.push(['editor-denied']);
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
    },
  });
  const unauthRes = response();
  unauthHandle(req('GET', COLL_URL), unauthRes, new URL('http://local' + COLL_URL));
  await settle();
  assert.deepEqual(unauthCalls, [['editor-denied']]);
  assert.equal(unauthRes.statusCode, 401);

  const { handle: editorForbidden, calls: editorForbiddenCalls } = make({
    requireEditor(_req, res) {
      editorForbiddenCalls.push(['editor-forbidden']);
      res.statusCode = 403;
      res.end(JSON.stringify({ error: 'FORBIDDEN' }));
    },
  });
  const editorRes = response();
  editorForbidden(req('GET', COLL_URL), editorRes, new URL('http://local' + COLL_URL));
  await settle();
  assert.deepEqual(editorForbiddenCalls, [['editor-forbidden']]);
  assert.equal(editorRes.statusCode, 403);
});

test('non-owner editor or subscriber fails managedScene and never touches DAL', async () => {
  const { handle, calls } = make({
    async managedScene(res) {
      calls.push(['managedScene-denied']);
      res.statusCode = 403;
      res.end(JSON.stringify({ error: 'forbidden' }));
      return null;
    },
  });
  const res = response();
  handle(req('GET', COLL_URL), res, new URL('http://local' + COLL_URL));
  await settle();
  assert.deepEqual(calls, [['editor'], ['managedScene-denied']]);
  assert.equal(res.statusCode, 403);
});

test('collection GET calls listScenePointPhotos with exact IDs and sets private, no-store', async () => {
  const { handle, calls } = make();
  const res = response();
  handle(req('GET', COLL_URL), res, new URL('http://local' + COLL_URL));
  await settle();

  assert.deepEqual(calls, [
    ['editor'],
    ['scene'],
    ['list', SLUG, SCENE, POINT],
  ]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(jsonBody(res), [{ id: PHOTO, pointId: POINT }]);
});

test('collection POST parses binary envelope and calls addScenePointPhoto with exact parameters', async () => {
  const compressed = Buffer.from('compressed-image-data');
  const original = Buffer.from('original-image-data');
  const header = {
    compressedBytes: compressed.length,
    contentType: 'image/webp',
    originalName: 'photo.webp',
    width: 800,
    height: 600,
    keepIndefinitely: true,
  };
  const envelope = buildEnvelope(header, compressed, original);

  const { handle, calls } = make({
    readRawBody(_req, _limit, cb) { cb(null, envelope); },
  });

  const res = response();
  handle(req('POST', COLL_URL), res, new URL('http://local' + COLL_URL));
  await settle();

  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], 'editor');
  assert.equal(calls[1][0], 'scene');
  const addCall = calls[2];
  assert.equal(addCall[0], 'add');
  assert.equal(addCall[1], SLUG);
  assert.equal(addCall[2], SCENE);
  assert.equal(addCall[3], POINT);
  assert.deepEqual(addCall[4].compressed, compressed);
  assert.deepEqual(addCall[4].original, original);
  assert.equal(addCall[4].contentType, 'image/webp');
  assert.equal(addCall[4].originalName, 'photo.webp');
  assert.equal(addCall[4].width, 800);
  assert.equal(addCall[4].height, 600);
  assert.equal(addCall[4].keepIndefinitely, true);
  assert.equal(addCall[5], ACTOR);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
});

test('collection POST rejects malformed binary envelope, header, sizes, and invalid MIME', async () => {
  const cases = [
    { buf: Buffer.from([1, 2]), status: 400, error: 'INVALID_UPLOAD_ENVELOPE' },
    {
      buf: (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(5000); // hlen > 4000
        return Buffer.concat([b, Buffer.alloc(10)]);
      })(),
      status: 400,
      error: 'INVALID_UPLOAD_HEADER',
    },
    {
      buf: (() => {
        const badJson = Buffer.from('{not-json', 'utf8');
        const b = Buffer.alloc(4);
        b.writeUInt32BE(badJson.length);
        return Buffer.concat([b, badJson, Buffer.from('abc')]);
      })(),
      status: 400,
      error: 'INVALID_UPLOAD_HEADER',
    },
    {
      buf: (() => {
        const h = { compressedBytes: 100, contentType: 'image/jpeg' };
        const hb = Buffer.from(JSON.stringify(h));
        const b = Buffer.alloc(4);
        b.writeUInt32BE(hb.length);
        return Buffer.concat([b, hb, Buffer.from('short')]); // cLen 100 exceeds buffer
      })(),
      status: 400,
      error: 'INVALID_UPLOAD_PAYLOAD',
    },
    {
      buf: (() => {
        // empty original
        const h = { compressedBytes: 4, contentType: 'image/jpeg' };
        const hb = Buffer.from(JSON.stringify(h));
        const b = Buffer.alloc(4);
        b.writeUInt32BE(hb.length);
        return Buffer.concat([b, hb, Buffer.from('comp')]);
      })(),
      status: 400,
      error: 'INVALID_UPLOAD_PAYLOAD',
    },
    {
      buf: (() => {
        // unsupported MIME
        const h = { compressedBytes: 4, contentType: 'image/gif' };
        return buildEnvelope(h, Buffer.from('comp'), Buffer.from('orig'));
      })(),
      status: 400,
      error: 'PHOTO_BAD_TYPE',
    },
  ];

  for (const c of cases) {
    const { handle, calls } = make({
      readRawBody(_req, _limit, cb) { cb(null, c.buf); },
    });
    const res = response();
    handle(req('POST', COLL_URL), res, new URL('http://local' + COLL_URL));
    await settle();
    assert.equal(res.statusCode, c.status, `Failed status for ${c.error}`);
    assert.equal(jsonBody(res).error, c.error, `Failed error for ${c.error}`);
    assert.equal(calls.some(call => call[0] === 'add'), false);
  }
});

test('item GET and HEAD serve authenticated bytes with private, no-store cache headers', async () => {
  const pixelBuffer = Buffer.from('image-jpeg-bytes-payload');
  const { handle, calls } = make({
    db: {
      async readScenePointPhoto(slug, scene, point, photo, opts) {
        calls.push(['read', slug, scene, point, photo, opts]);
        return {
          buffer: pixelBuffer,
          contentType: 'image/jpeg',
          row: { id: photo, original_name: 'inspect.jpg' },
        };
      },
    },
  });

  // GET item
  const getRes = response();
  handle(req('GET', ITEM_URL), getRes, new URL('http://local' + ITEM_URL));
  await settle();

  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.headers['Content-Type'], 'image/jpeg');
  assert.equal(getRes.headers['Content-Length'], pixelBuffer.length);
  assert.equal(getRes.headers['Cache-Control'], 'private, no-store');
  assert.equal(getRes.headers['Content-Disposition'], 'inline; filename="inspect.jpg"');
  assert.deepEqual(getRes.body, pixelBuffer);

  // HEAD item
  const headRes = response();
  handle(req('HEAD', ITEM_URL), headRes, new URL('http://local' + ITEM_URL));
  await settle();

  assert.equal(headRes.statusCode, 200);
  assert.equal(headRes.headers['Content-Type'], 'image/jpeg');
  assert.equal(headRes.headers['Content-Length'], pixelBuffer.length);
  assert.equal(headRes.headers['Cache-Control'], 'private, no-store');
  assert.equal(headRes.body, undefined, 'HEAD must have empty body');

  // GET with ?original=1
  const origRes = response();
  const origUrl = ITEM_URL + '?original=1';
  handle(req('GET', origUrl), origRes, new URL('http://local' + origUrl));
  await settle();

  const origCall = calls[calls.length - 1];
  assert.equal(origCall[0], 'read');
  assert.equal(origCall[5].original, true);
});

test('item GET returns 404 PHOTO_NOT_FOUND when photo is missing', async () => {
  const { handle } = make({
    db: { async readScenePointPhoto() { return null; } },
  });
  const res = response();
  handle(req('GET', ITEM_URL), res, new URL('http://local' + ITEM_URL));
  await settle();

  assert.equal(res.statusCode, 404);
  assert.equal(jsonBody(res).error, 'PHOTO_NOT_FOUND');
});

test('item PATCH updates retention and item DELETE deletes photo', async () => {
  const { handle, calls } = make({
    readJson(_req, cb) { cb(null, { keep: true }); },
  });

  // PATCH
  const patchRes = response();
  handle(req('PATCH', ITEM_URL), patchRes, new URL('http://local' + ITEM_URL));
  await settle();

  assert.deepEqual(calls.slice(-1)[0], ['retention', SLUG, SCENE, POINT, PHOTO, true]);
  assert.equal(patchRes.statusCode, 200);
  assert.equal(patchRes.headers['Cache-Control'], 'private, no-store');

  // DELETE
  const delRes = response();
  handle(req('DELETE', ITEM_URL), delRes, new URL('http://local' + ITEM_URL));
  await settle();

  assert.deepEqual(calls.slice(-1)[0], ['delete', SLUG, SCENE, POINT, PHOTO]);
  assert.equal(delRes.statusCode, 200);
  assert.deepEqual(jsonBody(delRes), { ok: true });
});

test('sanitizes PointPhotoError and masks internal DB/storage exceptions to 500 without leaking details', async () => {
  const errors = [
    [new PointPhotoError('point-not-found'), 404, 'POINT_NOT_FOUND'],
    [new PointPhotoError('not-found'), 404, 'PHOTO_NOT_FOUND'],
    [new PointPhotoError('limit'), 409, 'PHOTO_LIMIT'],
    [new PointPhotoError('too-large'), 413, 'PHOTO_TOO_LARGE'],
    [new PointPhotoError('bad-type'), 400, 'PHOTO_BAD_TYPE'],
    [new PointPhotoError('bad-request'), 400, 'PHOTO_BAD_REQUEST'],
    [new Error('storage download failed: sensitive s3 token leaked in exception'), 500, 'INTERNAL_SERVER_ERROR'],
  ];

  for (const [err, expectedStatus, expectedCode] of errors) {
    const { handle } = make({
      db: {
        async listScenePointPhotos() { throw err; },
      },
    });
    const res = response();
    handle(req('GET', COLL_URL), res, new URL('http://local' + COLL_URL));
    await settle();

    assert.equal(res.statusCode, expectedStatus);
    assert.equal(jsonBody(res).error, expectedCode);
    assert.doesNotMatch(res.body, /sensitive s3 token|leaked/i);
  }
});

test('hazard scenes refuse list, upload, read, patch, and delete with controlled non-leaky 400 and leave DAL untouched', async () => {
  const HAZARD_SCENE = '00000000-0000-4000-8000-000000000077';
  const collUrl = `/api/sites/${SLUG}/scenes/${HAZARD_SCENE}/points/${POINT}/photos`;
  const itemUrl = `${collUrl}/${PHOTO}`;

  let bodyReadCalled = false;
  const operations = [
    { method: 'GET', url: collUrl, desc: 'list photos' },
    { method: 'POST', url: collUrl, desc: 'upload photo' },
    { method: 'GET', url: itemUrl, desc: 'read photo' },
    { method: 'HEAD', url: itemUrl, desc: 'head photo' },
    { method: 'PATCH', url: itemUrl, desc: 'patch retention' },
    { method: 'DELETE', url: itemUrl, desc: 'delete photo' },
  ];

  for (const op of operations) {
    bodyReadCalled = false;
    const { handle, calls, db } = make({
      async managedScene(_res, _slug, sceneId, _session) {
        calls.push(['scene', sceneId]);
        return { id: sceneId, createdBy: ACTOR, kind: 'hazard' };
      },
      readRawBody(_req, _limit, cb) {
        bodyReadCalled = true;
        cb(null, Buffer.from('bytes'));
      },
      readJson(_req, cb) {
        bodyReadCalled = true;
        cb(null, { keep: true });
      },
    });

    const res = response();
    const handled = handle(req(op.method, op.url), res, new URL('http://local' + op.url));
    assert.equal(handled, true, `Handler should handle ${op.desc}`);
    await settle();

    // 1. Controlled non-leaky response
    assert.equal(res.statusCode, 400, `Expected 400 for hazard scene during ${op.desc}`);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    const body = jsonBody(res);
    assert.deepEqual(body, { error: 'INVALID_SCENE_KIND' }, `Expected INVALID_SCENE_KIND for ${op.desc}`);

    // 2. Authentication and managedScene were called, but NO DAL or body parsing occurred
    assert.deepEqual(calls, [['editor'], ['scene', HAZARD_SCENE]], `Only editor auth and managedScene should run for ${op.desc}`);
    assert.equal(bodyReadCalled, false, `Body parser must not run before scene kind validation for ${op.desc}`);
  }
});

test('admin scenes preserve existing owner, platform admin, and legacy semantics through scene-point-photo routes', async () => {
  const ADMIN_SCENE = '00000000-0000-4000-8000-000000000088';
  const collUrl = `/api/sites/${SLUG}/scenes/${ADMIN_SCENE}/points/${POINT}/photos`;

  // Explicit kind='admin'
  const { handle: handleAdmin, calls: callsAdmin } = make({
    async managedScene(_res, _slug, sceneId) {
      callsAdmin.push(['scene', sceneId]);
      return { id: sceneId, createdBy: ACTOR, kind: 'admin' };
    },
  });
  const resAdmin = response();
  handleAdmin(req('GET', collUrl), resAdmin, new URL('http://local' + collUrl));
  await settle();
  assert.equal(resAdmin.statusCode, 200);
  assert.deepEqual(callsAdmin, [['editor'], ['scene', ADMIN_SCENE], ['list', SLUG, ADMIN_SCENE, POINT]]);

  // Legacy scene with undefined kind defaults to admin
  const { handle: handleLegacy, calls: callsLegacy } = make({
    async managedScene(_res, _slug, sceneId) {
      callsLegacy.push(['scene', sceneId]);
      return { id: sceneId, createdBy: null }; // legacy ownerless, no kind field
    },
  });
  const resLegacy = response();
  handleLegacy(req('GET', collUrl), resLegacy, new URL('http://local' + collUrl));
  await settle();
  assert.equal(resLegacy.statusCode, 200);
  assert.deepEqual(callsLegacy, [['editor'], ['scene', ADMIN_SCENE], ['list', SLUG, ADMIN_SCENE, POINT]]);
});
