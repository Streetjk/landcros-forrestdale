import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.resolve(__dirname, '../my-pins-client.js');
const sessionPath = path.resolve(__dirname, '../my-pins-session.js');

const clientSource = fs.readFileSync(clientPath, 'utf8');
const clientDataUrl = `data:text/javascript;base64,${Buffer.from(clientSource).toString('base64')}`;

let sessionSource = fs.readFileSync(sessionPath, 'utf8');
sessionSource = sessionSource.replace("'./my-pins-client.js'", `'${clientDataUrl}'`);
sessionSource = sessionSource.replace('"./my-pins-client.js"', `'${clientDataUrl}'`);
const sessionDataUrl = `data:text/javascript;base64,${Buffer.from(sessionSource).toString('base64')}`;

const { createMyPinsSession } = await import(sessionDataUrl);
const { MyPinsError } = await import(clientDataUrl);

const TEST_EMAIL = 'testemail@example.test';
const PIN_ID_1 = 'a0000000-0000-4000-8000-000000000001';
const PIN_ID_2 = 'b0000000-0000-4000-8000-000000000002';
const PIN_ID_3 = 'c0000000-0000-4000-8000-000000000003';

function makeAuthFetch(email = TEST_EMAIL) {
  return async (url) => {
    if (url === '/api/auth/me') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ email })
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('1. load existing read-only: loads oldest scene and pins without POST ensure', async () => {
  const oldestScene = { id: 'scene-1', createdAt: '2025-01-01T00:00:00Z', isMine: true, camera: { purpose: 'my-pins-v1' } };
  const newerScene = { id: 'scene-2', createdAt: '2025-02-01T00:00:00Z', isMine: true, camera: { purpose: 'my-pins-v1' } };
  let ensureCalled = false;

  const api = {
    listMyPinsScenes: async () => [oldestScene, newerScene],
    ensureMyPinsScene: async () => { ensureCalled = true; throw new Error('ensure should not be called'); },
    listAccountPins: async (_slug, sceneId) => [{
      id: PIN_ID_1,
      sceneId,
      label: 'Staff Room',
      scope: 'personal'
    }]
  };

  const session = createMyPinsSession('test-site', {
    identity: TEST_EMAIL,
    fetchFn: makeAuthFetch(),
    api
  });

  const state = await session.load();
  assert.equal(state.loaded, true);
  assert.equal(state.scene.id, 'scene-1');
  assert.equal(state.duplicates, 1);
  assert.equal(state.pins.length, 1);
  assert.equal(state.pins[0].id, PIN_ID_1);
  assert.equal(ensureCalled, false);
});

test('2. new scene no POST until explicit save', async () => {
  let ensureCalled = false;
  let saveCalled = false;
  const serverPins = [];

  const api = {
    listMyPinsScenes: async () => [],
    ensureMyPinsScene: async () => {
      ensureCalled = true;
      return { scene: { id: 'created-scene-1', isMine: true, camera: { purpose: 'my-pins-v1' } }, created: true, duplicates: 0 };
    },
    listAccountPins: async () => structuredClone(serverPins),
    saveAccountPin: async (_slug, sceneId, point) => {
      saveCalled = true;
      const saved = { ...point, id: point.id || PIN_ID_1, sceneId };
      serverPins.push(saved);
      return saved;
    }
  };

  const session = createMyPinsSession('test-site', {
    identity: TEST_EMAIL,
    fetchFn: makeAuthFetch(),
    api
  });

  await session.load();
  assert.equal(ensureCalled, false);
  assert.equal(session.getState().scene, null);

  const saved = await session.save({ id: PIN_ID_1, label: 'Gate A', latlng: [1, 2] });
  assert.equal(ensureCalled, true);
  assert.equal(saveCalled, true);
  assert.equal(saved.id, PIN_ID_1);
  assert.equal(session.getState().scene.id, 'created-scene-1');
  assert.equal(session.getState().pins.length, 1);
});

