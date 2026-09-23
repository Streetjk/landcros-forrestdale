import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('pg');
const dbPath = require.resolve('../supabase-db.js');

async function withFakeDb(rows, run) {
  const OriginalPool = pg.Pool;
  const originalUrl = process.env.SUPABASE_DB_URL;
  const queries = [];
  class FakePool {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/select id from sites where slug = \$1/i.test(sql)) {
        return { rows: [{ id: '00000000-0000-0000-0000-000000000001' }] };
      }
      if (/from contacts/i.test(sql)) {
        const resultRows = /c\.active = true/i.test(sql) ? rows.filter(row => row.active === true) : rows;
        return { rows: resultRows };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  }
  pg.Pool = FakePool;
  process.env.SUPABASE_DB_URL = 'postgresql://synthetic.invalid/sitenav_test';
  delete require.cache[dbPath];
  try {
    const db = require(dbPath);
    await run(db, queries);
  } finally {
    delete require.cache[dbPath];
    pg.Pool = OriginalPool;
    if (originalUrl === undefined) delete process.env.SUPABASE_DB_URL;
    else process.env.SUPABASE_DB_URL = originalUrl;
  }
}

const contactRow = {
  id: '10000000-0000-0000-0000-000000000001',
  name: 'Synthetic Contact',
  role: 'Synthetic Role',
  phone: '(00) 0000 0000',
  email: 'synthetic@example.invalid',
  active: true,
  created_by: '20000000-0000-0000-0000-000000000001',
  created_at: '2026-01-01T00:00:00Z',
};

const inactiveContactRow = {
  ...contactRow,
  id: '10000000-0000-0000-0000-000000000002',
  name: 'Inactive Synthetic Contact',
  active: false,
};

test('public contacts are active and referenced by a shared base pin only, with no staff PII/audit fields', async () => {
  await withFakeDb([contactRow, inactiveContactRow], async (db, queries) => {
    const result = await db.getContacts('synthetic-public', { baseOnly: true });
    assert.deepEqual(result, [{
      id: contactRow.id,
      name: contactRow.name,
      role: contactRow.role,
      phone: contactRow.phone,
      active: true,
    }]);
    assert.equal('email' in result[0], false);
    assert.equal('createdBy' in result[0], false);
    assert.equal('createdAt' in result[0], false);

    const sql = queries.at(-1).sql.replace(/\s+/g, ' ').trim();
    assert.match(sql, /c\.active = true/i);
    assert.match(sql, /exists \( select 1 from points p where p\.site_id = \$1 and p\.scene_id is null and p\.scope = 'shared' and c\.id = any\(p\.contact_ids\) \)/i);
    assert.doesNotMatch(sql, /or\s+not\s+exists/i);
  });
});

test('staff contacts retain the existing full contact projection', async () => {
  await withFakeDb([contactRow], async (db, queries) => {
    const result = await db.getContacts('synthetic-staff', { baseOnly: false });
    assert.deepEqual(result, [{
      id: contactRow.id,
      name: contactRow.name,
      role: contactRow.role,
      phone: contactRow.phone,
      email: contactRow.email,
      active: true,
      createdBy: contactRow.created_by,
      createdAt: contactRow.created_at,
    }]);
    const sql = queries.at(-1).sql.replace(/\s+/g, ' ').trim();
    assert.equal(sql, 'select * from contacts where site_id = $1 order by created_at');
  });
});
