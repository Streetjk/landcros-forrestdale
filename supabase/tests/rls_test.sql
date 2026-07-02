\set ON_ERROR_STOP on
\set A '11111111-1111-1111-1111-111111111111'
\set B '22222222-2222-2222-2222-222222222222'
\set C '33333333-3333-3333-3333-333333333333'
\set SITEA 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set SITEB 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

-- ── Emulate the Supabase runtime (auth schema, auth.uid(), roles) ────────────
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;

-- ── Apply the real migrations under test ─────────────────────────────────────
\i /Users/ollama/src/sitenav/landcros-forrestdale/supabase/migrations/0001_schema.sql
\i /Users/ollama/src/sitenav/landcros-forrestdale/supabase/migrations/0002_rls.sql
\i /Users/ollama/src/sitenav/landcros-forrestdale/supabase/migrations/0003_auth_domain.sql

-- ── Mirror Supabase's default table grants (RLS, not grants, is what we test) ─
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

-- ── Seed (as superuser → bypasses RLS; also exercises the owner trigger) ─────
-- Corporate accounts (@hcma.com.au) + one external account (@gmail.com) for the domain guard.
\set D '44444444-4444-4444-4444-444444444444'
insert into auth.users values
  (:'A','a@hcma.com.au'), (:'B','b@hcma.com.au'), (:'C','c@hcma.com.au'), (:'D','d@gmail.com');
insert into sites (id, slug, name, published, created_by) values
  (:'SITEA','site-a','A', true,  :'A'),
  (:'SITEB','site-b','B', false, :'B');
insert into points (site_id,label,type,scope) values
  (:'SITEA','A shared',  'drop-off','shared'),
  (:'SITEA','A personal','drop-off','personal'),
  (:'SITEB','B shared',  'drop-off','shared');
insert into contacts (site_id,name,active) values
  (:'SITEA','Alice',true), (:'SITEB','Bob',true);
-- userC is an ADMIN (not owner) of site A — used for privilege-escalation checks
insert into site_members (site_id,user_id,role) values (:'SITEA', :'C', 'admin');

-- Verify the owner-membership trigger fired for both creators.
do $$ begin
  if (select count(*) from site_members where role='owner') <> 2
    then raise exception 'FAIL trigger: expected 2 owner memberships'; end if;
  raise notice 'PASS: owner-membership trigger';
end $$;

-- ── CHECK 1: authenticated owner of A sees both A points, not B's ────────────
begin;
  select set_config('request.jwt.claim.sub', :'A', true);
  set local role authenticated;
  do $$ begin
    if (select count(*) from points) <> 2
      then raise exception 'FAIL c1: userA should see 2 points, saw %', (select count(*) from points); end if;
    if exists (select 1 from points where label='B shared')
      then raise exception 'FAIL c1: userA leaked into site B'; end if;
    raise notice 'PASS c1: userA sees only site A points';
  end $$;
rollback;

-- ── CHECK 2: anon sees only SHARED points of PUBLISHED sites ─────────────────
begin;
  set local role anon;
  do $$ begin
    if (select count(*) from points) <> 1
      then raise exception 'FAIL c2: anon should see 1 point, saw %', (select count(*) from points); end if;
    if (select label from points) <> 'A shared'
      then raise exception 'FAIL c2: anon saw wrong point'; end if;
    raise notice 'PASS c2: anon sees only published shared points';
  end $$;
rollback;

-- ── CHECK 3: cross-tenant — userB cannot see A's personal/unpublished data ───
begin;
  select set_config('request.jwt.claim.sub', :'B', true);
  set local role authenticated;
  do $$ begin
    -- userB: member of B (1 pt) + public A-shared (1) = 2; must NOT see 'A personal'
    if exists (select 1 from points where label='A personal')
      then raise exception 'FAIL c3: userB leaked A personal point'; end if;
    raise notice 'PASS c3: userB cannot see A personal point';
  end $$;
rollback;

-- ── CHECK 4: userB cannot UPDATE site A's point (not an editor of A) ─────────
begin;
  select set_config('request.jwt.claim.sub', :'B', true);
  set local role authenticated;
  do $$
  declare n int;
  begin
    update points set notes='hacked' where label='A shared';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL c4: userB updated % row(s) in site A (cross-tenant write leak)', n; end if;
    raise notice 'PASS c4: userB blocked from updating A point (0 rows)';
  end $$;
rollback;

-- ── CHECK 5: anon INSERT submission — allowed on published A, blocked on B ───
begin;
  set local role anon;
  insert into submissions (site_id, point_label, status) values (:'SITEA','drop','new');  -- must succeed
  do $$ begin raise notice 'PASS c5a: anon submission to published site allowed'; end $$;
rollback;