test('3. saved response only changes state on success (server error leaves state unchanged and clears busy)', async () => {
  const session = createMyPinsSession('test-site', {
    identity: TEST_EMAIL,
    fetchFn: makeAuthFetch(),
    api: {
      listMyPinsScenes: async () => [{ id: 'scene-1', isMine: true, camera: { purpose: 'my-pins-v1' } }],
      listAccountPins: async () => [],
      saveAccountPin: async () => {
        throw new MyPinsError(500, 'HTTP_ERROR');
      }
    }
  });

  await session.load();
  await assert.rejects(
    () => session.save({ id: PIN_ID_1, label: 'Broken Pin' }),
    (err) => err instanceof MyPinsError && err.code === 'HTTP_ERROR'
  );

  const state = session.getState();
  assert.equal(state.pins.length, 0);
  assert.equal(state.busy, false);
});

test('4. delete failure preserves pin in state and clears busy', async () => {
  const session = createMyPinsSession('test-site', {
    identity: TEST_EMAIL,
    fetchFn: makeAuthFetch(),
    api: {
      listMyPinsScenes: async () => [{ id: 'scene-1', isMine: true, camera: { purpose: 'my-pins-v1' } }],
      listAccountPins: async () => [{ id: PIN_ID_1, label: 'Keep Me' }],
      deleteAccountPin: async () => {
        throw new MyPinsError(409, 'CONFLICT');
      }
    }
  });

  await session.load();
  assert.equal(session.getState().pins.length, 1);

  await assert.rejects(
    () => session.remove(PIN_ID_1),
    (err) => err instanceof MyPinsError && err.code === 'CONFLICT'
  );

  assert.equal(session.getState().pins.length, 1);
  assert.equal(session.getState().busy, false);
});

test('5. cancel import does no api write or storage change', async () => {
  let saveCalls = 0;
  const fakeStorage = {
    getItem: () => JSON.stringify([
      {
        id: PIN_ID_1,
        label: 'Local 1',
        latlng: [10, 20],
        position3d: { x: 1, y: 2, z: 3 }
      }
    ]),
    setItem: () => { throw new Error('setItem forbidden'); },
    removeItem: () => { throw new Error('removeItem forbidden'); }
  };

  const session = createMyPinsSession('test-site', {
    identity: TEST_EMAIL,
    fetchFn: makeAuthFetch(),
    storage: fakeStorage,
    api: {
      saveAccountPin: async () => {
        saveCalls++;
      }
    }
  });

  const result = await session.importLegacy(async (plan) => {
    assert.equal(plan.count, 1);
    assert.equal(plan.email, TEST_EMAIL);
    return false;
  });

  assert.equal(result.cancelled, true);
  assert.equal(saveCalls, 0);
  assert.equal(session.getState().busy, false);
});

test('6. partial import retry skips already server ID with no overwrite and preserves IDs', async () => {
  const fakeStorage = {
    getItem: () => JSON.stringify([
      { id: PIN_ID_1, label: 'Existing', latlng: [1, 2], position3d: { x: 0, y: 0, z: 0 } },
      { id: PIN_ID_2, label: 'New', latlng: [3, 4], position3d: { x: 0, y: 0, z: 0 } }
    ])
  };

  const saved = [];
  const serverPins = [{ id: PIN_ID_1, label: 'Existing', sceneId: 's1' }];

  const session = createMyPinsSession('test-site', {
    identity: TEST_EMAIL,
    fetchFn: makeAuthFetch(),
    storage: fakeStorage,
    api: {
      ensureMyPinsScene: async () => ({ scene: { id: 's1', isMine: true, camera: { purpose: 'my-pins-v1' } } }),
      listAccountPins: async () => [...serverPins],
      saveAccountPin: async (_slug, sceneId, payload) => {
        saved.push(payload);
        const res = { ...payload, sceneId };
        serverPins.push(res);
        return res;
      }
    }
  });

  const res = await session.importLegacy(async () => true);
  assert.equal(res.imported, 1);
  assert.equal(res.skipped, 1);
  assert.equal(res.failed, 0);
  assert.equal(res.verified, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, PIN_ID_2);
  assert.equal(saved[0].scope, 'personal');
});

