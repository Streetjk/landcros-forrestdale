import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeScenePoint, saveScenePoint, getScenePoints, PointError, UUID_RE } = require('../scene-points-db.js');
const supabaseDb = require('../supabase-db.js');

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

test('normalizeScenePoint: validates phoneOverride with AU/international display phone policy and clears null/blank', () => {
  const base = { id: VALID_POINT_ID, label: 'Label', position3d: { x: 0, y: 0, z: 0 } };

  // Valid AU display numbers
  assert.equal(normalizeScenePoint(VALID_SCENE_ID, { ...base, phoneOverride: '0412 345 678' }).phoneOverride, '0412 345 678');
  assert.equal(normalizeScenePoint(VALID_SCENE_ID, { ...base, phoneOverride: '+61 412 345 678' }).phoneOverride, '+61 412 345 678');
  assert.equal(normalizeScenePoint(VALID_SCENE_ID, { ...base, phoneOverride: '(08) 9234 9800' }).phoneOverride, '(08) 9234 9800');
  assert.equal(normalizeScenePoint(VALID_SCENE_ID, { ...base, phoneOverride: '1300 123 456' }).phoneOverride, '1300 123 456');

  // Valid international display numbers
  assert.equal(normalizeScenePoint(VALID_SCENE_ID, { ...base, phoneOverride: '+1 (555) 234-5678' }).phoneOverride, '+1 (555) 234-5678');
  assert.equal(normalizeScenePoint(VALID_SCENE_ID, { ...base, phoneOverride: '+44 20 7946 0958' }).phoneOverride, '+44 20 7946 0958');

  // Null/blank clears to null
  assert.equal(normalizeScenePoint(VALID_SCENE_ID, { ...base, phoneOverride: null }).phoneOverride, null);
  assert.equal(normalizeScenePoint(VALID_SCENE_ID, { ...base, phoneOverride: '' }).phoneOverride, null);
  assert.equal(normalizeScenePoint(VALID_SCENE_ID, { ...base, phoneOverride: '   ' }).phoneOverride, null);
  assert.equal(normalizeScenePoint(VALID_SCENE_ID, { ...base }).phoneOverride, null);

  // Snake_case alias
  assert.equal(normalizeScenePoint(VALID_SCENE_ID, { ...base, phone_override: '0400 111 222' }).phoneOverride, '0400 111 222');

  // Rejects invalid inputs with 400 INVALID_PHONE_OVERRIDE
  const invalid = [
    123456789,
    true,
    [],
    {},
    'call me',
    '0412 abc 789',
    '<script>alert(1)</script>',
    'tel:0412345678',
    'javascript:alert()',
    '0412\n345678',
    '0412\0 345678',
    '12',
    '+',
    '+61+412345678',
    '0412+345678',
    'a'.repeat(33),
    '+' + '1'.repeat(35),
  ];
  for (const bad of invalid) {
    assert.throws(() => normalizeScenePoint(VALID_SCENE_ID, { ...base, phoneOverride: bad }), {
      status: 400,
      code: 'INVALID_PHONE_OVERRIDE',
    });
  }
});

