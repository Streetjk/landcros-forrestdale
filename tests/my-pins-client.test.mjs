import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientCode = await fs.readFile(path.resolve(__dirname, '../my-pins-client.js'), 'utf-8');
const dataUrl = `data:text/javascript;base64,${Buffer.from(clientCode).toString('base64')}`;
const client = await import(dataUrl);

const {
  MY_PINS_PURPOSE,
  MyPinsError,
  isMyPinsScene,
  listMyPinsScenes,
  ensureMyPinsScene,
  listAccountPins,
  saveAccountPin,
  deleteAccountPin,
  readLegacyLocalPins,
  buildLegacyImportPlan,
  listAccountPinPhotos,
  uploadAccountPinPhoto,
  setAccountPinPhotoRetention,
  deleteAccountPinPhoto,
  getAccountPinPhotoUrl
} = client;

function createMockFetch(responses = []) {
  const calls = [];
  let index = 0;
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    const resConfig = responses[index++] || { status: 200, ok: true, json: async () => ({}) };
    if (resConfig.networkError) {
      throw new Error('Network failure');
    }
    return {
      status: resConfig.status ?? 200,
      ok: resConfig.ok ?? (resConfig.status >= 200 && resConfig.status < 300),
      json: async () => {
        if (resConfig.jsonError) throw new Error('Bad JSON');
        return resConfig.data;
      }
    };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

test('isMyPinsScene validation', () => {
  assert.equal(isMyPinsScene(null), false);
  assert.equal(isMyPinsScene({ isMine: false, camera: { purpose: MY_PINS_PURPOSE } }), false);
  assert.equal(isMyPinsScene({ isMine: true, camera: { purpose: 'other' } }), false);
  assert.equal(isMyPinsScene({ isMine: true, camera: { purpose: MY_PINS_PURPOSE } }), true);
  assert.equal(isMyPinsScene({ isMine: true, camera: JSON.stringify({ purpose: MY_PINS_PURPOSE }) }), true);
});

test('ensureMyPinsScene: finds existing scene, sorts oldest first, does not POST, returns duplicates count', async () => {
  const scenes = [
    { id: 's2', isMine: true, createdAt: '2026-01-02T00:00:00Z', camera: { purpose: MY_PINS_PURPOSE } },
    { id: 's1', isMine: true, createdAt: '2026-01-01T00:00:00Z', camera: { purpose: MY_PINS_PURPOSE } },
    { id: 's-other', isMine: true, createdAt: '2025-01-01T00:00:00Z', camera: { purpose: 'general' } },
    { id: 's-notmine', isMine: false, createdAt: '2024-01-01T00:00:00Z', camera: { purpose: MY_PINS_PURPOSE } }
  ];

  const mockFetch = createMockFetch([
    { status: 200, ok: true, data: scenes }
  ]);

  const res = await ensureMyPinsScene('site/alpha 1', { fetchFn: mockFetch });
  assert.equal(mockFetch.calls.length, 1);
  assert.equal(mockFetch.calls[0].url, '/api/sites/site%2Falpha%201/scenes?kind=admin');
  assert.equal(mockFetch.calls[0].options.credentials, 'same-origin');
  assert.equal(res.created, false);
  assert.equal(res.scene.id, 's1');
  assert.equal(res.duplicates, 1);
});

test('ensureMyPinsScene: creates scene when none exists with camera purpose tag', async () => {
  const mockFetch = createMockFetch([
    { status: 200, ok: true, data: [] },
    {
      status: 201,
      ok: true,
      data: {
        id: 'new-scene',
        shareCode: 'sh123',
        isMine: true,
        camera: { purpose: MY_PINS_PURPOSE, foo: 'bar' }
      }
    }
  ]);

  const res = await ensureMyPinsScene('test-site', { fetchFn: mockFetch });
  assert.equal(mockFetch.calls.length, 2);
  assert.equal(mockFetch.calls[1].url, '/api/sites/test-site/scenes');
  assert.equal(mockFetch.calls[1].options.method, 'POST');
  assert.equal(mockFetch.calls[1].options.credentials, 'same-origin');
  assert.equal(mockFetch.calls[1].options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(mockFetch.calls[1].options.body);
  assert.deepEqual(body, {
    name: 'My pins',
    kind: 'admin',
    camera: { purpose: MY_PINS_PURPOSE }
  });

  assert.equal(res.created, true);
  assert.equal(res.duplicates, 0);
  assert.equal(res.scene.id, 'new-scene');
});

test('ensureMyPinsScene accepts immediate create response with isMine null and storage read failures are safe', async () => {
  const mockFetch = createMockFetch([
    { status: 200, ok: true, data: [] },
    { status: 200, ok: true, data: { id: 'new-scene', shareCode: 'abc', isMine: null, camera: { purpose: MY_PINS_PURPOSE } } }
  ]);
  const result = await ensureMyPinsScene('test-site', { fetchFn: mockFetch });
  assert.equal(result.created, true);
  assert.equal(result.scene.id, 'new-scene');
  assert.deepEqual(readLegacyLocalPins({ getItem() { throw new Error('blocked storage'); } }), []);
  await assert.rejects(() => saveAccountPin('a', 'b', [], { fetchFn: mockFetch }), e => e instanceof MyPinsError && e.code === 'INVALID_INPUT');
});

test('Account pin CRUD operations encode slug/sceneId/pointId and set credentials same-origin', async () => {
  const mockFetch = createMockFetch([
    { status: 200, ok: true, data: [{ id: 'p1' }] },
    { status: 200, ok: true, data: { id: 'p2', label: 'Saved' } },
    { status: 200, ok: true, data: { ok: true } }
  ]);

  const list = await listAccountPins('site/a', 'sc/1', { fetchFn: mockFetch });
  assert.equal(mockFetch.calls[0].url, '/api/sites/site%2Fa/scenes/sc%2F1/points');
  assert.equal(mockFetch.calls[0].options.credentials, 'same-origin');
  assert.deepEqual(list, [{ id: 'p1' }]);

  const saved = await saveAccountPin('site/a', 'sc/1', { label: 'New pin' }, { fetchFn: mockFetch });
  assert.equal(mockFetch.calls[1].url, '/api/sites/site%2Fa/scenes/sc%2F1/points');
  assert.equal(mockFetch.calls[1].options.credentials, 'same-origin');
  assert.equal(mockFetch.calls[1].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(mockFetch.calls[1].options.body), { label: 'New pin' });
  assert.equal(saved.id, 'p2');

  const del = await deleteAccountPin('site/a', 'sc/1', 'pt/9', { fetchFn: mockFetch });
  assert.equal(mockFetch.calls[2].url, '/api/sites/site%2Fa/scenes/sc%2F1/points/pt%2F9');
  assert.equal(mockFetch.calls[2].options.method, 'DELETE');
  assert.equal(mockFetch.calls[2].options.credentials, 'same-origin');
  assert.deepEqual(del, { ok: true });
});

test('Error handling: stable codes without leaking body/URL for 401, 403, 409, malformed, network', async () => {
  const statuses = [
    { status: 401, expectedCode: 'UNAUTHORIZED' },
    { status: 403, expectedCode: 'FORBIDDEN' },
    { status: 404, expectedCode: 'NOT_FOUND' },
    { status: 409, expectedCode: 'CONFLICT' },
    { status: 500, expectedCode: 'HTTP_ERROR' }
  ];

  for (const { status, expectedCode } of statuses) {
    const mock = createMockFetch([{ status, ok: false, data: { secretLeak: 'staff-secret' } }]);
    await assert.rejects(
      async () => await listMyPinsScenes('slug', { fetchFn: mock }),
      (err) => {
        assert(err instanceof MyPinsError);
        assert.equal(err.status, status);
        assert.equal(err.code, expectedCode);
        assert(!err.message.includes('staff-secret'));
        assert(!err.message.includes('slug'));
        return true;
      }
    );
  }

  const netMock = createMockFetch([{ networkError: true }]);
  await assert.rejects(
    async () => await listMyPinsScenes('slug', { fetchFn: netMock }),
    (err) => {
      assert(err instanceof MyPinsError);
      assert.equal(err.status, 0);
      assert.equal(err.code, 'NETWORK_ERROR');
      return true;
    }
  );

  const malformedMock = createMockFetch([{ status: 200, ok: true, jsonError: true }]);
  await assert.rejects(
    async () => await listMyPinsScenes('slug', { fetchFn: malformedMock }),
    (err) => {
      assert(err instanceof MyPinsError);
      assert.equal(err.status, 200);
      assert.equal(err.code, 'MALFORMED_RESPONSE');
      return true;
    }
  );
});

test('readLegacyLocalPins safely parses, filters non-finite/malformed, caps at 100, forces scope=personal', () => {
  const validUuid = '12345678-1234-1234-1234-123456789abc';
  const rawPins = [
    {
      id: validUuid,
      label: 'Valid Pin',
      scope: 'public',
      latlng: [12.34, 56.78],
      position3d: { x: 1, y: 2, z: 3 },
      notes: 'note',
      extraTrash: 'ignore-me'
    },
    { id: 'not-a-uuid', label: 'Bad UUID', latlng: [0, 0], position3d: { x: 0, y: 0, z: 0 } },
    { id: validUuid, label: '', latlng: [0, 0], position3d: { x: 0, y: 0, z: 0 } },
    { id: validUuid, label: 'Bad latlng', latlng: [NaN, 1], position3d: { x: 0, y: 0, z: 0 } },
    { id: validUuid, label: 'Bad pos3d', latlng: [1, 2], position3d: { x: 0, y: Infinity, z: 0 } },
    'not-even-an-object'
  ];

  for (let i = 0; i < 150; i++) {
    rawPins.push({
      id: validUuid,
      label: `Bulk ${i}`,
      latlng: [10, 20],
      position3d: { x: i, y: 0, z: 0 }
    });
  }

  const storage = {
    getItem(key) {
      if (key === 'sn_user_pins') return JSON.stringify(rawPins);
      return null;
    }
  };

  const pins = readLegacyLocalPins(storage);
  assert.equal(pins.length, 100);
  assert.equal(pins[0].label, 'Valid Pin');
  assert.equal(pins[0].scope, 'personal');
  assert.equal(pins[0].extraTrash, undefined);
  assert.deepEqual(pins[0].latlng, [12.34, 56.78]);
  assert.deepEqual(pins[0].position3d, { x: 1, y: 2, z: 3 });
});

test('buildLegacyImportPlan returns confirmation plan and never mutates/removes storage', () => {
  let mutated = false;
  const validUuid = '12345678-1234-1234-1234-123456789abc';
  const storage = {
    getItem(key) {
      if (key === 'sn_user_pins') {
        return JSON.stringify([
          { id: validUuid, label: 'Pin 1', latlng: [1, 2], position3d: { x: 0, y: 0, z: 0 } }
        ]);
      }
      return null;
    },
    setItem() { mutated = true; },
    removeItem() { mutated = true; },
    clear() { mutated = true; }
  };

  const plan = buildLegacyImportPlan(storage);
  assert.equal(plan.count, 1);
  assert.equal(plan.requiresConfirmation, true);
  assert.equal(plan.sourceKey, 'sn_user_pins');
  assert.equal(plan.pins.length, 1);
  assert.equal(mutated, false);
});

test('create-only saves send If-None-Match without changing ordinary updates', async () => {
  const mock=createMockFetch([{status:200,ok:true,data:{id:'fixture'}},{status:200,ok:true,data:{id:'fixture'}}]);
  await saveAccountPin('alpha','scene',{id:'fixture'},{fetchFn:mock,createOnly:true});
  await saveAccountPin('alpha','scene',{id:'fixture'},{fetchFn:mock});
  assert.equal(mock.calls[0].options.headers['If-None-Match'],'*');
  assert.equal(mock.calls[1].options.headers['If-None-Match'],undefined);
});

test('Account pin photo operations encode slug/sceneId/pointId/photoId and set credentials same-origin', async () => {
  const photoFixture = { id: 'ph-1', pointId: 'pt-1', bytes: 1234, contentType: 'image/jpeg' };
  const mock = createMockFetch([
    { status: 200, ok: true, data: [photoFixture] },
    { status: 200, ok: true, data: photoFixture },
    { status: 200, ok: true, data: { ...photoFixture, expiresAt: null } },
    { status: 200, ok: true, data: { ok: true } }
  ]);

  // 1. List photos
  const list = await listAccountPinPhotos('site/alpha', 'sc/1', 'pt/1', { fetchFn: mock });
  assert.equal(mock.calls[0].url, '/api/sites/site%2Falpha/scenes/sc%2F1/points/pt%2F1/photos');
  assert.equal(mock.calls[0].options.method, 'GET');
  assert.equal(mock.calls[0].options.credentials, 'same-origin');
  assert.deepEqual(list, [photoFixture]);

  // 2. Upload photo
  const fakeBinary = new Uint8Array([0, 0, 0, 10, 1, 2, 3, 4]);
  const uploaded = await uploadAccountPinPhoto('site/alpha', 'sc/1', 'pt/1', fakeBinary, { fetchFn: mock });
  assert.equal(mock.calls[1].url, '/api/sites/site%2Falpha/scenes/sc%2F1/points/pt%2F1/photos');
  assert.equal(mock.calls[1].options.method, 'POST');
  assert.equal(mock.calls[1].options.credentials, 'same-origin');
  assert.equal(mock.calls[1].options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(mock.calls[1].options.body, fakeBinary);
  assert.deepEqual(uploaded, photoFixture);

  // 3. Set retention
  const patched = await setAccountPinPhotoRetention('site/alpha', 'sc/1', 'pt/1', 'ph/1', true, { fetchFn: mock });
  assert.equal(mock.calls[2].url, '/api/sites/site%2Falpha/scenes/sc%2F1/points/pt%2F1/photos/ph%2F1');
  assert.equal(mock.calls[2].options.method, 'PATCH');
  assert.equal(mock.calls[2].options.credentials, 'same-origin');
  assert.equal(mock.calls[2].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(mock.calls[2].options.body), { keepIndefinitely: true });
  assert.equal(patched.expiresAt, null);

  // 4. Delete photo
  const deleted = await deleteAccountPinPhoto('site/alpha', 'sc/1', 'pt/1', 'ph/1', { fetchFn: mock });
  assert.equal(mock.calls[3].url, '/api/sites/site%2Falpha/scenes/sc%2F1/points/pt%2F1/photos/ph%2F1');
  assert.equal(mock.calls[3].options.method, 'DELETE');
  assert.equal(mock.calls[3].options.credentials, 'same-origin');
  assert.deepEqual(deleted, { ok: true });

  // 5. URL helper (pure function)
  const thumbUrl = getAccountPinPhotoUrl('site/alpha', 'sc/1', 'pt/1', 'ph/1');
  assert.equal(thumbUrl, '/api/sites/site%2Falpha/scenes/sc%2F1/points/pt%2F1/photos/ph%2F1');
  assert(!thumbUrl.includes('/api/point-photos/'));

  const origUrl = getAccountPinPhotoUrl('site/alpha', 'sc/1', 'pt/1', 'ph/1', { original: true });
  assert.equal(origUrl, '/api/sites/site%2Falpha/scenes/sc%2F1/points/pt%2F1/photos/ph%2F1?original=1');
  assert(!origUrl.includes('/api/point-photos/'));
});

test('Account pin photo operations input validation and specialized photo error mapping', async () => {
  // Input validation
  await assert.rejects(() => listAccountPinPhotos('', 'sc', 'pt'), e => e.code === 'INVALID_INPUT');
  await assert.rejects(() => listAccountPinPhotos('slug', '', 'pt'), e => e.code === 'INVALID_INPUT');
  await assert.rejects(() => listAccountPinPhotos('slug', 'sc', ''), e => e.code === 'INVALID_INPUT');
  await assert.rejects(() => uploadAccountPinPhoto('slug', 'sc', 'pt', null), e => e.code === 'INVALID_INPUT');
  await assert.rejects(() => setAccountPinPhotoRetention('slug', 'sc', 'pt', ''), e => e.code === 'INVALID_INPUT');
  await assert.rejects(() => deleteAccountPinPhoto('slug', 'sc', 'pt', ''), e => e.code === 'INVALID_INPUT');
  assert.throws(() => getAccountPinPhotoUrl('', 'sc', 'pt', 'ph'), e => e.code === 'INVALID_INPUT');

  // PHOTO_LIMIT (409)
  const limitMock = createMockFetch([{ status: 409, ok: false, data: { error: 'PHOTO_LIMIT' } }]);
  await assert.rejects(
    () => uploadAccountPinPhoto('slug', 'sc', 'pt', new Uint8Array([1]), { fetchFn: limitMock }),
    e => e instanceof MyPinsError && e.status === 409 && e.code === 'PHOTO_LIMIT'
  );

  // PHOTO_TOO_LARGE (413)
  const largeMock = createMockFetch([{ status: 413, ok: false, data: { error: 'PHOTO_TOO_LARGE' } }]);
  await assert.rejects(
    () => uploadAccountPinPhoto('slug', 'sc', 'pt', new Uint8Array([1]), { fetchFn: largeMock }),
    e => e instanceof MyPinsError && e.status === 413 && e.code === 'PHOTO_TOO_LARGE'
  );

  // PHOTO_BAD_TYPE (400)
  const badTypeMock = createMockFetch([{ status: 400, ok: false, data: { error: 'PHOTO_BAD_TYPE' } }]);
  await assert.rejects(
    () => uploadAccountPinPhoto('slug', 'sc', 'pt', new Uint8Array([1]), { fetchFn: badTypeMock }),
    e => e instanceof MyPinsError && e.status === 400 && e.code === 'PHOTO_BAD_TYPE'
  );
});