test('7. session email changed rejects before ensure or writes', async () => {
  let ensureCalled = false;
  const session = createMyPinsSession('test-site', {
    identity: TEST_EMAIL,
    fetchFn: makeAuthFetch('intruder@example.test'),
    api: {
      ensureMyPinsScene: async () => { ensureCalled = true; }
    }
  });

  await assert.rejects(
    () => session.load(),
    (err) => err instanceof MyPinsError && err.code === 'SESSION_CHANGED'
  );
  assert.equal(ensureCalled, false);
  assert.equal(session.getState().busy, false);
});

test('8. duplicate workspace selects oldest and reports duplicate count correctly', async () => {
  const s1 = { id: 's-old', createdAt: '2024-01-01T00:00:00Z', isMine: true, camera: { purpose: 'my-pins-v1' } };
  const s2 = { id: 's-mid', createdAt: '2024-06-01T00:00:00Z', isMine: true, camera: { purpose: 'my-pins-v1' } };
  const s3 = { id: 's-new', createdAt: '2024-12-01T00:00:00Z', isMine: true, camera: { purpose: 'my-pins-v1' } };

  const session = createMyPinsSession('test-site', {
    identity: TEST_EMAIL,
    fetchFn: makeAuthFetch(),
    api: {
      listMyPinsScenes: async () => [s1, s2, s3],
      listAccountPins: async () => []
    }
  });

  await session.load();
  const state = session.getState();
  assert.equal(state.scene.id, 's-old');
  assert.equal(state.duplicates, 2);
});

test('9. getState returns immutable deep clone', async () => {
  const session = createMyPinsSession('test-site', {
    identity: TEST_EMAIL,
    fetchFn: makeAuthFetch(),
    api: {
      listMyPinsScenes: async () => [{ id: 's1', camera: { purpose: 'my-pins-v1' } }],
      listAccountPins: async () => [{ id: PIN_ID_1, label: 'L1', latlng: [1, 2] }]
    }
  });

  await session.load();
  const state1 = session.getState();
  state1.pins.push({ id: PIN_ID_2, label: 'Mutated' });
  state1.pins[0].label = 'Altered';
  state1.scene.id = 'mutated-scene';

  const state2 = session.getState();
  assert.equal(state2.pins.length, 1);
  assert.equal(state2.pins[0].label, 'L1');
  assert.equal(state2.scene.id, 's1');
});

test('successful save is not committed to UI state until read-back verifies the record', async () => {
  const original = {id:PIN_ID_1,sceneId:'s1',label:'Original',scope:'personal'};
  const session=createMyPinsSession('alpha',{identity:TEST_EMAIL,fetchFn:makeAuthFetch(),api:{
    listMyPinsScenes:async()=>[{id:'s1'}],listAccountPins:async()=>[original],
    saveAccountPin:async(_slug,sceneId,point)=>({...point,sceneId})
  }});
  await session.load();
  await assert.rejects(()=>session.save({...original,label:'Not actually persisted'}),e=>e.code==='SAVE_NOT_VERIFIED');
  assert.equal(session.getState().pins[0].label,'Original');
  assert.equal(session.getState().busy,false);
});

test('missing or wrong saved scene ID is never accepted', async () => {
  for(const sceneId of [undefined,'other-scene']) {
    const session=createMyPinsSession('alpha',{identity:TEST_EMAIL,fetchFn:makeAuthFetch(),api:{
      listMyPinsScenes:async()=>[{id:'s1'}],listAccountPins:async()=>[],
      saveAccountPin:async(_slug,_scene,point)=>({...point,sceneId})
    }});
    await session.load();
    await assert.rejects(()=>session.save({id:PIN_ID_1,label:'Synthetic'}),e=>e.code==='MALFORMED_RESPONSE');
    assert.equal(session.getState().pins.length,0);
  }
});

