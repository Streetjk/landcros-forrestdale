// supabase/tests/auth-db.test.mjs
//
// End-to-end proof of auth-db.js against the LIVE Supabase project: domain
// allowlisting, profile creation + contact-match access policy, RLS
// enforcement via withClaims (impersonated claims on the server's pg
// connection), admin approval of pending profiles, and session token
// sign/verify. Self-cleaning: everything created here is torn down in
// `finally`, regardless of pass/fail.
//
// Run:
//   set -a; . ./.env; set +a; node supabase/tests/auth-db.test.mjs

import { createClient } from '@supabase/supabase-js';
import authDb from '../../auth-db.js';

const {
  emailAllowed,
  checkProfile,
  createProfile,
  listPendingProfiles,
  approveProfile,
  withClaims,
  signSession,
  verifySession,
} = authDb;

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

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const NOBODY_EMAIL = `nobody-${Date.now()}@hcma.com.au`;
let contactEmail = null;
let contactSiteId = null;
let activeProfileId = null;
let pendingProfileId = null;
let landcrosSiteId = null;

async function main() {
  try {
    // ── 0. Resolve the landcros site, and a real landcros contact email to
    // use as the "known contact" case. Login/profiles are scoped to landcros
    // only (AUTH_SITE_SLUG) — greenfields shares an inherited, byte-identical
    // contact list, which is exactly the ambiguity this test must rule out.
    const { data: landcros, error: landcrosErr } = await admin
      .from('sites')
      .select('id')
      .eq('slug', 'landcros')
      .single();
    if (landcrosErr) throw new Error(`setup: landcros site lookup failed: ${landcrosErr.message}`);
    landcrosSiteId = landcros.id;
    contactSiteId = landcrosSiteId;

    const { data: contactRows, error: contactErr } = await admin
      .from('contacts')
      .select('email')
      .eq('site_id', landcrosSiteId)
      .not('email', 'is', null)
      .neq('email', '')
      .limit(1);
    if (contactErr) throw new Error(`setup: contacts lookup failed: ${contactErr.message}`);
    if (!contactRows.length) throw new Error('setup: no landcros contacts with an email exist — cannot run test');
    contactEmail = contactRows[0].email;
    console.log(`setup: using known landcros contact ${contactEmail}`);

    const { data: otherSiteMatches, error: otherErr } = await admin
      .from('contacts')
      .select('site_id')
      .eq('email', contactEmail)
      .neq('site_id', landcrosSiteId);
    if (otherErr) throw new Error(`setup: cross-site contact lookup failed: ${otherErr.message}`);
    console.log(
      otherSiteMatches.length
        ? `setup: ${contactEmail} ALSO appears as a contact on ${otherSiteMatches.length} other site(s) — good, this proves scoping`
        : `setup: ${contactEmail} has no other-site contact rows (scoping still tested, just not by ambiguity)`
    );

    // Clean up any leftover state from a prior aborted run.
    await _cleanupEmail(contactEmail);
    await _cleanupEmail(NOBODY_EMAIL);

    // ── 1. emailAllowed ──────────────────────────────────────────────────
    assert(emailAllowed('y@hcma.com.au') === true, '1a. emailAllowed accepts y@hcma.com.au');
    assert(emailAllowed('x@gmail.com') === false, '1b. emailAllowed rejects x@gmail.com');

    // ── 2. createProfile(known contact) → active + membership ──────────
    const activeResult = await createProfile(contactEmail);
    activeProfileId = activeResult.profileId;
    assert(activeResult.status === 'active', '2a. createProfile(known contact) → status active', `got ${activeResult.status}`);

    {
      const { data, error } = await admin
        .from('site_members')
        .select('site_id,role')
        .eq('user_id', activeProfileId);
      assert(
        !error && data?.length === 1 && data[0].site_id === landcrosSiteId && data[0].role === 'editor',
        '2b. exactly ONE site_members editor row, scoped to landcros only (not greenfields, even though the email is a contact there too)',
        error ? error.message : `rows=${JSON.stringify(data)}`
      );
    }

    {
      const rows = await withClaims(activeProfileId, contactEmail, (client) =>
        client.query('select id from contacts where site_id = $1', [contactSiteId]).then((r) => r.rows)
      );
      assert(rows.length > 0, '2c. withClaims(active member) sees contacts (RLS grants access)', `length=${rows.length}`);
    }

    // ── 3. createProfile(non-contact) → pending, no membership ──────────
    const pendingResult = await createProfile(NOBODY_EMAIL);
    pendingProfileId = pendingResult.profileId;
    assert(pendingResult.status === 'pending', '3a. createProfile(non-contact) → status pending', `got ${pendingResult.status}`);

    {
      const { data, error } = await admin
        .from('site_members')
        .select('site_id')
        .eq('user_id', pendingProfileId);
      assert(!error && data?.length === 0, '3b. no site_members row for pending profile', error ? error.message : `length=${data?.length}`);
    }

    {
      const rows = await withClaims(pendingProfileId, NOBODY_EMAIL, (client) =>
        client.query('select id from contacts where site_id = $1', [contactSiteId]).then((r) => r.rows)
      );
      assert(rows.length === 0, '3c. withClaims(non-member) sees 0 contacts (RLS denies)', `length=${rows.length}`);
    }

    {
      const { status } = await checkProfile(NOBODY_EMAIL);
      assert(status === 'pending', '3d. checkProfile(pending email) reports pending', `got ${status}`);
    }

    {
      const pendingList = await listPendingProfiles();
      assert(
        pendingList.some((p) => p.id === pendingProfileId),
        '3e. listPendingProfiles includes the pending profile'
      );
    }

    // ── 4. approveProfile → active + membership ─────────────────────────
    await approveProfile(pendingProfileId, landcrosSiteId, 'editor');
    {
      const { status } = await checkProfile(NOBODY_EMAIL);
      assert(status === 'active', '4a. checkProfile after approve → active', `got ${status}`);
    }
    {
      const { data, error } = await admin
        .from('site_members')
        .select('role')
        .eq('site_id', landcrosSiteId)
        .eq('user_id', pendingProfileId)
        .maybeSingle();
      assert(!error && data?.role === 'editor', '4b. site_members editor row created by approveProfile', error ? error.message : `row=${JSON.stringify(data)}`);
    }
    {
      const rows = await withClaims(pendingProfileId, NOBODY_EMAIL, (client) =>
        client.query('select id from contacts where site_id = $1', [landcrosSiteId]).then((r) => r.rows)
      );
      assert(Array.isArray(rows), '4c. withClaims(newly-approved member) query succeeds', `rows=${JSON.stringify(rows)}`);
    }

    // ── 5. session sign/verify ───────────────────────────────────────────
    {
      const token = signSession({ profileId: activeProfileId, email: contactEmail });
      const verified = verifySession(token);
      assert(
        !!verified && verified.profileId === activeProfileId && verified.email === contactEmail,
        '5a. signSession/verifySession round-trips',
        `verified=${JSON.stringify(verified)}`
      );

      const tampered = token.slice(0, -2) + (token.slice(-2) === 'AA' ? 'BB' : 'AA');
      assert(verifySession(tampered) === null, '5b. tampered token → null');

      const expiredPayload = Buffer.from(
        JSON.stringify({ profileId: activeProfileId, email: contactEmail, exp: Date.now() - 1000 }),
        'utf8'
      );
      const payloadB64 = expiredPayload.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      // Re-sign this expired payload the same way signSession would, then verify it's still rejected for being expired.
      const crypto = await import('node:crypto');
      const sig = crypto
        .createHmac('sha256', process.env.SESSION_SECRET)
        .update(payloadB64)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      assert(verifySession(`${payloadB64}.${sig}`) === null, '5c. expired token → null');
    }
  } catch (err) {
    fail('unexpected exception', err.message);
    console.error(err);
  } finally {
    console.log('cleanup: starting...');
    await _cleanupEmail(contactEmail);
    await _cleanupEmail(NOBODY_EMAIL);

    const { data: leftoverProfiles, error: leftoverErr } = await admin
      .from('profiles')
      .select('id,email')
      .in('email', [contactEmail, NOBODY_EMAIL].filter(Boolean));
    assert(
      !leftoverErr && leftoverProfiles?.length === 0,
      'cleanup: no leftover profiles rows',
      leftoverErr ? leftoverErr.message : `found=${JSON.stringify(leftoverProfiles)}`
    );

    const { data: allUsers, error: allUsersErr } = await admin.auth.admin.listUsers();
    const stillThereEmails =
      !allUsersErr && allUsers.users.filter((u) => [contactEmail, NOBODY_EMAIL].includes(u.email)).map((u) => u.email);
    assert(
      !allUsersErr && stillThereEmails.length === 0,
      'cleanup: no leftover temp auth users',
      allUsersErr ? allUsersErr.message : `still present=${JSON.stringify(stillThereEmails)}`
    );

    const { data: leftoverMembers, error: leftoverMembersErr } = await admin
      .from('site_members')
      .select('site_id,user_id')
      .in('user_id', [activeProfileId, pendingProfileId].filter(Boolean));
    assert(
      !leftoverMembersErr && leftoverMembers?.length === 0,
      'cleanup: no leftover site_members rows',
      leftoverMembersErr ? leftoverMembersErr.message : `found=${JSON.stringify(leftoverMembers)}`
    );
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

// Deletes profiles + site_members + the auth user for a given email, if present.
async function _cleanupEmail(email) {
  if (!email) return;
  const { data: users, error: listErr } = await admin.auth.admin.listUsers();
  if (listErr) {
    console.log(`cleanup: listUsers failed for ${email}: ${listErr.message}`);
    return;
  }
  const user = users.users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
  if (!user) return;

  const { error: memberErr } = await admin.from('site_members').delete().eq('user_id', user.id);
  if (memberErr) console.log(`cleanup: delete site_members for ${email} failed: ${memberErr.message}`);

  const { error: profileErr } = await admin.from('profiles').delete().eq('id', user.id);
  if (profileErr) console.log(`cleanup: delete profile for ${email} failed: ${profileErr.message}`);

  const { error: userErr } = await admin.auth.admin.deleteUser(user.id);
  if (userErr) console.log(`cleanup: deleteUser ${email} failed: ${userErr.message}`);
}

main();
