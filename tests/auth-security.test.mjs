import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const MIGRATION = fs.readFileSync('supabase/migrations/0019_auth_session_revocation.sql', 'utf8');
const AUTH_SOURCE = fs.readFileSync('auth-db.js', 'utf8');
const SERVER_SOURCE = fs.readFileSync('server.js', 'utf8');

function loadAuthWithPool(pool) {
  const authPath = require.resolve('../auth-db.js');
  const dbPath = require.resolve('../supabase-db.js');
  const savedAuth = require.cache[authPath];
  const savedDb = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: () => pool } };
  delete require.cache[authPath];
  const auth = require(authPath);
  return { auth, restore() {
    if (savedAuth === undefined) delete require.cache[authPath]; else require.cache[authPath] = savedAuth;
    if (savedDb === undefined) delete require.cache[dbPath]; else require.cache[dbPath] = savedDb;
  } };
}

test('0019 adds a server-only session version without widening profile browser reads', () => {
  assert.match(MIGRATION, /add column if not exists session_version bigint not null default 0/);
  assert.match(MIGRATION, /revoke select on table public\.profiles from anon, authenticated/);
  assert.match(MIGRATION, /grant select \(id, email, display_name, status, created_at\) on table public\.profiles to authenticated/);
  assert.doesNotMatch(MIGRATION, /grant select \([^)]*session_version/);
});

test('PIN verification is serialized with a row lock inside one transaction', async () => {
  const queries=[];
  let auth;
  const client={
    async query(sql, params=[]) {
      queries.push({sql,params});
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {rows:[]};
      if (/from profiles[\s\S]*for update/i.test(sql)) return {rows:[{email:'person@hcma.com.au',session_version:'2'}]};
      if (/from profile_pins[\s\S]*for update/i.test(sql)) return {rows:[{pin_hash:auth.hashPin('246810'),failed_attempts:0,locked_until:null}]};
      if (/update profile_pins\s+set failed_attempts/i.test(sql)) return {rows:[{failed_attempts:1,locked_until:null}]};
      throw new Error(`unexpected query: ${sql}`);
    },
    release() { queries.push({sql:'RELEASE',params:[]}); }
  };
  const fixture=loadAuthWithPool({async connect(){return client;},async query(){throw new Error('pool.query forbidden');}});
  auth=fixture.auth;
  try {
    const result=await auth.verifyPin('p1','135790');
    assert.deepEqual(result,{ok:false,reason:'invalid',remaining:4});
    assert.equal(queries[0].sql,'BEGIN');
    assert.match(queries[1].sql,/from profiles[\s\S]*status = 'active'[\s\S]*for update/i);
    assert.match(queries[2].sql,/from profile_pins[\s\S]*for update/i);
    assert.equal(queries.some(q=>q.sql==='COMMIT'),true);
    assert.equal(queries.at(-1).sql,'RELEASE');
  } finally { fixture.restore(); }
});

test('setPin atomically rotates the session version and returns the new DB identity', async () => {
  const queries=[];
  const client={
    async query(sql,params=[]) {
      queries.push({sql,params});
      if (['BEGIN','COMMIT','ROLLBACK'].includes(sql)) return {rows:[]};
      if (/from profiles[\s\S]*for update/i.test(sql)) return {rows:[{email:'PERSON@HCMA.COM.AU',session_version:'8'}]};
      if (/insert into profile_pins/.test(sql)) return {rows:[]};
      if (/set session_version = session_version \+ 1/.test(sql)) return {rows:[{email:' PERSON@HCMA.COM.AU ',session_version:'9'}]};
      throw new Error(`unexpected query: ${sql}`);
    }, release(){}
  };
  const fixture=loadAuthWithPool({async connect(){return client;}});
  try {
    const identity=await fixture.auth.setPin('p1','246810');
    assert.deepEqual(identity,{profileId:'p1',email:'person@hcma.com.au',sessionVersion:9});
    assert.equal(queries[0].sql,'BEGIN');
    assert.equal(queries.at(-1).sql,'COMMIT');
  } finally { fixture.restore(); }
});