test('concurrent mutation is rejected while the first save is in flight', async () => {
  let release, entered; const hold=new Promise(r=>release=r);const ready=new Promise(r=>entered=r);const savedPins=[];
  const session=createMyPinsSession('alpha',{identity:TEST_EMAIL,fetchFn:makeAuthFetch(),api:{
    listMyPinsScenes:async()=>[{id:'s1'}],listAccountPins:async()=>savedPins,
    saveAccountPin:async(_slug,sceneId,point)=>{entered();await hold;const saved={...point,sceneId};savedPins.push(saved);return saved;}
  }});
  await session.load();const saving=session.save({id:PIN_ID_1,label:'One'});await ready;
  await assert.rejects(()=>session.remove(PIN_ID_1),e=>e.code==='BUSY');
  release();await saving;assert.equal(session.getState().pins.length,1);
});

test('legacy import requires atomic create-only and reports a concurrent-ID conflict without overwriting', async () => {
  let options;
  const session=createMyPinsSession('alpha',{identity:TEST_EMAIL,fetchFn:makeAuthFetch(),storage:null,api:{
    buildLegacyImportPlan:()=>({pins:[{id:PIN_ID_1,label:'Old local'}]}),
    ensureMyPinsScene:async()=>({scene:{id:'s1'},duplicates:0}),listAccountPins:async()=>[],
    saveAccountPin:async(_slug,_scene,_point,opts)=>{options=opts;throw new MyPinsError(409,'CONFLICT');}
  }});
  const result=await session.importLegacy(()=>true);
  assert.equal(options.createOnly,true);assert.equal(result.failed,1);assert.equal(result.verified,0);
});

test('create-only conflict is classified as already present only when re-read finds it in this account scene', async () => {
  const local={id:PIN_ID_3,label:'Race',latlng:[1,2],position3d:{x:1,y:2,z:3}};
  const storage={getItem:()=>JSON.stringify([local])};
  let reads=0;
  const scene={id:'s1',isMine:true,camera:{purpose:'my-pins-v1'}};
  const session=createMyPinsSession('alpha',{identity:TEST_EMAIL,fetchFn:makeAuthFetch(),storage,api:{
    listMyPinsScenes:async()=>[scene], ensureMyPinsScene:async()=>({scene}),
    listAccountPins:async()=>{reads++;return reads>=3?[{...local,sceneId:'s1',scope:'personal'}]:[];},
    saveAccountPin:async()=>{throw new MyPinsError(409,'CONFLICT');}
  }});
  await session.load();
  const result=await session.importLegacy(async()=>true);
  assert.equal(result.skipped,1);assert.equal(result.failed,0);assert.equal(result.imported,0);
});

test('create-only conflict remains failure when ID does not exist in this account scene', async () => {
  const local={id:PIN_ID_3,label:'Foreign collision',latlng:[1,2],position3d:{x:1,y:2,z:3}};
  const storage={getItem:()=>JSON.stringify([local])};
  const scene={id:'s1',isMine:true,camera:{purpose:'my-pins-v1'}};
  const session=createMyPinsSession('alpha',{identity:TEST_EMAIL,fetchFn:makeAuthFetch(),storage,api:{
    listMyPinsScenes:async()=>[scene], ensureMyPinsScene:async()=>({scene}), listAccountPins:async()=>[],
    saveAccountPin:async()=>{throw new MyPinsError(409,'CONFLICT');}
  }});
  await session.load();const result=await session.importLegacy(async()=>true);
  assert.equal(result.skipped,0);assert.equal(result.failed,1);
});

