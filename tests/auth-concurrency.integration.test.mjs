import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');

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

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function tokenHash(raw) {
  return createHash('sha256').update(raw).digest('base64url');
}

test('PIN/reset concurrency uses profile-first locks without deadlock and stale version cannot overwrite', {
  skip: !process.env.SITENAV_TEST_DATABASE_URL,
  timeout: 30000,
}, async () => {
  const base = new URL(process.env.SITENAV_TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  assert.equal(base.pathname, '/sitenav_test');
  assert.equal(base.username, 'sitenav_test');

  const schema = 'test_auth_' + randomUUID().replaceAll('-', '');
  const root = new Client({ connectionString: base.href });
  const scoped = new URL(base);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const rawPool = new Pool({ connectionString: scoped.href, max: 4 });
  const profileId = randomUUID();
  const oldRawToken = randomBytes(32).toString('base64url');

  await root.connect();
  await root.query(`create schema ${schema}`);
  try {
    await rawPool.query(`
      create table profiles(
        id uuid primary key,
        email text not null,
        status text not null,
        session_version bigint not null default 0
      );
      create table profile_pins(
        profile_id uuid primary key,
        pin_hash text not null,
        set_at timestamptz not null default now(),
        failed_attempts int not null default 0,
        locked_until timestamptz
      );
      create table pin_reset_tokens(
        token_hash text primary key,
        profile_id uuid not null,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        used_at timestamptz
      );
    `);
    await rawPool.query(
      `insert into profiles(id,email,status,session_version) values($1,'person@hcma.com.au','active',0)`,
      [profileId]
    );
    await rawPool.query(
      `insert into pin_reset_tokens(token_hash,profile_id,expires_at) values($1,$2,now()+interval '10 minutes')`,
      [tokenHash(oldRawToken), profileId]
    );

    // Deterministically hold issuance after it has locked the profile. Redemption
    // can still read the token, then blocks on that same profile lock. Releasing
    // issuance lets it invalidate the old token and commit; redemption then fails
    // token-invalid rather than forming a profile<->token deadlock.
    const issuanceHasProfile = deferred();
    const redemptionSawToken = deferred();
    const releaseIssuance = deferred();
    let connectionNo = 0;
    const pool = {
      async connect() {
        const raw = await rawPool.connect();
        const n = ++connectionNo;
        return {
          async query(sql, params = []) {
            if (n === 1 && /from profiles[\s\S]*for update/i.test(sql)) {
              const result = await raw.query(sql, params);
              issuanceHasProfile.resolve();
              await releaseIssuance.promise;
              return result;
            }
            if (n === 2 && /select profile_id from pin_reset_tokens/i.test(sql)) {
              const result = await raw.query(sql, params);
              redemptionSawToken.resolve();
              return result;
            }
            return raw.query(sql, params);
          },
          release() { raw.release(); },
        };
      },
      query(...args) { return rawPool.query(...args); },
    };

    const fixture = loadAuthWithPool(pool);
    try {
      const issuePromise = fixture.auth.createPinToken(profileId);
      await issuanceHasProfile.promise;
      const consumePromise = fixture.auth.consumePinToken(oldRawToken, '246810');
      await redemptionSawToken.promise;
      releaseIssuance.resolve();

      const [issued, consumed] = await Promise.allSettled([issuePromise, consumePromise]);
      assert.equal(issued.status, 'fulfilled');
      assert.equal(consumed.status, 'rejected');
      assert.equal(consumed.reason?.code, 'token-invalid');
      assert.notEqual(consumed.reason?.code, '40P01');

      const tokenRows = await rawPool.query(
        `select count(*)::int as n from pin_reset_tokens where profile_id=$1 and used_at is null and expires_at > now()`,
        [profileId]
      );
      assert.equal(tokenRows.rows[0].n, 1, 'only the newly issued reset token remains usable');

      const firstIdentity = await fixture.auth.setPin(profileId, '246810');
      assert.equal(firstIdentity.sessionVersion, 1);
      await assert.rejects(
        () => fixture.auth.setPin(profileId, '864209', null, 0),
        err => err?.code === 'session-stale'
      );
      const stillOld = await fixture.auth.verifyPin(profileId, '246810');
      assert.equal(stillOld.ok, true);
      assert.equal(stillOld.identity.sessionVersion, 1);
    } finally {
      fixture.restore();
    }
  } finally {
    await rawPool.end().catch(() => {});
    await root.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    await root.end().catch(() => {});
  }
});
