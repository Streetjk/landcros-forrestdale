import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('pg');
const dbPath = require.resolve('../supabase-db.js');

const SITE_ID = '00000000-0000-0000-0000-000000000001';
const sharedBase = {
  id: '10000000-0000-0000-0000-000000000001',
  site_id: SITE_ID,
  scene_id: null,
  label: 'Public gate',
  type: 'drop-off',
  scope: 'shared',
  latlng: [-32.0, 115.9],
  position3d: { x: 1, y: 0, z: 2 },
  notes: 'Visitor entry',
  contact_ids: [],
  route_waypoints: [],
  route_waypoints3d: [],
  camera_preset3d: null,
  building_ref: null,
  created_by: '20000000-0000-0000-0000-000000000001',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};
const personalBase = { ...sharedBase, id: '10000000-0000-0000-0000-000000000002', label: 'Private note', scope: 'personal' };
const sharedScene = { ...sharedBase, id: '10000000-0000-0000-0000-000000000003', scene_id: '30000000-0000-0000-0000-000000000001', label: 'Scoped guide pin' };

async function withFakeDb(run) {
  const OriginalPool = pg.Pool;
  const originalUrl = process.env.SUPABASE_DB_URL;
  const queries = [];
  class FakePool {
    async query(sql, params) {
      sql = String(sql);
      queries.push({ sql, params });
      if (/select id from sites where slug = \$1/i.test(sql)) return { rows: [{ id: SITE_ID }] };
      if (/from points/i.test(sql)) {
        const all = [sharedBase, personalBase, sharedScene];
        if (/scene_id is null/i.test(sql) && /scope = 'shared'/i.test(sql)) {
          return { rows: all.filter((row) => row.scene_id === null && row.scope === 'shared') };
        }
        return { rows: all };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  }
  pg.Pool = FakePool;
  process.env.SUPABASE_DB_URL = 'postgresql://synthetic.invalid/sitenav_test';
  delete require.cache[dbPath];
  try { await run(require(dbPath), queries); }
  finally {
    delete require.cache[dbPath];
    pg.Pool = OriginalPool;
    if (originalUrl === undefined) delete process.env.SUPABASE_DB_URL;
    else process.env.SUPABASE_DB_URL = originalUrl;
  }
}

test('public base-point read requires both base scope and explicit sharing', async () => {
  await withFakeDb(async (db, queries) => {
    const result = await db.getPoints('synthetic-public', { baseOnly: true });
    assert.deepEqual(result.map((point) => point.id), [sharedBase.id]);
    assert.equal(result[0].scope, 'shared');
    for (const forbidden of ['sceneId', 'createdBy', 'createdAt', 'updatedAt']) {
      assert.equal(forbidden in result[0], false);
    }

    const sql = queries.at(-1).sql.replace(/\s+/g, ' ').trim();
    assert.match(sql, /where site_id = \$1 and scene_id is null and scope = 'shared'/i);
  });
});

test('staff point read retains the existing all-scope/all-scene contract', async () => {
  await withFakeDb(async (db, queries) => {
    const result = await db.getPoints('synthetic-staff', { baseOnly: false });
    assert.deepEqual(result.map((point) => point.id), [sharedBase.id, personalBase.id, sharedScene.id]);
    assert.equal(result[1].scope, 'personal');
    assert.equal(result[2].sceneId, sharedScene.scene_id);

    const sql = queries.at(-1).sql.replace(/\s+/g, ' ').trim();
    assert.equal(sql, 'select * from points where site_id = $1 order by created_at');
  });
});
