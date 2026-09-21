import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeScenePoint, PointError, UUID_RE } = require('../scene-points-db.js');

const VALID_SCENE_ID = '00000000-0000-4000-8000-000000000001';
const VALID_POINT_ID = '00000000-0000-4000-8000-000000000002';
const VALID_CONTACT_ID_1 = '00000000-0000-4000-8000-000000000003';
const VALID_CONTACT_ID_2 = '00000000-0000-4000-8000-000000000004';

test('normalizeScenePoint: succeeds with minimal valid payload and sets defaults', () => {
  const input = {
    id: VALID_POINT_ID,
    label: 'Main Gate',
    position3d: { x: 10.5, y: -20, z: 0 },
  };

  const normalized = normalizeScenePoint(VALID_SCENE_ID, input);
  assert.equal(normalized.id, VALID_POINT_ID);
  assert.equal(normalized.sceneId, VALID_SCENE_ID);
  assert.equal(normalized.label, 'Main Gate');
  assert.equal(normalized.type, 'meet-point');
  assert.equal(normalized.scope, 'personal');
  assert.deepEqual(normalized.position3d, { x: 10.5, y: -20, z: 0 });
  assert.equal(normalized.latlng, null);
  assert.equal(normalized.notes, null);
  assert.equal(normalized.buildingRef, null);
  assert.deepEqual(normalized.contactIds, []);
  assert.deepEqual(normalized.routeWaypoints, []);
  assert.deepEqual(normalized.routeWaypoints3d, []);
  assert.equal(normalized.cameraPreset3d, null);
});

test('normalizeScenePoint: canonicalizes hex UUIDs to lowercase and ignores createdBy / siteId', () => {
  const upperScene = 'AAAAAAAA-0000-4000-8000-000000000001';
  const upperPoint = 'BBBBBBBB-0000-4000-8000-000000000002';
  const input = {
    id: upperPoint,
    sceneId: upperScene,
    label: '  Trimmed Area  ',
    type: 'drop-off',
    scope: 'shared',
    position3d: { x: 1, y: 2, z: 3 },
    createdBy: 'malicious-injected-author',
    siteId: '00000000-0000-4000-8000-000000000999',
  };

  const normalized = normalizeScenePoint(upperScene, input);
  assert.equal(normalized.id, upperPoint.toLowerCase());
  assert.equal(normalized.sceneId, upperScene.toLowerCase());
  assert.equal(normalized.label, 'Trimmed Area');
  assert.equal(normalized.type, 'drop-off');
  assert.equal(normalized.scope, 'shared');
  assert.equal(normalized.createdBy, undefined);
  assert.equal(normalized.siteId, undefined);
});

test('normalizeScenePoint: rejects invalid root payloads', () => {
  for (const bad of [null, undefined, 'string', 123, [], true]) {
    assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, bad), (err) => {
      assert.ok(err instanceof PointError);
      assert.equal(err.status, 400);
      assert.equal(err.code, 'INVALID_POINT_PAYLOAD');
      return true;
    });
  }
});

test('normalizeScenePoint: rejects invalid or mismatched sceneId', () => {
  const base = {
    id: VALID_POINT_ID,
    label: 'Check',
    position3d: { x: 0, y: 0, z: 0 },
  };

  assert.throws(() => normalizeScenePoint('not-a-uuid', base), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'INVALID_SCENE_ID');
    return true;
  });

  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, sceneId: null }), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'SCENE_ID_MISMATCH');
    return true;
  });

  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, sceneId: '' }), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'SCENE_ID_MISMATCH');
    return true;
  });

  const otherScene = '99999999-9999-4000-8000-999999999999';
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, sceneId: otherScene }), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.code, 'SCENE_ID_MISMATCH');
    return true;
  });
});

test('normalizeScenePoint: rejects missing, empty or overly long labels', () => {
  const base = { id: VALID_POINT_ID, position3d: { x: 0, y: 0, z: 0 } };

  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base }), { status: 400, code: 'INVALID_LABEL' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, label: '   ' }), { status: 400, code: 'INVALID_LABEL' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, label: 'a'.repeat(161) }), { status: 400, code: 'INVALID_LABEL' });
});

test('normalizeScenePoint: rejects invalid type and scope values', () => {
  const base = { id: VALID_POINT_ID, label: 'Label', position3d: { x: 0, y: 0, z: 0 } };

  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, type: '' }), { status: 400, code: 'INVALID_TYPE' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, type: 42 }), { status: 400, code: 'INVALID_TYPE' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, scope: 'public' }), { status: 400, code: 'INVALID_SCOPE' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, scope: 'admin' }), { status: 400, code: 'INVALID_SCOPE' });
});

