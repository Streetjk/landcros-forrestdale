import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE_A = uid(1), SITE_B = uid(2), OWNER = uid(11), OTHER = uid(12), VIEWER = uid(13), ADMIN = uid(14), OUTSIDER = uid(15);
const SCENE_A = uid(21), SCENE_A2 = uid(22), SCENE_B = uid(23), SCENE_FOREIGN = uid(24), SCENE_LEGACY = uid(25);
const CONTACT_A = uid(31), CONTACT_B = uid(32), CONTACT_PUBLIC = uid(33), CONTACT_SCENE_ONLY = uid(34), CONTACT_UNREFERENCED = uid(35), POINT_A = uid(41), POINT_B = uid(42), POINT_BASE = uid(43), PHOTO = uid(51);
const payload = (id = POINT_A, extra = {}) => ({ id, label: 'Synthetic fixture pin', position3d: { x: 1, y: 2, z: 3 }, ...extra });

test('scene point ownership: actual PostgreSQL and HTTP server', { skip: !process.env.SITENAV_TEST_DATABASE_URL, timeout: 45000 }, async t => {
  const base = new URL(process.env.SITENAV_TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  assert.equal(base.pathname, '/sitenav_test');
  assert.equal(base.username, 'sitenav_test');
  const schema = 'test_points_' + randomUUID().replaceAll('-', '');
  const root = new Client({ connectionString: base.href });
  const scoped = new URL(base); scoped.searchParams.set('options', `-c search_path=${schema}`);
  const sql = new Client({ connectionString: scoped.href });
  let child, db, sdb;
  let childErrors = '';
  const secret = randomUUID();
  await root.connect();
  try {
    const check = await root.query('select current_database() as db, current_user as usr');
    assert.equal(check.rows[0].db, 'sitenav_test'); assert.equal(check.rows[0].usr, 'sitenav_test');
    await root.query(`create schema ${schema}`);
    await sql.connect();
    // Synthetic schema matching the production columns/constraints used here.
    // This does not run production migrations and does not claim to certify RLS.
    await sql.query(`
      create table sites(id uuid primary key,slug text unique,published boolean default false);
      create table profiles(id uuid primary key,email text,status text default 'active');
      create table site_members(site_id uuid,user_id uuid,role text,primary key(site_id,user_id));
      create table scenes(id uuid primary key default gen_random_uuid(),site_id uuid references sites(id),created_by uuid references profiles(id),
        kind text default 'admin',status text default 'open',share_code text unique,name text,
        camera jsonb,status_changed_at timestamptz,status_changed_by uuid,created_at timestamptz default now(),updated_at timestamptz default now(),
        unique(site_id,id));
      create table scene_subscriptions(scene_id uuid,profile_id uuid,primary key(scene_id,profile_id));
      create table scripts(id uuid primary key,site_id uuid,source text);
      create table scene_objects(id uuid primary key,site_id uuid,scene_id uuid,script_id uuid,
        z_index integer,created_at timestamptz default now());
      create table contacts(id uuid primary key,site_id uuid references sites(id),name text,role text,phone text,email text,
        active boolean default true,created_by text,created_at timestamptz default now());
      create table points(id uuid primary key,site_id uuid not null references sites(id),scene_id uuid,
        label text not null,type text not null default 'drop-off',scope text not null default 'shared',
        latlng jsonb,position3d jsonb,notes text,contact_ids uuid[] not null default '{}',
        route_waypoints jsonb not null default '[]',route_waypoints3d jsonb not null default '[]',camera_preset3d jsonb,
        building_ref text,phone_override text,created_by text,created_at timestamptz default now(),updated_at timestamptz default now(),
        foreign key(site_id,scene_id) references scenes(site_id,id) on delete cascade);
      create table audit_log(id bigserial primary key,site_id uuid,changed_by uuid,action text,entity_type text,entity_id uuid,entity_label text,
        constraint fixture_audit check(entity_label <> 'TEST_FAIL_AUDIT'));
      create table point_photos(id uuid primary key,site_id uuid,point_id uuid references points(id) on delete cascade,
        storage_path text,original_path text,original_name text,content_type text,bytes integer,original_bytes integer,
        width integer,height integer,created_by uuid,expires_at timestamptz,created_at timestamptz default now());
      create table my_pin_capabilities(id uuid primary key default gen_random_uuid(),site_id uuid not null references sites(id),
        scene_id uuid not null,point_id uuid not null references points(id) on delete cascade,purpose text not null default 'my-pins-v1',
        token_hash text not null unique,issued_by uuid not null references profiles(id),issued_at timestamptz not null default now(),
        revoked_at timestamptz,revoked_by uuid references profiles(id),rotated_from uuid references my_pin_capabilities(id),
        foreign key(site_id,scene_id) references scenes(site_id,id) on delete cascade);
      create unique index fixture_one_active_my_pin_capability on my_pin_capabilities(point_id) where revoked_at is null;
    `);
    await sql.query('insert into sites(id,slug) values ($1,\'alpha\'),($2,\'beta\')', [SITE_A,SITE_B]);
    for (const [id,email] of [[OWNER,'owner@example.test'],[OTHER,'other@example.test'],[VIEWER,'viewer@example.test'],[ADMIN,'platform@example.test'],[OUTSIDER,'outsider@example.test']]) {
      await sql.query('insert into profiles(id,email) values($1,$2)',[id,email]);
    }
    for (const [site,user,role] of [[SITE_A,OWNER,'editor'],[SITE_A,OTHER,'editor'],[SITE_A,VIEWER,'viewer'],[SITE_B,OTHER,'editor']]) {
      await sql.query('insert into site_members values($1,$2,$3)',[site,user,role]);
    }
    for (const [id,site,owner] of [[SCENE_A,SITE_A,OWNER],[SCENE_A2,SITE_A,OWNER],[SCENE_B,SITE_A,OTHER],[SCENE_FOREIGN,SITE_B,OTHER],[SCENE_LEGACY,SITE_A,null]]) {
      await sql.query('insert into scenes(id,site_id,created_by,share_code,name) values($1,$2,$3,$4,\'Synthetic scene\')',[id,site,owner,id]);
    }
    await sql.query("insert into contacts(id,site_id,name) values($1,$2,'Synthetic A'),($3,$4,'Synthetic B')",[CONTACT_A,SITE_A,CONTACT_B,SITE_B]);
    process.env.SUPABASE_DB_URL = scoped.href;
    sdb = require('../supabase-db'); db = require('../scene-points-db');
    child = fork(fileURLToPath(new URL('./helpers/point-http-server.cjs', import.meta.url)), [], {
      env: { PATH: process.env.PATH, SITENAV_TEST_DATABASE_URL: scoped.href, SITENAV_TEST_SESSION_KEY: secret },
      stdio: ['ignore','pipe','pipe','ipc'],
    });
    child.stderr.on('data', d => { childErrors += d.toString(); });
    child.stdout.resume();
    const address = await Promise.race([once(child,'message').then(([m]) => m), new Promise((_,reject) => { const timer=setTimeout(()=>reject(new Error('Fixture server did not start')),8000);timer.unref(); })]);
    const origin = `http://127.0.0.1:${address.port}`;
    const token = (id, email = id === ADMIN ? 'platform@example.test' : 'fixture@example.test') => {
      const data=Buffer.from(JSON.stringify({profileId:id,email,exp:Date.now()+60000})).toString('base64url');
      return `${data}.${createHmac('sha256',secret).update(data).digest('base64url')}`;
    };
    const route = (scene=SCENE_A,point='',site='alpha') => `/api/sites/${site}/scenes/${scene}/points${point ? '/'+point : ''}`;
    async function request(path, { method='GET', actor=OWNER, body, raw, binary, createOnly = false, bearer = null } = {}) {
      const headers={}; if(createOnly) headers['If-None-Match']='*'; if(actor)headers.Cookie=`sn_session=${token(actor)}`;
      if(bearer) headers.Authorization=`Bearer ${bearer}`;
      if(body !== undefined || raw !== undefined) headers['Content-Type']='application/json';
      if(binary) headers['Content-Type']='application/octet-stream';
      const res=await fetch(origin+path,{method,headers,body:binary || raw || (body === undefined ? undefined : JSON.stringify(body)),signal:AbortSignal.timeout(4000)});
      const text=await res.text(); let parsed=text;
      if(text){ try { parsed=JSON.parse(text); } catch (_) {} }
      return {status:res.status,headers:res.headers,body:parsed};
    }
    const count = async (table) => Number((await sql.query(`select count(*) as n from ${table}`)).rows[0].n);
    let myPinsSceneId = null, myPinsShareCode = null;
    const myPinsPointId = uid(78);
    await t.test('anonymous, wrong owner, viewer and non-member are denied before any write', async () => {
      for(const actor of [null,OTHER,VIEWER,OUTSIDER]) {
        for(const method of ['GET','POST','DELETE']) {
          const res=await request(route(SCENE_A,method==='DELETE'?POINT_A:''),{actor,method,body:method==='POST'?payload():undefined});
          assert.equal(res.status,actor?403:401,JSON.stringify({actor,method,res}));
        }
      }
      assert.equal(await count('points'),0);assert.equal(await count('audit_log'),0);
    });
    await t.test('owner create uses authenticated author, path scene and finite position', async () => {
      const res=await request(route(),{method:'POST',body:payload(POINT_A,{createdBy:OTHER,siteId:SITE_B,contactIds:[CONTACT_A]})});
      assert.equal(res.status,200);assert.equal(res.body.createdBy,OWNER);assert.equal(res.body.sceneId,SCENE_A);
      assert.deepEqual(res.body.position3d,{x:1,y:2,z:3});
      assert.equal((await sql.query('select changed_by from audit_log where entity_id=$1',[POINT_A])).rows[0].changed_by,OWNER);
    });
    await t.test('personal point remains inaccessible to another site editor after it exists', async () => {
      const before=await sql.query('select label,created_by,scene_id from points where id=$1',[POINT_A]);
      assert.equal((await request(route(),{actor:OTHER})).status,403);
      assert.equal((await request(route(),{method:'POST',actor:OTHER,body:payload(POINT_A,{label:'Hijack attempt'})})).status,403);
      assert.equal((await request(route(SCENE_A,POINT_A),{method:'DELETE',actor:OTHER})).status,403);
      const after=await sql.query('select label,created_by,scene_id from points where id=$1',[POINT_A]);
      assert.deepEqual(after.rows,before.rows);
    });
    await t.test('staff contact dropdown requires editor access and remains site-scoped', async () => {
      for (const actor of [null,VIEWER,OUTSIDER]) {
        const result=await request('/api/sites/alpha/contacts',{actor});
        assert.equal(result.status,actor?403:401);
      }
      const own=await request('/api/sites/alpha/contacts');
      assert.equal(own.status,200);assert.equal(own.headers.get('cache-control'),'no-store');
      assert.deepEqual(own.body.map(c=>c.id),[CONTACT_A]);
      const otherSite=await request('/api/sites/beta/contacts',{actor:OTHER});
      assert.deepEqual(otherSite.body.map(c=>c.id),[CONTACT_B]);
      assert.equal((await request('/api/sites/beta/contacts')).status,403);
    });
    await t.test('anonymous public contacts expose only base-pin references and strip staff metadata', async () => {
      const publicPoint = uid(44), sceneOnlyPoint = uid(45);
      try {
        await sql.query(
          `insert into contacts(id,site_id,name,role,phone,email,created_by) values
             ($1,$4,'Synthetic public','Reception','0000 0000','public@example.invalid','fixture'),
             ($2,$4,'Synthetic scene only','Workshop','1111 1111','scene@example.invalid','fixture'),
             ($3,$4,'Synthetic unreferenced','Office','2222 2222','unreferenced@example.invalid','fixture')`,
          [CONTACT_PUBLIC, CONTACT_SCENE_ONLY, CONTACT_UNREFERENCED, SITE_A]
        );
        await sql.query(
          `insert into points(id,site_id,scene_id,label,position3d,contact_ids) values
             ($1,$3,null,'Synthetic base contact pin','{"x":0,"y":0,"z":0}',array[$4]::uuid[]),
             ($2,$3,$5,'Synthetic scene contact pin','{"x":0,"y":0,"z":0}',array[$6]::uuid[])`,
          [publicPoint, sceneOnlyPoint, SITE_A, CONTACT_PUBLIC, SCENE_A, CONTACT_SCENE_ONLY]
        );

        const publicContacts = await request('/api/contacts', { actor: null });
        assert.equal(publicContacts.status, 200);
        assert.deepEqual(publicContacts.body.map(c => c.id), [CONTACT_PUBLIC]);
        assert.deepEqual(Object.keys(publicContacts.body[0]).sort(), ['active','id','name','phone','role']);
        assert.equal(JSON.stringify(publicContacts.body).includes('example.invalid'), false);

        const staffContacts = await request('/api/sites/alpha/contacts');
        assert.equal(staffContacts.status, 200);
        for (const id of [CONTACT_PUBLIC, CONTACT_SCENE_ONLY, CONTACT_UNREFERENCED]) {
          const contact = staffContacts.body.find(c => c.id === id);
          assert.ok(contact);
          assert.equal(typeof contact.email, 'string');
          assert.ok(Object.hasOwn(contact, 'createdBy'));
          assert.ok(Object.hasOwn(contact, 'createdAt'));
        }
      } finally {
        await sql.query('delete from points where id = any($1::uuid[])', [[publicPoint, sceneOnlyPoint]]);
        await sql.query('delete from contacts where id = any($1::uuid[])', [[CONTACT_PUBLIC, CONTACT_SCENE_ONLY, CONTACT_UNREFERENCED]]);
      }
    });

    await t.test('actual scene create/list supports tagged My Pins workspace rediscovery', async () => {
      const initial=await request('/api/sites/alpha/scenes?kind=admin');assert.equal(initial.status,200);
      assert.equal(initial.body.filter(scene=>scene.camera?.purpose==='my-pins-v1').length,0);
      const created=await request('/api/sites/alpha/scenes',{method:'POST',body:{name:'My pins',kind:'admin',camera:{purpose:'my-pins-v1'}}});
      assert.equal(created.status,200);assert.equal(created.body.createdBy,OWNER);assert.ok(created.body.shareCode);
      myPinsSceneId=created.body.id;myPinsShareCode=created.body.shareCode;
      const listed=await request('/api/sites/alpha/scenes?kind=admin');
      const myScenes=listed.body.filter(scene=>scene.isMine===true && scene.camera?.purpose==='my-pins-v1');
      assert.equal(myScenes.length,1);assert.equal(myScenes[0].id,created.body.id);
      assert.equal((await request(route(created.body.id),{method:'POST',body:payload(uid(78))})).status,200);
      const readback=await request(route(created.body.id));assert.equal(readback.body[0].id,uid(78));
      const otherList=await request('/api/sites/alpha/scenes?kind=admin',{actor:OTHER});
      assert.equal(otherList.body.some(scene=>scene.id===created.body.id),false);
    });
    await t.test('owner-only per-pin capability issue, rotation and revoke are durable', async () => {
      assert.ok(myPinsSceneId);
      const capRoute = (scene = myPinsSceneId, point = myPinsPointId) =>
        `/api/sites/alpha/scenes/${scene}/points/${point}/share-capability`;
      await request(route(myPinsSceneId), { method: 'POST', body: payload(myPinsPointId, { scope: 'shared' }) });

      for (const actor of [OTHER, ADMIN]) {
        const denied = await request(capRoute(), { method: 'POST', actor });
        assert.equal(denied.status, 403, JSON.stringify({ actor, denied }));
      }
      const wrongPurpose = await request(capRoute(SCENE_A, POINT_A), { method: 'POST' });
      assert.equal(wrongPurpose.status, 403);
      const wrongPoint = await request(capRoute(myPinsSceneId, uid(89)), { method: 'POST' });
      assert.equal(wrongPoint.status, 404);

      const first = await request(capRoute(), { method: 'POST' });
      assert.equal(first.status, 200);
      assert.match(first.body.token, /^[A-Za-z0-9_-]{43}$/);
      const firstHash = createHash('sha256').update(first.body.token).digest('hex');
      const firstRow = await sql.query('select token_hash,revoked_at from my_pin_capabilities where id=$1', [first.body.capabilityId]);
      assert.equal(firstRow.rows[0].token_hash, firstHash);
      assert.equal(firstRow.rows[0].token_hash.includes(first.body.token), false);
      assert.equal(firstRow.rows[0].revoked_at, null);

      const second = await request(capRoute(), { method: 'POST' });
      assert.equal(second.status, 200);
      assert.notEqual(second.body.token, first.body.token);
      const activeAfterRotate = await sql.query('select id from my_pin_capabilities where point_id=$1 and revoked_at is null', [myPinsPointId]);
      assert.deepEqual(activeAfterRotate.rows.map(r => r.id), [second.body.capabilityId]);
      assert.notEqual((await sql.query('select revoked_at from my_pin_capabilities where id=$1', [first.body.capabilityId])).rows[0].revoked_at, null);

      const revoked = await request(capRoute(), { method: 'DELETE' });
      assert.equal(revoked.status, 200);
      assert.equal(revoked.body.ok, true);
      assert.equal(revoked.body.revoked, true);
      assert.equal((await sql.query('select count(*)::int as n from my_pin_capabilities where point_id=$1 and revoked_at is null', [myPinsPointId])).rows[0].n, 0);
      const idempotent = await request(capRoute(), { method: 'DELETE' });
      assert.equal(idempotent.status, 200);
      assert.equal(idempotent.body.revoked, false);

      const third = await request(capRoute(), { method: 'POST' });
      assert.equal(third.status, 200);
      await request(route(myPinsSceneId), { method: 'POST', body: payload(myPinsPointId, { scope: 'personal' }) });
      const revokeAfterUnpublish = await request(capRoute(), { method: 'DELETE' });
      assert.equal(revokeAfterUnpublish.status, 200);
      assert.equal(revokeAfterUnpublish.body.revoked, true);
      const personal = await request(capRoute(), { method: 'POST' });
      assert.equal(personal.status, 409);
      assert.equal(personal.body.error, 'MY_PIN_NOT_SHARED');
      await request(route(myPinsSceneId), { method: 'POST', body: payload(myPinsPointId, { scope: 'shared' }) });
    });

    await t.test('My Pins public capability is one-point scoped and immediately revocable', async () => {
      assert.ok(myPinsSceneId);assert.ok(myPinsShareCode);
      const capRoute=`/api/sites/alpha/scenes/${myPinsSceneId}/points/${myPinsPointId}/share-capability`;
      const publicRoute=`/api/my-pins/points/${myPinsPointId}`;
      const syntheticStaffEmail='private-staff@example.test';
      await sql.query('update contacts set email=$1 where id=$2',[syntheticStaffEmail,CONTACT_A]);
      const published=await request(route(myPinsSceneId),{method:'POST',body:payload(myPinsPointId,{scope:'shared',contactIds:[CONTACT_A]})});
      assert.equal(published.status,200);assert.equal(published.body.scope,'shared');

      // Workspace share code must never expose a My Pins workspace or point anonymously.
      assert.equal((await request(`/api/scenes/by-code/${myPinsShareCode}`,{actor:null})).status,404);
      assert.equal((await request(`/api/scenes/by-code/${myPinsShareCode}/points/${myPinsPointId}`,{actor:null})).status,404);
      assert.equal((await request(`/api/scenes/by-code/${myPinsShareCode}/points/${myPinsPointId}/photos/${PHOTO}`,{actor:null})).status,404);
      const rootOwner=await request(`/api/scenes/by-code/${myPinsShareCode}`);
      assert.equal(rootOwner.status,200);
      assert.equal((await request(`/api/scenes/by-code/${myPinsShareCode}/status`,{method:'POST',actor:OTHER,body:{status:'resolved'}})).status,403);
      assert.equal((await request(`/api/sites/alpha/scenes/${myPinsSceneId}/status`,{method:'POST',actor:OTHER,body:{status:'resolved'}})).status,403);

      const issued=await request(capRoute,{method:'POST'});
      assert.equal(issued.status,200);assert.match(issued.body.token,/^[A-Za-z0-9_-]{43}$/);
      const capability=issued.body.token;
      const noBearer=await request(publicRoute,{actor:null});
      assert.equal(noBearer.status,404);assert.deepEqual(noBearer.body,{error:'not found'});
      const wrongBearer=await request(publicRoute,{actor:null,bearer:'B'.repeat(43)});
      assert.equal(wrongBearer.status,404);assert.deepEqual(wrongBearer.body,{error:'not found'});
      const crossPoint=await request(`/api/my-pins/points/${uid(90)}`,{actor:null,bearer:capability});
      assert.equal(crossPoint.status,404);assert.deepEqual(crossPoint.body,{error:'not found'});

      const scoped=await request(publicRoute,{actor:null,bearer:capability});
      assert.equal(scoped.status,200);assert.deepEqual(scoped.body.pins.map(p=>p.id),[myPinsPointId]);
      assert.deepEqual(scoped.body.contacts.map(c=>c.id),[CONTACT_A]);assert.deepEqual(scoped.body.photos,[]);
      assert.equal(Object.hasOwn(scoped.body.pins[0],'createdBy'),false);
      assert.equal(Object.hasOwn(scoped.body.contacts[0],'email'),false);
      assert.equal(Object.hasOwn(scoped.body.contacts[0],'createdBy'),false);
      assert.equal(Object.hasOwn(scoped.body.contacts[0],'createdAt'),false);
      assert.equal(JSON.stringify(scoped.body).includes(syntheticStaffEmail),false);
      assert.equal(scoped.headers.get('cache-control'),'private, no-store');
      assert.equal(scoped.headers.get('referrer-policy'),'no-referrer');

      const rotated=await request(capRoute,{method:'POST'});
      assert.equal(rotated.status,200);assert.notEqual(rotated.body.token,capability);
      assert.equal((await request(publicRoute,{actor:null,bearer:capability})).status,404);
      assert.equal((await request(publicRoute,{actor:null,bearer:rotated.body.token})).status,200);

      const revoked=await request(capRoute,{method:'DELETE'});
      assert.equal(revoked.status,200);assert.equal(revoked.body.revoked,true);
      assert.equal((await request(publicRoute,{actor:null,bearer:rotated.body.token})).status,404);

      // A personal point remains unavailable even if a syntactically valid stale bearer exists.
      await request(route(myPinsSceneId),{method:'POST',body:payload(myPinsPointId,{scope:'personal',contactIds:[CONTACT_A]})});
      assert.equal((await request(publicRoute,{actor:null,bearer:rotated.body.token})).status,404);
      await request(route(myPinsSceneId),{method:'POST',body:payload(myPinsPointId,{scope:'shared',contactIds:[CONTACT_A]})});
    });
    await t.test('My Pins phone override masks staff phone through the per-pin bearer capability', async () => {
      assert.ok(myPinsSceneId);
      const capRoute=`/api/sites/alpha/scenes/${myPinsSceneId}/points/${myPinsPointId}/share-capability`;
      const publicRoute=`/api/my-pins/points/${myPinsPointId}`;
      const staffPhone='0411 222 333', overridePhone='+61 499 888 777';
      await sql.query('update contacts set phone=$1 where id=$2',[staffPhone,CONTACT_A]);

      const ownerSet=await request(route(myPinsSceneId),{method:'POST',body:payload(myPinsPointId,{scope:'shared',contactIds:[CONTACT_A],phoneOverride:overridePhone})});
      assert.equal(ownerSet.status,200);assert.equal(ownerSet.body.phoneOverride,overridePhone);
      assert.equal((await sql.query('select phone_override from points where id=$1',[myPinsPointId])).rows[0].phone_override,overridePhone);

      const adminOmit=await request(route(myPinsSceneId),{method:'POST',actor:ADMIN,body:payload(myPinsPointId,{scope:'shared',contactIds:[CONTACT_A],label:'Platform admin label only'})});
      assert.equal(adminOmit.status,200);assert.equal(adminOmit.body.phoneOverride,overridePhone);
      assert.equal((await sql.query('select phone_override from points where id=$1',[myPinsPointId])).rows[0].phone_override,overridePhone);

      const adminOverride=await request(route(myPinsSceneId),{method:'POST',actor:ADMIN,body:payload(myPinsPointId,{scope:'shared',contactIds:[CONTACT_A],phoneOverride:'0400 000 999'})});
      assert.equal(adminOverride.status,400);assert.equal(adminOverride.body.error,'INVALID_PHONE_OVERRIDE');
      assert.equal((await sql.query('select phone_override from points where id=$1',[myPinsPointId])).rows[0].phone_override,overridePhone);

      const issued=await request(capRoute,{method:'POST'});
      assert.equal(issued.status,200);
      const publicBundle=await request(publicRoute,{actor:null,bearer:issued.body.token});
      assert.equal(publicBundle.status,200);assert.equal(publicBundle.body.pins[0].phoneOverride,overridePhone);
      assert.equal(publicBundle.body.contacts[0].phone,overridePhone);
      assert.equal(JSON.stringify(publicBundle.body).includes(staffPhone),false);

      assert.equal((await request(capRoute,{method:'DELETE'})).status,200);
      const cleared=await request(route(myPinsSceneId),{method:'POST',body:payload(myPinsPointId,{scope:'personal',contactIds:[CONTACT_A],phoneOverride:null})});
      assert.equal(cleared.status,200);assert.equal(cleared.body.phoneOverride,null);
      assert.equal((await sql.query('select phone_override from points where id=$1',[myPinsPointId])).rows[0].phone_override,null);
      assert.equal((await request(publicRoute,{actor:null,bearer:issued.body.token})).status,404);
      await request(route(myPinsSceneId),{method:'POST',body:payload(myPinsPointId,{scope:'shared',contactIds:[CONTACT_A]})});
    });
    await t.test('create-only browser import cannot overwrite an existing or racing account pin', async () => {
      const before=await sql.query('select label,notes,created_by from points where id=$1',[POINT_A]);
      const conflict=await request(route(),{method:'POST',createOnly:true,body:payload(POINT_A,{label:'Must not overwrite'})});
      assert.equal(conflict.status,409);
      assert.deepEqual((await sql.query('select label,notes,created_by from points where id=$1',[POINT_A])).rows,before.rows);
      const id=uid(79);
      const results=await Promise.all(['Import A','Import B'].map(label=>request(route(),{method:'POST',createOnly:true,body:payload(id,{label})})));
      assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
      assert.equal((await sql.query('select id from points where id=$1',[id])).rowCount,1);
      const winner=results.find(result=>result.status===200).body.label;
      assert.equal((await sql.query('select label from points where id=$1',[id])).rows[0].label,winner);
      // Clean up this fixture through the actual authorized route.
      assert.equal((await request(route(SCENE_A,id),{method:'DELETE'})).status,200);
    });
    await t.test('upsert keeps creator immutable; platform override is server controlled', async () => {
      const res=await request(route(),{method:'POST',actor:ADMIN,body:payload(POINT_A,{label:'Updated fixture',createdBy:ADMIN})});
      assert.equal(res.status,200);assert.equal(res.body.createdBy,OWNER);
      assert.equal((await sql.query('select changed_by from audit_log order by id desc limit 1')).rows[0].changed_by,ADMIN);
    });
    await t.test('scene list excludes another scene and base; public list stays base-only', async () => {
      await db.saveScenePoint('alpha',SCENE_B,payload(POINT_B),OTHER);
      await sdb.savePoint('alpha',payload(POINT_BASE),OWNER);
      const scopedList=await request(route());assert.equal(scopedList.status,200);
      assert.equal(scopedList.headers.get('cache-control'),'no-store');assert.deepEqual(scopedList.body.map(p=>p.id),[POINT_A]);
      const publicList=await request('/api/points?scene='+SCENE_A,{actor:null});
      assert.deepEqual(publicList.body.map(p=>p.id),[POINT_BASE]);
    });
    await t.test('base, different-scene and cross-tenant ID collisions cannot rebind', async () => {
      for (const id of [POINT_B,POINT_BASE]) assert.equal((await request(route(),{method:'POST',body:payload(id)})).status,409);
      assert.equal((await request(route(SCENE_A2),{method:'POST',body:payload(POINT_A)})).status,409);
      await db.saveScenePoint('beta',SCENE_FOREIGN,payload(uid(99)),OTHER);
      assert.equal((await request(route(),{method:'POST',body:payload(uid(99))})).status,409);
      assert.equal((await sql.query('select scene_id from points where id=$1',[POINT_A])).rows[0].scene_id,SCENE_A);
    });
    await t.test('malformed JSON/body/scene IDs return controlled errors without hanging', async () => {
      for(const body of [null,[],payload(uid(61),{sceneId:SCENE_B}),payload(uid(61),{sceneId:null}),payload(uid(61),{type:'invented'}),payload(uid(61),{position3d:{x:'1',y:2,z:3}})]) {
        assert.equal((await request(route(),{method:'POST',body})).status,400);
      }
      assert.equal((await request(route(),{method:'POST',raw:'{broken'})).status,400);
      assert.equal((await request(route('bad-uuid'))).status,400);
      assert.equal((await request(route(),{method:'PATCH',body:{}})).status,405);
      assert.equal((await request(route(uid(88)))).status,404);
    });
    await t.test('same-site contact references enforced; cross-site contacts roll back', async () => {
      const n=await count('audit_log');const res=await request(route(),{method:'POST',body:payload(uid(62),{contactIds:[CONTACT_B]})});
      assert.equal(res.status,400);assert.equal(res.body.error,'INVALID_CONTACT_REFERENCE');assert.equal(await count('audit_log'),n);
      assert.equal((await sql.query('select id from points where id=$1',[uid(62)])).rowCount,0);
    });
    await t.test('legacy base mutation cannot bypass scene scope or delete its photos', async () => {
      assert.equal((await request('/api/points',{method:'POST',body:payload(POINT_A)})).status,409);
      assert.equal((await request('/api/points',{method:'POST',body:payload(uid(63),{sceneId:SCENE_A})})).status,400);
      assert.equal((await request('/api/points/'+POINT_A,{method:'DELETE'})).status,404);
      assert.equal((await sql.query('select id from points where id=$1',[POINT_A])).rowCount,1);
    });
    await t.test('legacy photo metadata, upload, bytes, retention and delete do not expose scene pins', async () => {
      await sql.query("insert into point_photos(id,site_id,point_id,storage_path,original_path) values($1,$2,$3,'synthetic/thumbnail','synthetic/original')",[PHOTO,SITE_A,POINT_A]);
      const legacy=`/api/sites/alpha/points/${POINT_A}/photos`;
      assert.equal((await request(legacy)).status,404);
      const header=Buffer.from(JSON.stringify({compressedBytes:1,contentType:'image/jpeg'}));const len=Buffer.alloc(4);len.writeUInt32BE(header.length);
      assert.equal((await request(legacy,{method:'POST',binary:Buffer.concat([len,header,Buffer.from([1,2])])})).status,404);
      assert.equal((await request('/api/point-photos/'+PHOTO,{actor:null})).status,404);
      for(const method of ['PATCH','DELETE']) assert.equal((await request('/api/sites/alpha/points/photos/'+PHOTO,{method,body:method==='PATCH'?{keep:true}:undefined})).status,404);
      assert.equal(await count('point_photos'),1);
    });
    await t.test('real anonymous share bundle exposes only explicitly shared pins and minimal active contacts', async () => {
      const sharedId=uid(70),sharedContact=uid(71),inactiveContact=uid(72);
      const privateEmail='private-scene-contact@example.test';
      await sql.query("update scenes set share_code='abcde23456' where id=$1",[SCENE_A]);
      await sql.query("insert into contacts(id,site_id,name,role,phone,email,active) values($1,$2,'Synthetic shared contact','Visitor contact','08 9000 0000',$3,true),($4,$2,'Inactive contact','Old role','08 9111 1111','inactive@example.test',false)",[sharedContact,SITE_A,privateEmail,inactiveContact]);
      await db.saveScenePoint('alpha',SCENE_A,payload(POINT_A,{contactIds:[CONTACT_A]}),OWNER);
      await db.saveScenePoint('alpha',SCENE_A,payload(sharedId,{scope:'shared',contactIds:[sharedContact,inactiveContact]}),OWNER);
      const shared=await request('/api/scenes/by-code/abcde23456',{actor:null});
      assert.equal(shared.status,200);assert.deepEqual(shared.body.pins.map(x=>x.id),[sharedId]);
      assert.deepEqual(shared.body.contacts,[{id:sharedContact,name:'Synthetic shared contact',role:'Visitor contact',phone:'08 9000 0000',active:true}]);
      assert.equal(Object.hasOwn(shared.body.contacts[0],'email'),false);assert.equal(Object.hasOwn(shared.body.contacts[0],'createdBy'),false);assert.equal(Object.hasOwn(shared.body.contacts[0],'createdAt'),false);
      assert.equal(JSON.stringify(shared.body).includes(privateEmail),false);assert.equal(JSON.stringify(shared.body).includes('Inactive contact'),false);
      assert.equal(shared.body.scene.createdByEmail,null);assert.equal(shared.body.scene.statusChangedByEmail,null);
      await db.saveScenePoint('alpha',SCENE_A,payload(sharedId,{scope:'personal',contactIds:[sharedContact,inactiveContact]}),OWNER);
      const withdrawn=await request('/api/scenes/by-code/abcde23456',{actor:null});
      assert.equal(withdrawn.status,200);assert.deepEqual(withdrawn.body.pins,[]);assert.deepEqual(withdrawn.body.contacts,[]);
    });
    await t.test('wrong scene and photo-bearing point deletes are non-destructive', async () => {
      assert.equal((await request(route(SCENE_A2,POINT_A),{method:'DELETE'})).status,404);
      const blocked=await request(route(SCENE_A,POINT_A),{method:'DELETE'});
      assert.equal(blocked.status,409);assert.equal(blocked.body.error,'POINT_HAS_PHOTOS');
      assert.equal((await sql.query('select id from points where id=$1',[POINT_A])).rowCount,1);assert.equal(await count('point_photos'),1);
      // Explicit photo removal is the next media-authorization slice. Fixture
      // cleanup below touches only the isolated test schema and no Storage.
      await sql.query('delete from point_photos where id=$1',[PHOTO]);
    });
    await t.test('scene photo routes enforce metadata authorization and scene delete 409 protection', async () => {
      await sql.query("insert into point_photos(id,site_id,point_id,storage_path,original_path,expires_at) values($1,$2,$3,'synthetic/thumbnail','synthetic/original',now() + interval '30 days')",[PHOTO,SITE_A,POINT_A]);
      const photoRoute = (scene = SCENE_A, point = POINT_A, photo = '') => `/api/sites/alpha/scenes/${scene}/points/${point}/photos${photo ? '/' + photo : ''}`;
      for (const actor of [null, VIEWER, OTHER, OUTSIDER]) {
        assert.equal((await request(photoRoute(), { actor })).status, actor ? 403 : 401);
        assert.equal((await request(photoRoute(SCENE_A, POINT_A, PHOTO), { method: 'PATCH', actor, body: { keep: true } })).status, actor ? 403 : 401);
      }
      const listRes = await request(photoRoute());
      assert.equal(listRes.status, 200);
      assert.equal(listRes.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(listRes.body.map(p => p.id), [PHOTO]);
      assert.equal((await request(photoRoute(SCENE_A2, POINT_A))).status, 404);
      const SCENE_HAZARD = uid(26);
      await sql.query("insert into scenes(id,site_id,created_by,kind,name) values($1,$2,$3,'hazard','Hazard scene')",[SCENE_HAZARD,SITE_A,OWNER]);
      const hazardListRes = await request(photoRoute(SCENE_HAZARD, POINT_A));
      assert.equal(hazardListRes.status, 400);
      assert.equal(hazardListRes.body.error, 'INVALID_SCENE_KIND');
      const hazardPatchRes = await request(photoRoute(SCENE_HAZARD, POINT_A, PHOTO), { method: 'PATCH', body: { keep: true } });
      assert.equal(hazardPatchRes.status, 400);
      assert.equal(hazardPatchRes.body.error, 'INVALID_SCENE_KIND');
      const hazardDeletePhotoRes = await request(photoRoute(SCENE_HAZARD, POINT_A, PHOTO), { method: 'DELETE' });
      assert.equal(hazardDeletePhotoRes.status, 400);
      assert.equal(hazardDeletePhotoRes.body.error, 'INVALID_SCENE_KIND');
      await sql.query('delete from scenes where id=$1', [SCENE_HAZARD]);
      const patchRes = await request(photoRoute(SCENE_A, POINT_A, PHOTO), { method: 'PATCH', body: { keep: true } });
      assert.equal(patchRes.status, 200);
      assert.equal(patchRes.body.expiresAt, null);
      const sceneDeleteRes = await request(`/api/sites/alpha/scenes/${SCENE_A}`, { method: 'DELETE' });
      assert.equal(sceneDeleteRes.status, 409);
      assert.equal(sceneDeleteRes.body.error, 'SCENE_HAS_POINT_PHOTOS');
      assert.equal((await sql.query('select id from scenes where id=$1', [SCENE_A])).rowCount, 1);
      assert.equal((await sql.query('select id from point_photos where id=$1', [PHOTO])).rowCount, 1);
      const nonOwnerSceneDelete = await request(`/api/sites/alpha/scenes/${SCENE_A}`, { method: 'DELETE', actor: OTHER });
      assert.equal(nonOwnerSceneDelete.status, 200);
      assert.equal(nonOwnerSceneDelete.body.removed, 'subscription');
      assert.equal((await sql.query('select id from scenes where id=$1', [SCENE_A])).rowCount, 1);
      await sql.query('delete from point_photos where id=$1', [PHOTO]);
    });
    await t.test('audit failure rolls back the point mutation', async () => {
      const res=await request(route(),{method:'POST',body:payload(uid(64),{label:'TEST_FAIL_AUDIT'})});assert.equal(res.status,500);
      assert.equal((await sql.query('select id from points where id=$1',[uid(64)])).rowCount,0);
      assert.doesNotMatch(JSON.stringify(res.body),/constraint|fixture_audit|TEST_FAIL_AUDIT/);
    });
    await t.test('photo-free authorized delete commits point and audit atomically', async () => {
      const id=uid(65);await db.saveScenePoint('alpha',SCENE_A,payload(id),OWNER);
      await db.deleteScenePoint('alpha',SCENE_A,id,OWNER);
      assert.equal((await sql.query('select id from points where id=$1',[id])).rowCount,0);
      const audit=await sql.query("select action,changed_by from audit_log where entity_id=$1 order by id desc limit 1",[id]);
      assert.equal(audit.rows[0].action,'delete');assert.equal(audit.rows[0].changed_by,OWNER);
    });
    await t.test('audit failure on deletion preserves the actual pin row', async () => {
      const id=uid(72);await sql.query("insert into points(id,site_id,scene_id,label,position3d) values($1,$2,$3,'TEST_FAIL_AUDIT','{\"x\":0,\"y\":0,\"z\":0}')",[id,SITE_A,SCENE_A]);
      const failed=await request(route(SCENE_A,id),{method:'DELETE'});assert.equal(failed.status,500);
      assert.equal((await sql.query('select id from points where id=$1',[id])).rowCount,1);
    });
    await t.test('legacy ownerless scene policy and platform override remain intact', async () => {
      const legacy=await request(route(SCENE_LEGACY),{method:'POST',actor:OTHER,body:payload(uid(66))});assert.equal(legacy.status,200);
      const platform=await request(route(SCENE_B),{method:'POST',actor:ADMIN,body:payload(uid(67))});assert.equal(platform.status,200);assert.equal(platform.body.createdBy,ADMIN);
    });
    await t.test('new connection sees durable scene-owned data; authorized delete works', async () => {
      const fresh=new Client({connectionString:scoped.href});await fresh.connect();
      try {assert.equal((await fresh.query('select created_by from points where id=$1',[POINT_A])).rows[0].created_by,OWNER);} finally {await fresh.end();}
      assert.equal((await request(route(SCENE_A,POINT_A),{method:'DELETE'})).status,200);
      assert.equal((await sql.query('select id from points where id=$1',[POINT_A])).rowCount,0);
      assert.equal((await request('/api/points/'+POINT_BASE,{method:'DELETE'})).status,200);
    });
    assert.doesNotMatch(childErrors,/UnhandledPromiseRejection|ERR_HTTP_INVALID_STATUS_CODE|ECONNREFUSED|External mail/);
  } finally {
    if(child && child.exitCode === null) {child.kill('SIGTERM');await once(child,'exit').catch(()=>{});}
    if(sdb) await sdb.pool().end();
    await sql.end().catch(()=>{});
    await root.query(`drop schema if exists ${schema} cascade`).catch(()=>{});
    await root.end();
  }
});