test('saveScenePoint and getScenePoints: persist and serialize phoneOverride while preserving base behavior', async () => {
  const originalPool = supabaseDb.pool;
  const originalGetSiteId = supabaseDb.getSiteId;
  const SITE_ID = '00000000-0000-4000-8000-000000000001';
  const SCENE_ID = '00000000-0000-4000-8000-000000000002';
  const POINT_ID = '00000000-0000-4000-8000-000000000003';
  const ACTOR_ID = '00000000-0000-4000-8000-000000000004';

  let upsertParams = null;
  const fakeClient = {
    async query(sql, params) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('from scenes')) {
        return { rows: [{ id: SCENE_ID, kind: 'admin', camera: { purpose: 'my-pins-v1' }, created_by: ACTOR_ID }] };
      }
      if (sql.includes('insert into points')) {
        upsertParams = params;
        return {
          rows: [{
            id: params[0],
            site_id: params[1],
            scene_id: params[2],
            label: params[3],
            type: params[4],
            scope: params[5],
            latlng: null,
            position3d: { x: 1, y: 2, z: 3 },
            notes: null,
            contact_ids: [],
            route_waypoints: [],
            route_waypoints3d: [],
            camera_preset3d: null,
            building_ref: null,
            created_by: params[14],
            phone_override: params[16],
          }]
        };
      }
      if (sql.includes('insert into audit_log')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const fakePool = {
    connect: async () => fakeClient,
    async query(sql) {
      if (sql.includes('select * from points')) {
        return {
          rows: [{
            id: POINT_ID,
            site_id: SITE_ID,
            scene_id: SCENE_ID,
            label: 'Gate 1',
            type: 'drop-off',
            scope: 'personal',
            latlng: null,
            position3d: { x: 1, y: 2, z: 3 },
            notes: null,
            contact_ids: [],
            route_waypoints: [],
            route_waypoints3d: [],
            camera_preset3d: null,
            building_ref: null,
            created_by: ACTOR_ID,
            phone_override: '0400 123 456',
          }]
        };
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
  };

  try {
    supabaseDb.pool = () => fakePool;
    supabaseDb.getSiteId = async () => SITE_ID;

    // 1. saveScenePoint binds phoneOverride as parameter $17
    const saved = await saveScenePoint('test-slug', SCENE_ID, {
      id: POINT_ID,
      label: 'Gate 1',
      position3d: { x: 1, y: 2, z: 3 },
      phoneOverride: '0400 123 456',
    }, ACTOR_ID);

    assert.ok(upsertParams);
    assert.equal(upsertParams[16], '0400 123 456');
    assert.equal(upsertParams[17], true);
    assert.equal(saved.phoneOverride, '0400 123 456');

    // 2. getScenePoints returns scene point with phoneOverride
    const list = await getScenePoints('test-slug', SCENE_ID);
    assert.equal(list.length, 1);
    assert.equal(list[0].phoneOverride, '0400 123 456');

    // 3. Base public point serialization (supabaseDb.pointToJson) preserves legacy behavior without phoneOverride
    const basePoint = supabaseDb.pointToJson({
      id: POINT_ID,
      scene_id: null,
      label: 'Base Gate',
      type: 'drop-off',
      scope: 'shared',
      position3d: { x: 0, y: 0, z: 0 },
      phone_override: '0400 999 999',
    });
    assert.equal(Object.hasOwn(basePoint, 'phoneOverride'), false);
  } finally {
    supabaseDb.pool = originalPool;
    supabaseDb.getSiteId = originalGetSiteId;
  }
});

test('saveScenePoint boundary: accepts owner My Pins and rejects ordinary admin, ownerless legacy, hazard, and different actor', async () => {
  const originalPool = supabaseDb.pool;
  const originalGetSiteId = supabaseDb.getSiteId;
  const SITE_ID = '00000000-0000-4000-8000-000000000001';
  const SCENE_ID = '00000000-0000-4000-8000-000000000002';
  const POINT_ID = '00000000-0000-4000-8000-000000000003';
  const OWNER_ID = '00000000-0000-4000-8000-000000000004';
  const OTHER_ID = '00000000-0000-4000-8000-000000000005';

  function mockDb(sceneRow, existingRows = []) {
    let upsertParams = null;
    const store = new Map(existingRows.map(r => [r.id, { ...r }]));
    const fakeClient = {
      async query(sql, params) {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('from scenes')) {
          return { rows: sceneRow ? [sceneRow] : [] };
        }
        if (sql.includes('insert into points')) {
          upsertParams = params;
          const pointId = params[0];
          const existing = store.get(pointId);
          const hasExplicit = params[17];
          const phoneOverride = hasExplicit ? params[16] : (existing ? (existing.phone_override ?? null) : params[16]);
          const row = {
            id: params[0],
            site_id: params[1],
            scene_id: params[2],
            label: params[3],
            type: params[4],
            scope: params[5],
            latlng: null,
            position3d: { x: 1, y: 2, z: 3 },
            notes: null,
            contact_ids: [],
            route_waypoints: [],
            route_waypoints3d: [],
            camera_preset3d: null,
            building_ref: null,
            created_by: params[14],
            phone_override: phoneOverride,
          };
          store.set(pointId, row);
          return { rows: [row] };
        }
        if (sql.includes('insert into audit_log')) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      },
      release() {},
    };
    return {
      pool: {
        connect: async () => fakeClient,
      },
      getUpsertParams: () => upsertParams,
    };
  }

  try {
    supabaseDb.getSiteId = async () => SITE_ID;

    // 1. Accepted: owner My Pins (kind=admin, camera.purpose=my-pins-v1, created_by=OWNER_ID)
    {
      const mock = mockDb({
        id: SCENE_ID,
        kind: 'admin',
        camera: { purpose: 'my-pins-v1' },
        created_by: OWNER_ID,
      });
      supabaseDb.pool = () => mock.pool;

      const saved = await saveScenePoint('test-slug', SCENE_ID, {
        id: POINT_ID,
        label: 'My Pin Gate',
        position3d: { x: 1, y: 2, z: 3 },
        phoneOverride: '0412 345 678',
      }, OWNER_ID);

      assert.equal(saved.phoneOverride, '0412 345 678');
      assert.equal(mock.getUpsertParams()[16], '0412 345 678');

      // snake_case phone_override also accepted
      const savedSnake = await saveScenePoint('test-slug', SCENE_ID, {
        id: POINT_ID,
        label: 'My Pin Gate',
        position3d: { x: 1, y: 2, z: 3 },
        phone_override: '+61 412 345 678',
      }, OWNER_ID);
      assert.equal(savedSnake.phoneOverride, '+61 412 345 678');

      // explicit null to clear phone override is accepted on owner My Pins
      const savedCleared = await saveScenePoint('test-slug', SCENE_ID, {
        id: POINT_ID,
        label: 'My Pin Gate',
        position3d: { x: 1, y: 2, z: 3 },
        phoneOverride: null,
      }, OWNER_ID);
      assert.equal(savedCleared.phoneOverride, null);
    }

    // 2. Rejected: ordinary admin scene (kind=admin, camera has no purpose or camera=null)
    {
      const mock = mockDb({
        id: SCENE_ID,
        kind: 'admin',
        camera: { position: [1, 2, 3] },
        created_by: OWNER_ID,
      });
      supabaseDb.pool = () => mock.pool;

      await assert.rejects(
        () => saveScenePoint('test-slug', SCENE_ID, {
          id: POINT_ID,
          label: 'Admin Gate',
          position3d: { x: 1, y: 2, z: 3 },
          phoneOverride: '0412 345 678',
        }, OWNER_ID),
        (err) => {
          assert.ok(err instanceof PointError);
          assert.equal(err.status, 400);
          assert.equal(err.code, 'INVALID_PHONE_OVERRIDE');
          return true;
        }
      );

      // Rejects snake_case phone_override on ordinary admin
      await assert.rejects(
        () => saveScenePoint('test-slug', SCENE_ID, {
          id: POINT_ID,
          label: 'Admin Gate',
          position3d: { x: 1, y: 2, z: 3 },
          phone_override: '0412 345 678',
        }, OWNER_ID),
        { status: 400, code: 'INVALID_PHONE_OVERRIDE' }
      );
    }

    // 3. Rejected: ownerless legacy scene (kind=admin, created_by=null)
    {
      const mock = mockDb({
        id: SCENE_ID,
        kind: 'admin',
        camera: null,
        created_by: null,
      });
      supabaseDb.pool = () => mock.pool;

      await assert.rejects(
        () => saveScenePoint('test-slug', SCENE_ID, {
          id: POINT_ID,
          label: 'Legacy Gate',
          position3d: { x: 1, y: 2, z: 3 },
          phoneOverride: '0412 345 678',
        }, OWNER_ID),
        { status: 400, code: 'INVALID_PHONE_OVERRIDE' }
      );
    }

    // 4. Rejected: hazard scene (kind=hazard, even if camera purpose or creator matches)
    {
      const mock = mockDb({
        id: SCENE_ID,
        kind: 'hazard',
        camera: { purpose: 'my-pins-v1' },
        created_by: OWNER_ID,
      });
      supabaseDb.pool = () => mock.pool;

      await assert.rejects(
        () => saveScenePoint('test-slug', SCENE_ID, {
          id: POINT_ID,
          label: 'Hazard Pin',
          position3d: { x: 1, y: 2, z: 3 },
          phoneOverride: '0412 345 678',
        }, OWNER_ID),
        { status: 400, code: 'INVALID_PHONE_OVERRIDE' }
      );
    }

    // 5. Rejected: different actor (kind=admin, camera.purpose=my-pins-v1, created_by=OWNER_ID, changedBy=OTHER_ID)
    {
      const mock = mockDb({
        id: SCENE_ID,
        kind: 'admin',
        camera: { purpose: 'my-pins-v1' },
        created_by: OWNER_ID,
      });
      supabaseDb.pool = () => mock.pool;

      await assert.rejects(
        () => saveScenePoint('test-slug', SCENE_ID, {
          id: POINT_ID,
          label: 'Different Actor Pin',
          position3d: { x: 1, y: 2, z: 3 },
          phoneOverride: '0412 345 678',
        }, OTHER_ID),
        { status: 400, code: 'INVALID_PHONE_OVERRIDE' }
      );
    }

    // 6. Preserved: saves that omit phone override field succeed across ordinary admin, legacy, and hazard scenes
    {
      // Ordinary admin without override
      const adminMock = mockDb({
        id: SCENE_ID,
        kind: 'admin',
        camera: { position: [1, 2, 3] },
        created_by: OWNER_ID,
      });
      supabaseDb.pool = () => adminMock.pool;
      const adminSaved = await saveScenePoint('test-slug', SCENE_ID, {
        id: POINT_ID,
        label: 'Ordinary Admin Gate',
        position3d: { x: 1, y: 2, z: 3 },
      }, OWNER_ID);
      assert.equal(adminSaved.phoneOverride, null);
      assert.equal(adminMock.getUpsertParams()[16], null);

      // Ownerless legacy without override
      const legacyMock = mockDb({
        id: SCENE_ID,
        kind: 'admin',
        camera: null,
        created_by: null,
      });
      supabaseDb.pool = () => legacyMock.pool;
      const legacySaved = await saveScenePoint('test-slug', SCENE_ID, {
        id: POINT_ID,
        label: 'Legacy Gate',
        position3d: { x: 1, y: 2, z: 3 },
      }, OWNER_ID);
      assert.equal(legacySaved.phoneOverride, null);

      // Hazard scene without override
      const hazardMock = mockDb({
        id: SCENE_ID,
        kind: 'hazard',
        camera: null,
        created_by: OWNER_ID,
      });
      supabaseDb.pool = () => hazardMock.pool;
      const hazardSaved = await saveScenePoint('test-slug', SCENE_ID, {
        id: POINT_ID,
        label: 'Hazard Pin',
        position3d: { x: 1, y: 2, z: 3 },
      }, OWNER_ID);
      assert.equal(hazardSaved.phoneOverride, null);

      // Different actor on ordinary admin without override
      const diffActorMock = mockDb({
        id: SCENE_ID,
        kind: 'admin',
        camera: null,
        created_by: OWNER_ID,
      });
      supabaseDb.pool = () => diffActorMock.pool;
      const diffSaved = await saveScenePoint('test-slug', SCENE_ID, {
        id: POINT_ID,
        label: 'Ordinary Admin Collaborator Pin',
        position3d: { x: 1, y: 2, z: 3 },
      }, OTHER_ID);
      assert.equal(diffSaved.phoneOverride, null);
    }

    // 7. Invariant: omission of phoneOverride on update must NOT silently clear an existing override
    {
      const existingRow = {
        id: POINT_ID,
        phone_override: '+61 412 345 678',
      };
      const mock = mockDb({
        id: SCENE_ID,
        kind: 'admin',
        camera: { purpose: 'my-pins-v1' },
        created_by: OWNER_ID,
      }, [existingRow]);
      supabaseDb.pool = () => mock.pool;

      // Update by owner omitting phoneOverride retains existing override
      const ownerUpdate = await saveScenePoint('test-slug', SCENE_ID, {
        id: POINT_ID,
        label: 'Updated by Owner',
        position3d: { x: 1, y: 2, z: 3 },
      }, OWNER_ID);
      assert.equal(ownerUpdate.phoneOverride, '+61 412 345 678');
      assert.equal(mock.getUpsertParams()[17], false);

      // Update by platform admin / non-owner omitting phoneOverride succeeds and retains existing override
      const nonOwnerUpdate = await saveScenePoint('test-slug', SCENE_ID, {
        id: POINT_ID,
        label: 'Updated by Platform Admin',
        position3d: { x: 1, y: 2, z: 3 },
      }, OTHER_ID);
      assert.equal(nonOwnerUpdate.phoneOverride, '+61 412 345 678');
      assert.equal(mock.getUpsertParams()[17], false);

      // Non-owner attempting explicit phoneOverride update or clear is rejected
      await assert.rejects(
        () => saveScenePoint('test-slug', SCENE_ID, {
          id: POINT_ID,
          label: 'Non-owner override attempt',
          position3d: { x: 1, y: 2, z: 3 },
          phoneOverride: '0400 999 888',
        }, OTHER_ID),
        { status: 400, code: 'INVALID_PHONE_OVERRIDE' }
      );
      await assert.rejects(
        () => saveScenePoint('test-slug', SCENE_ID, {
          id: POINT_ID,
          label: 'Non-owner clear attempt',
          position3d: { x: 1, y: 2, z: 3 },
          phoneOverride: null,
        }, OTHER_ID),
        { status: 400, code: 'INVALID_PHONE_OVERRIDE' }
      );

      // Explicit null from owner clears the override
      const ownerCleared = await saveScenePoint('test-slug', SCENE_ID, {
        id: POINT_ID,
        label: 'Cleared by Owner',
        position3d: { x: 1, y: 2, z: 3 },
        phoneOverride: null,
      }, OWNER_ID);
      assert.equal(ownerCleared.phoneOverride, null);
      assert.equal(mock.getUpsertParams()[17], true);

      // Reset existing override and test explicit blank string from owner clears it
      const mockWithExisting = mockDb({
        id: SCENE_ID,
        kind: 'admin',
        camera: { purpose: 'my-pins-v1' },
        created_by: OWNER_ID,
      }, [existingRow]);
      supabaseDb.pool = () => mockWithExisting.pool;

      const ownerBlankCleared = await saveScenePoint('test-slug', SCENE_ID, {
        id: POINT_ID,
        label: 'Blank Cleared by Owner',
        position3d: { x: 1, y: 2, z: 3 },
        phoneOverride: '   ',
      }, OWNER_ID);
      assert.equal(ownerBlankCleared.phoneOverride, null);
      assert.equal(mockWithExisting.getUpsertParams()[17], true);
    }
  } finally {
    supabaseDb.pool = originalPool;
    supabaseDb.getSiteId = originalGetSiteId;
  }
});