test('DB-backed session validation rejects stale version and inactive/offboarded profiles', async () => {
  const previous=process.env.SESSION_SECRET;
  process.env.SESSION_SECRET='synthetic-auth-security-session-secret';
  let row={id:'p1',email:'person@hcma.com.au',session_version:'3'};
  const fixture=loadAuthWithPool({async query(sql,params){
    assert.match(sql,/where id = \$1 and status = 'active'/); assert.deepEqual(params,['p1']);
    return {rows: row ? [row] : []};
  }});
  try {
    const token=fixture.auth.signSession({profileId:'p1',email:'person@hcma.com.au',sessionVersion:3});
    assert.deepEqual(await fixture.auth.validateSession(token),{profileId:'p1',email:'person@hcma.com.au',sessionVersion:3});
    row={...row,session_version:'4'};
    assert.equal(await fixture.auth.validateSession(token),null);
    row=null;
    assert.equal(await fixture.auth.validateSession(token),null);
  } finally {
    fixture.restore();
    if (previous===undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET=previous;
  }
});

test('reset tokens and registration fail closed for inactive identity sources', () => {
  assert.match(AUTH_SOURCE, /select profile_id from pin_reset_tokens[\s\S]*?token_hash = \$1/);
  assert.match(AUTH_SOURCE, /select id from profiles where id = \$1 and status = 'active' for update/);
  assert.match(AUTH_SOURCE, /select id from profiles where id = \$1 and status = 'active' for update/);
  assert.match(AUTH_SOURCE, /site_id = \$2 and active = true/);
  assert.match(AUTH_SOURCE, /if \(existingProfiles\.length === 1\)[\s\S]*?return \{ status: existingProfiles\[0\]\.status, profileId: userId \}/);
});

test('all protected HTTP auth gates use current DB-backed sessions', () => {
  assert.match(SERVER_SOURCE, /function _validatedSession\(req\)[\s\S]*?auth\.validateSession/);
  assert.match(SERVER_SOURCE, /function _requireActiveSession\(req, res, cb\)/);
  assert.doesNotMatch(SERVER_SOURCE, /_session\(req\)/);
  assert.match(SERVER_SOURCE, /auth\.signSession\(v\.identity\)/);
  assert.match(SERVER_SOURCE, /v\.identity\.sessionVersion !== s\.sessionVersion/);
  assert.match(SERVER_SOURCE, /auth\.setPin\(s\.profileId,[\s\S]*?s\.sessionVersion/);
  assert.match(SERVER_SOURCE, /_setSessionCookie\(req, res, auth\.signSession\(identity\)\)/);
  assert.match(SERVER_SOURCE, /_validatedSession\(req\)\.then\(viewer/);
  assert.match(SERVER_SOURCE, /_requireActiveSession\(req, res, \(\) => \{[\s\S]*?hazardDb\.readPhoto/);
});


test('successful PIN verification binds the cookie identity inside profile-then-PIN locks', () => {
  assert.match(AUTH_SOURCE, /select email, session_version[\s\S]*?from profiles[\s\S]*?for update[\s\S]*?select pin_hash, failed_attempts, locked_until[\s\S]*?from profile_pins[\s\S]*?for update/);
  assert.match(AUTH_SOURCE, /return \{ ok: true, identity \}/);
  assert.match(SERVER_SOURCE, /auth\.signSession\(v\.identity\)/);
});

test('PIN change stays bound to the incoming cookie version', () => {
  assert.match(AUTH_SOURCE, /currentVersion !== expectedSessionVersion/);
  assert.match(AUTH_SOURCE, /session-stale/);
  assert.match(SERVER_SOURCE, /v\.identity\.sessionVersion !== s\.sessionVersion/);
  assert.match(SERVER_SOURCE, /auth\.setPin\(s\.profileId,[\s\S]*?s\.sessionVersion/);
});

test('reset issuance and redemption share profile-first lock order', () => {
  const issuance = AUTH_SOURCE.slice(AUTH_SOURCE.indexOf('async function createPinToken'), AUTH_SOURCE.indexOf('async function consumePinToken'));
  const redemption = AUTH_SOURCE.slice(AUTH_SOURCE.indexOf('async function consumePinToken'), AUTH_SOURCE.indexOf('// ── Session tokens'));
  assert.match(issuance, /profiles[\s\S]*?for update[\s\S]*?update pin_reset_tokens/);
  assert.match(redemption, /select profile_id from pin_reset_tokens[\s\S]*?select id from profiles[\s\S]*?for update[\s\S]*?update pin_reset_tokens/);
});