test('session photo operations derive scene ownership from session, reject unowned points, and require verified auth', async () => {
  const scene = { id: 's-authoritative', isMine: true, camera: { purpose: 'my-pins-v1' } };
  const ownedPin = { id: PIN_ID_1, sceneId: 's-authoritative', label: 'Owned Point', scope: 'personal' };
  const photoFixture = { id: 'photo-1', pointId: PIN_ID_1, bytes: 500, contentType: 'image/jpeg' };

  let listCalledWith = null;
  let uploadCalledWith = null;
  let retentionCalledWith = null;
  let deleteCalledWith = null;
  let urlCalledWith = null;

  const session = createMyPinsSession('alpha', {
    identity: TEST_EMAIL,
    fetchFn: makeAuthFetch(),
    api: {
      listMyPinsScenes: async () => [scene],
      listAccountPins: async () => [ownedPin],
      listAccountPinPhotos: async (slug, sceneId, pointId) => {
        listCalledWith = { slug, sceneId, pointId };
        return [photoFixture];
      },
      uploadAccountPinPhoto: async (slug, sceneId, pointId, body) => {
        uploadCalledWith = { slug, sceneId, pointId, body };
        return photoFixture;
      },
      setAccountPinPhotoRetention: async (slug, sceneId, pointId, photoId, keep) => {
        retentionCalledWith = { slug, sceneId, pointId, photoId, keep };
        return { ...photoFixture, expiresAt: keep ? null : '2026-10-21T00:00:00Z' };
      },
      deleteAccountPinPhoto: async (slug, sceneId, pointId, photoId) => {
        deleteCalledWith = { slug, sceneId, pointId, photoId };
        return { ok: true };
      },
      getAccountPinPhotoUrl: (slug, sceneId, pointId, photoId, opts) => {
        urlCalledWith = { slug, sceneId, pointId, photoId, opts };
        return `/api/sites/${slug}/scenes/${sceneId}/points/${pointId}/photos/${photoId}${opts?.original ? '?original=1' : ''}`;
      }
    }
  });

  await session.load();
  assert.equal(session.getOwnedSceneId(), 's-authoritative');

  // 1. Successful operations with owned point derive scene from session
  const photos = await session.listPhotos(PIN_ID_1);
  assert.deepEqual(listCalledWith, { slug: 'alpha', sceneId: 's-authoritative', pointId: PIN_ID_1 });
  assert.deepEqual(photos, [photoFixture]);

  const fakeBody = new Uint8Array([1, 2, 3]);
  const uploaded = await session.uploadPhoto(PIN_ID_1, fakeBody);
  assert.deepEqual(uploadCalledWith, { slug: 'alpha', sceneId: 's-authoritative', pointId: PIN_ID_1, body: fakeBody });
  assert.deepEqual(uploaded, photoFixture);

  const updated = await session.setPhotoRetention(PIN_ID_1, 'photo-1', true);
  assert.deepEqual(retentionCalledWith, { slug: 'alpha', sceneId: 's-authoritative', pointId: PIN_ID_1, photoId: 'photo-1', keep: true });
  assert.equal(updated.expiresAt, null);

  const del = await session.deletePhoto(PIN_ID_1, 'photo-1');
  assert.deepEqual(deleteCalledWith, { slug: 'alpha', sceneId: 's-authoritative', pointId: PIN_ID_1, photoId: 'photo-1' });
  assert.deepEqual(del, { ok: true });

  const photoUrl = session.getPhotoUrl(PIN_ID_1, 'photo-1', { original: true });
  assert.deepEqual(urlCalledWith, { slug: 'alpha', sceneId: 's-authoritative', pointId: PIN_ID_1, photoId: 'photo-1', opts: { original: true } });
  assert.equal(photoUrl, `/api/sites/alpha/scenes/s-authoritative/points/${PIN_ID_1}/photos/photo-1?original=1`);

  // 2. Unowned point (PIN_ID_2 is not in session state) rejected immediately
  await assert.rejects(() => session.listPhotos(PIN_ID_2), e => e.code === 'INVALID_INPUT');
  await assert.rejects(() => session.uploadPhoto(PIN_ID_2, fakeBody), e => e.code === 'INVALID_INPUT');
  await assert.rejects(() => session.setPhotoRetention(PIN_ID_2, 'photo-1', true), e => e.code === 'INVALID_INPUT');
  await assert.rejects(() => session.deletePhoto(PIN_ID_2, 'photo-1'), e => e.code === 'INVALID_INPUT');
  assert.throws(() => session.getPhotoUrl(PIN_ID_2, 'photo-1'), e => e.code === 'INVALID_INPUT');

  // 3. Missing or invalid parameters rejected
  await assert.rejects(() => session.listPhotos(''), e => e.code === 'INVALID_INPUT');
  await assert.rejects(() => session.uploadPhoto(PIN_ID_1, null), e => e.code === 'INVALID_INPUT');
  await assert.rejects(() => session.setPhotoRetention(PIN_ID_1, '', true), e => e.code === 'INVALID_INPUT');
  await assert.rejects(() => session.deletePhoto(PIN_ID_1, ''), e => e.code === 'INVALID_INPUT');
  assert.throws(() => session.getPhotoUrl(PIN_ID_1, ''), e => e.code === 'INVALID_INPUT');
});