begin;
  set local role anon;
  do $$ begin
    begin
      insert into submissions (site_id, point_label, status)
        values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','drop','new');
      raise exception 'FAIL c5b: anon submission to UNPUBLISHED site should be blocked';
    exception when insufficient_privilege or check_violation then
      raise notice 'PASS c5b: anon submission to unpublished site blocked';
    end;
  end $$;
rollback;

-- ── CHECK 6: anon cannot INSERT points (no insert policy) ────────────────────
begin;
  set local role anon;
  do $$ begin
    begin
      insert into points (site_id,label,type,scope)
        values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','evil','drop-off','shared');
      raise exception 'FAIL c6: anon point insert should be blocked';
    exception when insufficient_privilege then
      raise notice 'PASS c6: anon point insert blocked';
    end;
  end $$;
rollback;

-- ── CHECK 7: webhooks are server-only — even an owner cannot insert or read ──
-- 7a: authenticated owner INSERT is blocked (no client policy on webhooks)
begin;
  select set_config('request.jwt.claim.sub', :'A', true);
  set local role authenticated;
  do $$ begin
    begin
      insert into webhooks (site_id,url)
        values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','https://x');
      raise exception 'FAIL c7a: owner webhook insert should be blocked';
    exception when insufficient_privilege then
      raise notice 'PASS c7a: owner cannot insert webhooks (server-only)';
    end;
  end $$;
rollback;

-- 7b: seed a webhook as superuser, then confirm an authenticated owner reads 0 rows
insert into webhooks (site_id,url,secret) values (:'SITEA','https://hook','s3cr3t');
begin;
  select set_config('request.jwt.claim.sub', :'A', true);
  set local role authenticated;
  do $$ begin
    if (select count(*) from webhooks) <> 0
      then raise exception 'FAIL c7b: owner should see 0 webhooks (secret leak), saw %', (select count(*) from webhooks); end if;
    raise notice 'PASS c7b: webhooks unreadable by client (HMAC secret protected)';
  end $$;
rollback;

-- ── CHECK 8: admin cannot self-escalate to owner; owner can promote ──────────
-- 8a: userC (admin of A) tries to promote their own row to owner → blocked
begin;
  select set_config('request.jwt.claim.sub', :'C', true);
  set local role authenticated;
  do $$ begin
    begin
      update site_members set role='owner'
        where site_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
          and user_id='33333333-3333-3333-3333-333333333333';
      raise exception 'FAIL c8a: admin self-escalation to owner should be blocked';
    exception when insufficient_privilege then
      raise notice 'PASS c8a: admin cannot self-promote to owner';
    end;
  end $$;
rollback;

-- 8b: userC (admin) tries to INSERT a brand-new owner membership → blocked
begin;
  select set_config('request.jwt.claim.sub', :'C', true);
  set local role authenticated;
  do $$ begin
    begin
      insert into site_members (site_id,user_id,role)
        values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-2222-2222-222222222222','owner');
      raise exception 'FAIL c8b: admin inserting an owner row should be blocked';
    exception when insufficient_privilege then
      raise notice 'PASS c8b: admin cannot grant owner role';
    end;
  end $$;
rollback;

-- 8c: userA (owner of A) promotes userC to owner → allowed
begin;
  select set_config('request.jwt.claim.sub', :'A', true);
  set local role authenticated;
  do $$
  declare n int;
  begin
    update site_members set role='owner'
      where site_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        and user_id='33333333-3333-3333-3333-333333333333';
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'FAIL c8c: owner should be able to promote (updated % rows)', n; end if;
    raise notice 'PASS c8c: owner can promote a member to owner';
  end $$;
rollback;

-- ── CHECK 9: site creation restricted to @hcma.com.au ────────────────────────
-- 9a: corporate user (userA, a@hcma.com.au) creates a site → allowed
begin;
  select set_config('request.jwt.claim.sub', :'A', true);
  select set_config('request.jwt.claim.email', 'a@hcma.com.au', true);
  set local role authenticated;
  do $$
  declare n int;
  begin
    insert into sites (slug,name,created_by)
      values ('new-corp','Corp Site','11111111-1111-1111-1111-111111111111');
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'FAIL c9a: corporate user should create a site'; end if;
    raise notice 'PASS c9a: @hcma.com.au user can create a site';
  end $$;
rollback;

-- 9b: external user (userD, d@gmail.com) tries to create a site → blocked
begin;
  select set_config('request.jwt.claim.sub', :'D', true);
  select set_config('request.jwt.claim.email', 'd@gmail.com', true);
  set local role authenticated;
  do $$ begin
    begin
      insert into sites (slug,name,created_by)
        values ('evil','Evil Site','44444444-4444-4444-4444-444444444444');
      raise exception 'FAIL c9b: non-corporate user should NOT create a site';
    exception when insufficient_privilege then
      raise notice 'PASS c9b: non-@hcma.com.au user blocked from creating a site';
    end;
  end $$;
rollback;

do $$ begin raise notice '=== ALL RLS CHECKS PASSED ==='; end $$;
