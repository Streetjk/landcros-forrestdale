import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function scopedMigration(path, schema) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replaceAll('schema public', `schema ${schema}`)
    .replaceAll('public.', `${schema}.`);
}

test('0020 closes direct browser staff access while preserving exact public projections', {
  skip: !process.env.SITENAV_TEST_DATABASE_URL,
  timeout: 30000,
}, async () => {
  const base = new URL(process.env.SITENAV_TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  assert.equal(base.pathname, '/sitenav_test');
  assert.equal(base.username, 'sitenav_test');

  const schema = 'test_boundary_' + randomUUID().replaceAll('-', '');
  const root = new Client({ connectionString: base.href });
  const scoped = new URL(base);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const sql = new Client({ connectionString: scoped.href });
  const createdRoles = [];
  await root.connect();
  try {
    const existingRoles = new Set((await root.query(
      "select rolname from pg_roles where rolname in ('anon','authenticated','service_role')",
    )).rows.map(row => row.rolname));
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (existingRoles.has(role)) continue;
      await root.query(`create role ${role} nologin`);
      createdRoles.push(role);
    }
    await root.query(`create schema ${schema}`);
    await sql.connect();
    await sql.query(`
      create type site_role as enum ('viewer','editor','admin','owner');
      create table sites(id uuid primary key,slug text,name text,title text,address text,logo text,published boolean);
      create table profiles(id uuid primary key,email text,display_name text,status text,created_at timestamptz default now());
      create table points(id uuid primary key,site_id uuid,label text,type text,scope text,latlng jsonb,position3d jsonb,
        notes text,contact_ids uuid[] default '{}',route_waypoints jsonb,route_waypoints3d jsonb,camera_preset3d jsonb,
        building_ref text,scene_id uuid);
      create table contacts(id uuid primary key,site_id uuid,name text,role text,phone text,active boolean,
        email text,created_by text,created_at timestamptz default now());
      create table scenes(id uuid); create table scene_objects(id uuid); create table site_members(id uuid);
      create table my_pin_capabilities(id uuid); create table point_photos(id uuid); create table submissions(id uuid);
      create table events(id uuid); create table webhooks(id uuid); create table profile_pins(id uuid);
      create table pin_reset_tokens(id uuid); create sequence existing_seq;
      create function is_site_member(uuid,site_role) returns boolean language sql stable security definer as $$ select false $$;
      create function contact_is_base_visible(cid uuid,sid uuid) returns boolean language sql stable security definer as $$
        select exists(select 1 from points p where p.site_id=sid and p.scene_id is null and p.scope='shared' and cid=any(p.contact_ids))
      $$;
      create function increment_visit(uuid,uuid) returns void language plpgsql security definer as $$ begin return; end $$;
    `);
    await sql.query(`
      alter table sites enable row level security;
      alter table points enable row level security;
      alter table contacts enable row level security;
      alter table profiles enable row level security;
      create policy sites_public on sites for select using (published);
      create policy points_public on points for select using (
        scene_id is null and scope='shared'
        and exists(select 1 from sites s where s.id=site_id and s.published)
      );
      create policy contacts_public on contacts for select using (
        active and exists(select 1 from sites s where s.id=site_id and s.published)
        and contact_is_base_visible(id,site_id)
      );
      create policy profiles_self on profiles for select to authenticated
        using (id::text=current_setting('sitenav.uid',true));
      grant usage on schema ${schema} to anon,authenticated,service_role;
      grant all privileges on all tables in schema ${schema} to anon,authenticated;
      grant all privileges on all sequences in schema ${schema} to anon,authenticated;
      grant execute on all functions in schema ${schema} to public,anon,authenticated;
      alter default privileges in schema ${schema} grant all privileges on tables to anon,authenticated;
      alter default privileges in schema ${schema} grant all privileges on sequences to anon,authenticated;
      alter default privileges in schema ${schema} grant execute on functions to anon,authenticated;
    `);

    await sql.query(scopedMigration('../supabase/migrations/0019_auth_session_revocation.sql', schema));
    await sql.query(scopedMigration('../supabase/migrations/0020_browser_boundary.sql', schema));

    const published = uid(1), unpublished = uid(2), pointPublic = uid(3), pointPrivate = uid(4);
    const contactPublic = uid(5), contactPrivate = uid(6), self = uid(11), other = uid(12);
    await sql.query(
      `insert into sites values
       ($1,'alpha','Alpha','Guide','107 Test Rd','/logo.png',true),
       ($2,'beta','Beta','Private','1 Hidden Rd','/logo.png',false)`,
      [published, unpublished],
    );
    await sql.query(
      `insert into points(id,site_id,label,type,scope,contact_ids,route_waypoints,route_waypoints3d,scene_id)
       values ($1,$2,'Gate','drop-off','shared',$3,'[]','[]',null),
              ($4,$2,'Personal','drop-off','personal',$5,'[]','[]',null)`,
      [pointPublic, published, [contactPublic], pointPrivate, [contactPrivate]],
    );
    await sql.query(
      `insert into contacts(id,site_id,name,role,phone,active,email) values
       ($1,$2,'Reception','staff','0800000000',true,'public-secret@example.test'),
       ($3,$2,'Private','staff','0899999999',true,'private@example.test')`,
      [contactPublic, published, contactPrivate],
    );
    await sql.query(
      `insert into profiles(id,email,display_name,status) values
       ($1,'self@example.test','Self','active'),($2,'other@example.test','Other','active')`,
      [self, other],
    );

    await sql.query('begin');
    await sql.query('set local role anon');
    assert.deepEqual(
      (await sql.query('select id,slug,name,title,address,logo,published from sites order by slug')).rows.map(r => r.slug),
      ['alpha'],
    );
    assert.deepEqual(
      (await sql.query('select id,site_id,label,type,scope,latlng,position3d,notes,contact_ids,route_waypoints,route_waypoints3d,camera_preset3d,building_ref from points')).rows.map(r => r.label),
      ['Gate'],
    );
    assert.deepEqual(
      (await sql.query('select id,site_id,name,role,phone,active from contacts')).rows.map(r => r.name),
      ['Reception'],
    );
    await sql.query('rollback');

    async function expectDenied(role, statement) {
      await sql.query('begin');
      await sql.query(`set local role ${role}`);
      try {
        await assert.rejects(sql.query(statement), error => error?.code === '42501');
      } finally {
        await sql.query('rollback');
      }
    }
    await expectDenied('anon', 'select * from contacts');
    await expectDenied('anon', 'insert into submissions default values');

    await sql.query('begin');
    await sql.query('set local role authenticated');
    await sql.query(`set local "sitenav.uid"='${self}'`);
    const own = await sql.query('select id,email,display_name,status,created_at from profiles');
    assert.deepEqual(own.rows.map(r => r.id), [self]);
    await sql.query('rollback');
    await expectDenied('authenticated', 'select session_version from profiles');

    const actors = [uid(11), uid(12), uid(13), uid(14), uid(15), uid(16)];
    const staffTables = [
      'scenes','scene_objects','points','contacts','site_members','my_pin_capabilities',
      'point_photos','submissions','events','webhooks','profile_pins','pin_reset_tokens',
    ];
    for (const actor of actors) {
      assert.ok(actor);
      for (const table of staffTables) {
        for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) {
          const q = await sql.query(
            'select has_table_privilege($1,$2,$3) as ok',
            ['authenticated', `${schema}.${table}`, privilege],
          );
          assert.equal(q.rows[0].ok, false, `${actor} must not get ${privilege} on ${table}`);
        }
      }
    }

    const canExec = async (role, signature) => (await sql.query(
      'select has_function_privilege($1,$2,$3) as ok',
      [role, `${schema}.${signature}`, 'EXECUTE'],
    )).rows[0].ok;
    assert.equal(await canExec('anon', `is_site_member(uuid,${schema}.site_role)`), true);
    assert.equal(await canExec('authenticated', `is_site_member(uuid,${schema}.site_role)`), false);
    assert.equal(await canExec('anon', 'contact_is_base_visible(uuid,uuid)'), true);
    assert.equal(await canExec('authenticated', 'contact_is_base_visible(uuid,uuid)'), false);
    assert.equal(await canExec('anon', 'increment_visit(uuid,uuid)'), false);
    assert.equal(await canExec('authenticated', 'increment_visit(uuid,uuid)'), false);
    assert.equal(await canExec('service_role', 'increment_visit(uuid,uuid)'), true);

    await sql.query(`
      create table future_table(id bigint);
      create sequence future_seq;
      create function future_fn() returns int language sql as $$ select 1 $$;
    `);
    for (const role of ['anon','authenticated']) {
      assert.equal((await sql.query(
        'select has_table_privilege($1,$2,$3) as ok',
        [role, `${schema}.future_table`, 'SELECT'],
      )).rows[0].ok, false);
      assert.equal((await sql.query(
        'select has_sequence_privilege($1,$2,$3) as ok',
        [role, `${schema}.future_seq`, 'USAGE'],
      )).rows[0].ok, false);
      assert.equal(await canExec(role, 'future_fn()'), false);
    }
  } finally {
    await sql.end().catch(() => {});
    await root.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    for (const role of createdRoles.reverse()) {
      await root.query(`drop role if exists ${role}`).catch(() => {});
    }
    await root.end().catch(() => {});
  }
});