test('session photo operations enforce busy exclusion and stale identity protection', async () => {
  const scene = { id: 's-authoritative', isMine: true, camera: { purpose: 'my-pins-v1' } };
  const ownedPin = { id: PIN_ID_1, sceneId: 's-authoritative', label: 'Owned Point', scope: 'personal' };

  let releaseUpload, enteredUpload;
  const holdUpload = new Promise(r => releaseUpload = r);
  const readyUpload = new Promise(r => enteredUpload = r);

  const session = createMyPinsSession('alpha', {
    identity: TEST_EMAIL,
    fetchFn: makeAuthFetch(),
    api: {
      listMyPinsScenes: async () => [scene],
      listAccountPins: async () => [ownedPin],
      uploadAccountPinPhoto: async () => {
        enteredUpload();
        await holdUpload;
        return { id: 'p-new', pointId: PIN_ID_1 };
      },
      deleteAccountPinPhoto: async () => ({ ok: true })
    }
  });

  await session.load();

  // In-flight upload sets state.busy and excludes concurrent mutations
  const uploading = session.uploadPhoto(PIN_ID_1, new Uint8Array([1]));
  await readyUpload;
  assert.equal(session.getState().busy, true);

  await assert.rejects(() => session.uploadPhoto(PIN_ID_1, new Uint8Array([2])), e => e.code === 'BUSY');
  await assert.rejects(() => session.setPhotoRetention(PIN_ID_1, 'photo-1', true), e => e.code === 'BUSY');
  await assert.rejects(() => session.deletePhoto(PIN_ID_1, 'photo-1'), e => e.code === 'BUSY');
  await assert.rejects(() => session.remove(PIN_ID_1), e => e.code === 'BUSY');

  releaseUpload();
  await uploading;
  assert.equal(session.getState().busy, false);

  // Identity change aborts photo operations with SESSION_CHANGED
  const stolenSession = createMyPinsSession('alpha', {
    identity: TEST_EMAIL,
    fetchFn: makeAuthFetch('intruder@example.test'),
    api: {
      listMyPinsScenes: async () => [scene],
      listAccountPins: async () => [ownedPin]
    }
  });

  await assert.rejects(() => stolenSession.listPhotos(PIN_ID_1), e => e.code === 'SESSION_CHANGED');
  await assert.rejects(() => stolenSession.uploadPhoto(PIN_ID_1, new Uint8Array([1])), e => e.code === 'SESSION_CHANGED');
  await assert.rejects(() => stolenSession.deletePhoto(PIN_ID_1, 'photo-1'), e => e.code === 'SESSION_CHANGED');
});