test('normalizeScenePoint: enforces finite coordinates and 1e6 bounds on position3d', () => {
  const base = { id: VALID_POINT_ID, label: 'Label' };

  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, position3d: null }), { status: 400, code: 'INVALID_POSITION3D' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, position3d: { x: NaN, y: 0, z: 0 } }), { status: 400, code: 'INVALID_POSITION3D' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, position3d: { x: Infinity, y: 0, z: 0 } }), { status: 400, code: 'INVALID_POSITION3D' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, position3d: { x: 1000001, y: 0, z: 0 } }), { status: 400, code: 'INVALID_POSITION3D' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, position3d: { x: 0, y: -1000001, z: 0 } }), { status: 400, code: 'INVALID_POSITION3D' });
});

test('normalizeScenePoint: validates geographic ranges on latlng', () => {
  const base = { id: VALID_POINT_ID, label: 'Label', position3d: { x: 0, y: 0, z: 0 } };

  const validArray = normalizeScenePoint(VALID_SCENE_ID, { ...base, latlng: [45.123, -122.456] });
  assert.deepEqual(validArray.latlng, [45.123, -122.456]);

  const validObject = normalizeScenePoint(VALID_SCENE_ID, { ...base, latlng: { lat: 0, lng: 180 } });
  assert.deepEqual(validObject.latlng, [0, 180]);

  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, latlng: [91, 0] }), { status: 400, code: 'INVALID_LATLNG' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, latlng: [-91, 0] }), { status: 400, code: 'INVALID_LATLNG' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, latlng: [0, 181] }), { status: 400, code: 'INVALID_LATLNG' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, latlng: [0, -181] }), { status: 400, code: 'INVALID_LATLNG' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, latlng: ['45', '122'] }), { status: 400, code: 'INVALID_LATLNG' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, latlng: [45] }), { status: 400, code: 'INVALID_LATLNG' });
});

test('normalizeScenePoint: validates contactIds array length and UUIDs', () => {
  const base = { id: VALID_POINT_ID, label: 'Label', position3d: { x: 0, y: 0, z: 0 } };

  const res = normalizeScenePoint(VALID_SCENE_ID, {
    ...base,
    contactIds: [VALID_CONTACT_ID_1, VALID_CONTACT_ID_2, VALID_CONTACT_ID_1],
  });
  assert.equal(res.contactIds.length, 2);
  assert.deepEqual(res.contactIds, [VALID_CONTACT_ID_1, VALID_CONTACT_ID_2]);

  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, contactIds: 'not-array' }), { status: 400, code: 'INVALID_CONTACT_IDS' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, contactIds: ['bad-uuid'] }), { status: 400, code: 'INVALID_CONTACT_IDS' });

  const twentyOne = Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, contactIds: twentyOne }), { status: 400, code: 'INVALID_CONTACT_IDS' });
});

test('normalizeScenePoint: bounds route waypoints and camera presets', () => {
  const base = { id: VALID_POINT_ID, label: 'Label', position3d: { x: 0, y: 0, z: 0 } };

  const validCamera = { pitch: 10, yaw: 20, zoom: 1.5 };
  const res = normalizeScenePoint(VALID_SCENE_ID, {
    ...base,
    cameraPreset3d: validCamera,
    routeWaypoints: [{ x: 1, y: 2 }],
  });
  assert.deepEqual(res.cameraPreset3d, validCamera);
  assert.deepEqual(res.routeWaypoints, [{ x: 1, y: 2 }]);

  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, cameraPreset3d: 'primitive' }), { status: 400, code: 'INVALID_CAMERA_PRESET3D' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, cameraPreset3d: [1, 2] }), { status: 400, code: 'INVALID_CAMERA_PRESET3D' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, cameraPreset3d: { text: 'x'.repeat(16001) } }), { status: 400, code: 'INVALID_CAMERA_PRESET3D' });
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, routeWaypoints: Array.from({ length: 101 }, () => 1) }), { status: 400, code: 'INVALID_ROUTE_WAYPOINTS' });
});

test('normalizeScenePoint: restricts type to viewer-supported pin types', () => {
  const base = { id: VALID_POINT_ID, label: 'Label', position3d: { x: 0, y: 0, z: 0 } };
  for (const type of ['drop-off', 'collection', 'both', 'meet-point']) {
    assert.equal(normalizeScenePoint(VALID_SCENE_ID, { ...base, type }).type, type);
  }
  assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, type: 'admin' }), { status: 400, code: 'INVALID_TYPE' });
});

test('deep, cyclic or nonnumeric route/camera trees are rejected predictably', () => {
  const scene='00000000-0000-4000-8000-000000000001';
  const point={id:'00000000-0000-4000-8000-000000000002',label:'Synthetic',position3d:{x:1,y:2,z:3}};
  const cycle={};cycle.x=cycle;
  let deep={x:1};for(let i=0;i<15;i++)deep={nested:deep};
  for(const value of [cycle,deep,{position:{x:'1',y:2,z:3}},{zoom:Infinity}]) {
    assert.throws(()=>normalizeScenePoint(scene,{...point,cameraPreset3d:value}),error=>error.status===400);
  }
  assert.throws(()=>normalizeScenePoint(scene,{...point,routeWaypoints3d:['not coordinates']}),error=>error.status===400);
});
