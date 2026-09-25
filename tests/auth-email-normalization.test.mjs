import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const previousSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = 'synthetic-session-secret-for-email-normalization-tests';
const auth = require('../auth-db.js');


function loadAuthWithFakes({ listUsers, profileRows = [] }) {
  const authPath = require.resolve('../auth-db.js');
  const dbPath = require.resolve('../supabase-db.js');
  const supabasePath = require.resolve('@supabase/supabase-js');
  const saved = new Map([
    [authPath, require.cache[authPath]],
    [dbPath, require.cache[dbPath]],
    [supabasePath, require.cache[supabasePath]],
  ]);
  const savedEnv = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  };
  process.env.SUPABASE_URL = 'https://synthetic.invalid';
  process.env.SUPABASE_SECRET_KEY = 'synthetic-secret';
  const state = { connected: false, queries: [] };
  const client = {
    async query(sql, params = []) {
      state.queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('select id from sites where slug')) return { rows: [{ id: 'site-1' }] };
      if (sql.includes('select id, status from profiles where lower(btrim(email))')) return { rows: profileRows };
      if (sql.includes('select distinct site_id from contacts')) return { rows: [] };
      if (sql.includes('insert into profiles')) return { rows: [{ id: 'auth-user-1' }] };
      throw new Error(`unexpected fake query: ${sql}`);
    },
    release() {},
  };
  const pool = {
    async connect() { state.connected = true; return client; },
    async query() { throw new Error('unexpected pool.query'); },
  };
  const admin = {
    auth: {
      admin: {
        async createUser() { return { data: null, error: { message: 'already exists' } }; },
        listUsers,
      },
    },
  };

  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: () => pool } };
  require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { createClient: () => admin } };
  delete require.cache[authPath];
  const fakeAuth = require(authPath);

  return {
    auth: fakeAuth,
    state,
    restore() {
      for (const [path, entry] of saved) {
        if (entry === undefined) delete require.cache[path];
        else require.cache[path] = entry;
      }
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

test.after(() => {
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
});

test('normalizeEmail canonicalizes case and surrounding whitespace safely', () => {
  assert.equal(auth.normalizeEmail('  Example.User@HCMA.COM.AU  '), 'example.user@hcma.com.au');
  assert.equal(auth.normalizeEmail('staff@hcma.com.au'), 'staff@hcma.com.au');
  assert.equal(auth.normalizeEmail(null), '');
  assert.equal(auth.normalizeEmail({}), '');
});

test('emailAllowed evaluates canonical identity and still rejects invalid domains', () => {
  assert.equal(auth.emailAllowed('  Example.User@HCMA.COM.AU  '), true);
  assert.equal(auth.emailAllowed('person@example.com'), false);
  assert.equal(auth.emailAllowed('not-an-email'), false);
  assert.equal(auth.emailAllowed(null), false);
});

test('session identity is canonical on issue and verification', () => {
  const token = auth.signSession({ profileId: 'synthetic-profile', email: '  Person@HCMA.COM.AU ', sessionVersion: 7 });
  assert.deepEqual(auth.verifySession(token), {
    profileId: 'synthetic-profile',
    email: 'person@hcma.com.au',
    sessionVersion: 7,
  });
});

test('profile persistence paths canonicalize and fail closed on duplicate canonical profiles', async () => {
  const source = await readFile(new URL('../auth-db.js', import.meta.url), 'utf8');
  assert.match(source, /lower\(btrim\(email\)\) = \$1 limit 2/);
  assert.match(source, /if \(rows\.length > 1\) throw new Error\('Ambiguous canonical email identity'\)/);
  assert.match(source, /email: canonicalEmail,\n\s+email_confirm: true/);
  assert.match(source, /\[userId, canonicalEmail, status\]/);
  assert.match(source, /lower\(btrim\(email\)\) = \$1 and site_id = \$2 and active = true/);
  assert.match(source, /matches\.length !== 1/);
});

test('auth HTTP entry points normalize before lookup, delivery, creation and session issue', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const login = source.slice(source.indexOf("pathname === '/api/auth/login'"), source.indexOf("pathname === '/api/auth/pin/request-reset'"));
  const reset = source.slice(source.indexOf("pathname === '/api/auth/pin/request-reset'"), source.indexOf("pathname === '/api/auth/pin/reset'"));
  const create = source.slice(source.indexOf("pathname === '/api/auth/create'"), source.indexOf('// Which site this deployment serves'));

  assert.match(login, /const canonicalEmail = auth\.normalizeEmail\(email\)/);
  assert.match(login, /auth\.checkProfile\(canonicalEmail\)/);
  assert.match(login, /email: canonicalEmail, mode: 'setup'/);
  assert.match(login, /auth\.signSession\(v\.identity\)/);

  assert.match(reset, /const canonicalEmail = auth\.normalizeEmail\(email\)/);
  assert.match(reset, /auth\.checkProfile\(canonicalEmail\)/);
  assert.match(reset, /email: canonicalEmail, mode: hasPin \? 'reset' : 'setup'/);

  assert.match(create, /const canonicalEmail = auth\.normalizeEmail\(email\)/);
  assert.match(create, /auth\.createProfile\(canonicalEmail\)/);
  assert.match(create, /email: canonicalEmail, mode: 'setup'/);
});


test('createProfile scans all auth pages and rejects a duplicate canonical auth identity', { concurrency: false }, async () => {
  const pages = [];
  const fixture = loadAuthWithFakes({
    listUsers: async ({ page, perPage }) => {
      pages.push({ page, perPage });
      if (page === 1) {
        const users = [{ id: 'auth-user-1', email: ' PERSON@HCMA.COM.AU ' }];
        while (users.length < 1000) users.push({ id: `noise-${users.length}`, email: `noise-${users.length}@hcma.com.au` });
        return { data: { users }, error: null };
      }
      if (page === 2) return { data: { users: [{ id: 'auth-user-2', email: 'person@hcma.com.au' }] }, error: null };
      throw new Error(`unexpected page ${page}`);
    },
  });
  try {
    await assert.rejects(
      fixture.auth.createProfile(' Person@HCMA.COM.AU '),
      /Existing auth identity is missing or ambiguous/
    );
    assert.deepEqual(pages, [{ page: 1, perPage: 1000 }, { page: 2, perPage: 1000 }]);
    assert.equal(fixture.state.connected, false, 'ambiguous Auth identity must fail before profile/membership writes');
  } finally {
    fixture.restore();
  }
});

test('createProfile rejects duplicate canonical profile rows before contact or membership writes', { concurrency: false }, async () => {
  const fixture = loadAuthWithFakes({
    listUsers: async ({ page, perPage }) => {
      assert.equal(page, 1);
      assert.equal(perPage, 1000);
      return { data: { users: [{ id: 'auth-user-1', email: 'person@hcma.com.au' }] }, error: null };
    },
    profileRows: [{ id: 'auth-user-1' }, { id: 'other-profile' }],
  });
  try {
    await assert.rejects(
      fixture.auth.createProfile(' PERSON@HCMA.COM.AU '),
      /Ambiguous canonical email identity/
    );
    assert.equal(fixture.state.connected, true);
    assert.equal(fixture.state.queries.some(({ sql }) => sql.includes('select distinct site_id from contacts')), false);
    assert.equal(fixture.state.queries.some(({ sql }) => sql === 'ROLLBACK'), true);
  } finally {
    fixture.restore();
  }
});