test('POINT_HAS_PHOTOS preserves pin in session state and clears busy flag on deletion refusal', async () => {
  const scene = { id: 's-authoritative', isMine: true, camera: { purpose: 'my-pins-v1' } };
  const ownedPin = { id: PIN_ID_1, sceneId: 's-authoritative', label: 'Has Photos Point', scope: 'personal' };

  const session = createMyPinsSession('alpha', {
    identity: TEST_EMAIL,
    fetchFn: makeAuthFetch(),
    api: {
      listMyPinsScenes: async () => [scene],
      listAccountPins: async () => [ownedPin],
      deleteAccountPin: async () => {
        throw new MyPinsError(409, 'POINT_HAS_PHOTOS');
      }
    }
  });

  await session.load();
  assert.equal(session.getState().pins.length, 1);

  await assert.rejects(
    () => session.remove(PIN_ID_1),
    e => e instanceof MyPinsError && e.status === 409 && e.code === 'POINT_HAS_PHOTOS'
  );

  // Pin is retained in state and busy flag is cleared
  assert.equal(session.getState().pins.length, 1);
  assert.equal(session.getState().pins[0].id, PIN_ID_1);
  assert.equal(session.getState().busy, false);
});

test('save account pin captures phoneOverride, verifies readback, and stores in session state', async () => {
  const scene = { id: 's-phone', isMine: true, camera: { purpose: 'my-pins-v1' } };
  let capturedPayload = null;
  let serverPins = [];
  let saveFn = async (_slug, sceneId, payload) => {
    capturedPayload = payload;
    const saved = { ...payload, id: payload.id, sceneId, phoneOverride: payload.phoneOverride };
    serverPins = [saved];
    return saved;
  };

  const api = {
    listMyPinsScenes: async () => [scene],
    listAccountPins: async () => serverPins,
    saveAccountPin: async (slug, sceneId, payload) => saveFn(slug, sceneId, payload),
  };

  const session = createMyPinsSession('test-slug', {
    identity: TEST_EMAIL,
    fetchFn: makeAuthFetch(),
    api,
  });

  await session.load();

  // 1. Save with valid phone override
  const savedPin = await session.save({
    id: PIN_ID_1,
    label: 'Main Gate',
    scope: 'personal',
    phoneOverride: '0412 345 678',
  });

  assert.equal(capturedPayload.phoneOverride, '0412 345 678');
  assert.equal(savedPin.phoneOverride, '0412 345 678');
  assert.equal(session.getState().pins[0].phoneOverride, '0412 345 678');

  // 2. Readback verification fails if readback phoneOverride does not match
  saveFn = async (_slug, sceneId, payload) => {
    return { ...payload, id: payload.id, sceneId, phoneOverride: '0499 999 999' };
  };
  serverPins = [{ id: PIN_ID_1, sceneId: scene.id, label: 'Main Gate', scope: 'personal', phoneOverride: '0400 000 000' }];

  await assert.rejects(
    () => session.save({ id: PIN_ID_1, label: 'Main Gate', scope: 'personal', phoneOverride: '0499 999 999' }),
    e => e instanceof MyPinsError && e.code === 'SAVE_NOT_VERIFIED'
  );

  // 3. Clear phone override with null
  saveFn = async (_slug, sceneId, payload) => {
    const saved = { ...payload, id: payload.id, sceneId, phoneOverride: null };
    serverPins = [saved];
    return saved;
  };

  const cleared = await session.save({
    id: PIN_ID_1,
    label: 'Main Gate',
    scope: 'personal',
    phoneOverride: null,
  });

  assert.equal(cleared.phoneOverride, null);
  assert.equal(session.getState().pins[0].phoneOverride, null);
});
