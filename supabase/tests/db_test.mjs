// supabase/tests/db_test.mjs
//
// End-to-end proof of supabase/db.mjs against the LIVE Supabase project:
// auth (real user sign-in), RLS (editor can write own site, anon cannot,
// cross-tenant reads return nothing), and the privileged service-role visit
// counter. Self-cleaning: everything created here is torn down in `finally`.
//
// Run:
//   set -a; . ./.env; set +a; node supabase/tests/db_test.mjs

import crypto from 'node:crypto';
import {
  browserClient,
  serverClient,
  listPoints,
  savePoint,
  listContacts,
  getSite,
  recordVisit,
} from '../db.mjs';

const TEST_EMAIL = 'dbtest@hcma.com.au';
const TEST_SLUG = `zz-dbtest-${Date.now()}`;
const TEST_PASSWORD = crypto.randomBytes(18).toString('hex');

let failures = 0;

function pass(label) {
  console.log(`PASS ${label}`);
}

function fail(label, detail) {
  failures += 1;
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

function assert(cond, label, detail) {
  if (cond) pass(label);
  else fail(label, detail);
  return cond;
}

async function main() {
  const admin = serverClient();

  let tempSiteId = null;
  let tempUserId = null;
  let tempPointId = null;

  try {
    // ── 1. SETUP ──────────────────────────────────────────────────────────
    // Clean up any leftover user from a prior aborted run.
    const { data: existingUsers, error: listUsersErr } = await admin.auth.admin.listUsers();
    if (listUsersErr) throw new Error(`setup: listUsers failed: ${listUsersErr.message}`);
    const leftover = existingUsers.users.find((u) => u.email === TEST_EMAIL);
    if (leftover) {
      await admin.auth.admin.deleteUser(leftover.id);
    }

    const { data: site, error: siteErr } = await admin
      .from('sites')
      .insert({ slug: TEST_SLUG, name: 'DBTEST', published: false })
      .select()
      .single();
    if (siteErr) throw new Error(`setup: create temp site failed: ${siteErr.message}`);
    tempSiteId = site.id;
    console.log(`setup: created temp site ${TEST_SLUG} (${tempSiteId})`);

    const { data: userRes, error: userErr } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (userErr) throw new Error(`setup: createUser failed: ${userErr.message}`);
    tempUserId = userRes.user.id;
    console.log(`setup: created temp user ${TEST_EMAIL} (${tempUserId})`);

    const { error: memberErr } = await admin
      .from('site_members')
      .insert({ site_id: tempSiteId, user_id: tempUserId, role: 'editor' });
    if (memberErr) throw new Error(`setup: site_members insert failed: ${memberErr.message}`);
    console.log('setup: granted editor membership');

    // ── 2. SIGN IN as the temp user to get a real JWT ───────────────────────
    const anonForSignIn = browserClient();
    const { data: signInData, error: signInErr } = await anonForSignIn.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    if (signInErr) throw new Error(`setup: signInWithPassword failed: ${signInErr.message}`);
    const accessToken = signInData.session.access_token;
    console.log('setup: signed in, got access token');

    // Fetch the real landcros site id (admin) for the cross-tenant check.
    const { data: landcros, error: landcrosErr } = await getSite(admin, 'landcros');
    if (landcrosErr) throw new Error(`setup: getSite('landcros') failed: ${landcrosErr.message}`);
    const landcrosId = landcros.id;
    console.log(`setup: real landcros site id = ${landcrosId} (published=${landcros.published})`);

    // ── 3. ASSERTIONS as the authenticated member ──────────────────────────
    const member = browserClient(accessToken);

    {
      const { data, error } = await listPoints(member, tempSiteId);
      assert(!error && Array.isArray(data), 'a. member listPoints(tempSite) succeeds', error?.message);
    }

    {
      const { data, error } = await savePoint(member, {
        site_id: tempSiteId,
        label: 't',
        type: 'drop-off',
        scope: 'shared',
      });
      if (assert(!error && data?.id, 'b. member savePoint(tempSite) succeeds', error?.message)) {
        tempPointId = data.id;
      }
    }

    {
      const { data, error } = await listPoints(member, tempSiteId);
      assert(!error && data?.length === 1, 'c. member listPoints(tempSite) now length 1', error ? error.message : `length=${data?.length}`);
    }

    {
      const { data, error } = await listPoints(member, landcrosId);
      assert(!error && data?.length === 0, 'd. member listPoints(landcros) returns 0 rows (cross-tenant isolation)', error ? error.message : `length=${data?.length}`);
    }

    // ── 4. ASSERTIONS as anon (no token) ────────────────────────────────────
    const anon = browserClient();

    {
      const { data, error } = await savePoint(anon, {
        site_id: tempSiteId,
        label: 'anon-should-fail',
        type: 'drop-off',
        scope: 'shared',
      });
      assert(!!error && !data, 'e. anon savePoint(tempSite) rejected by RLS', error ? undefined : 'expected an error, got success');
    }

    {
      const { data, error } = await listContacts(anon, tempSiteId);
      assert(!error && data?.length === 0, 'f. anon listContacts(tempSite) returns 0 rows (unpublished)', error ? error.message : `length=${data?.length}`);
    }

    // ── 5. PRIVILEGED: recordVisit via service role ─────────────────────────
    {
      const { error } = await recordVisit(admin, tempSiteId, tempPointId);
      assert(!error, 'g. recordVisit(serverClient) succeeds', error?.message);
    }

    {
      const { data, error } = await admin
        .from('visits')
        .select('count')
        .eq('site_id', tempSiteId)
        .is('point_id', null)
        .single();
      assert(!error && data?.count === 1, 'h. site-total visits row incremented', error ? error.message : `count=${data?.count}`);
    }
  } catch (err) {
    fail('unexpected exception', err.message);
    console.error(err);
  } finally {
    // ── 6. CLEANUP ──────────────────────────────────────────────────────────
    console.log('cleanup: starting...');
    if (tempPointId) {
      const { error } = await admin.from('points').delete().eq('id', tempPointId);
      if (error) console.log(`cleanup: delete point failed: ${error.message}`);
    }
    if (tempSiteId && tempUserId) {
      const { error } = await admin
        .from('site_members')
        .delete()
        .eq('site_id', tempSiteId)
        .eq('user_id', tempUserId);
      if (error) console.log(`cleanup: delete site_members failed: ${error.message}`);
    }
    if (tempSiteId) {
      const { error } = await admin.from('sites').delete().eq('id', tempSiteId);
      if (error) console.log(`cleanup: delete site failed: ${error.message}`);
    }
    if (tempUserId) {
      const { error } = await admin.auth.admin.deleteUser(tempUserId);
      if (error) console.log(`cleanup: deleteUser failed: ${error.message}`);
    }

    // Verify cleanup left nothing behind.
    const { data: leftoverSites, error: leftoverSitesErr } = await admin
      .from('sites')
      .select('id,slug')
      .like('slug', 'zz-dbtest%');
    assert(
      !leftoverSitesErr && leftoverSites?.length === 0,
      'cleanup: no leftover zz-dbtest* sites',
      leftoverSitesErr ? leftoverSitesErr.message : `found=${JSON.stringify(leftoverSites)}`
    );

    const { data: allUsers, error: allUsersErr } = await admin.auth.admin.listUsers();
    const stillThere = !allUsersErr && allUsers.users.some((u) => u.email === TEST_EMAIL);
    assert(!allUsersErr && !stillThere, 'cleanup: no leftover dbtest@hcma.com.au user', allUsersErr ? allUsersErr.message : 'user still present');
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
