import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHmac, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE_A = uid(1), SITE_B = uid(2), OWNER = uid(11), OTHER = uid(12), VIEWER = uid(13), ADMIN = uid(14), OUTSIDER = uid(15);
const SCENE_A = uid(21), SCENE_A2 = uid(22), SCENE_B = uid(23), SCENE_FOREIGN = uid(24), SCENE_LEGACY = uid(25);
const CONTACT_A = uid(31), CONTACT_B = uid(32), POINT_A = uid(41), POINT_B = uid(42), POINT_BASE = uid(43), PHOTO = uid(51);
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
      create table scenes(id uuid primary key,site_id uuid references sites(id),created_by uuid references profiles(id),
        kind text default 'admin',status text default 'open',share_code text unique,name text,
        camera jsonb,status_changed_at timestamptz,status_changed_by uuid,
        unique(site_id,id));
      create table scripts(id uuid primary key,site_id uuid,source text);
      create table scene_objects(id uuid primary key,site_id uuid,scene_id uuid,script_id uuid,
        z_index integer,created_at timestamptz default now());
      create table contacts(id uuid primary key,site_id uuid references sites(id),name text,role text,phone text,email text,
        active boolean default true,created_by text,created_at timestamptz default now());
      create table points(id uuid primary key,site_id uuid not null references sites(id),scene_id uuid,
        label text not null,type text not null default 'drop-off',scope text not null default 'shared',
        latlng jsonb,position3d jsonb,notes text,contact_ids uuid[] not null default '{}',
        route_waypoints jsonb not null default '[]',route_waypoints3d jsonb not null default '[]',camera_preset3d jsonb,
        building_ref text,created_by text,created_at timestamptz default now(),updated_at timestamptz default now(),
        foreign key(site_id,scene_id) references scenes(site_id,id) on delete cascade);
      create table audit_log(id bigserial primary key,site_id uuid,changed_by uuid,action text,entity_type text,entity_id uuid,entity_label text,
        constraint fixture_audit check(entity_label <> 'TEST_FAIL_AUDIT'));
      create table point_photos(id uuid primary key,site_id uuid,point_id uuid references points(id) on delete cascade,
        storage_path text,original_path text,original_name text,content_type text,bytes integer,original_bytes integer,
        width integer,height integer,created_by uuid,expires_at timestamptz,created_at timestamptz default now());
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
    async function request(path, { method='GET', actor=OWNER, body, raw, binary } = {}) {
      const headers={}; if(actor)headers.Cookie=`sn_session=${token(actor)}`;
      if(body !== undefined || raw !== undefined) headers['Content-Type']='application/json';
      if(binary) headers['Content-Type']='application/octet-stream';
      const res=await fetch(origin+path,{method,headers,body:binary || raw || (body === undefined ? undefined : JSON.stringify(body)),signal:AbortSignal.timeout(4000)});
      return {status:res.status,headers:res.headers,body:await res.json()};
    }
    const count = async (table) => Number((await sql.query(`select count(*) as n from ${table}`)).rows[0].n);
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
    await t.test('real anonymous share bundle exposes only explicitly shared pins and their contacts', async () => {
      const sharedId=uid(70),sharedContact=uid(71);
      await sql.query("update scenes set share_code='abcde23456' where id=$1",[SCENE_A]);
      await sql.query("insert into contacts(id,site_id,name) values($1,$2,'Synthetic shared contact')",[sharedContact,SITE_A]);
      await db.saveScenePoint('alpha',SCENE_A,payload(POINT_A,{contactIds:[CONTACT_A]}),OWNER);
      await db.saveScenePoint('alpha',SCENE_A,payload(sharedId,{scope:'shared',contactIds:[sharedContact]}),OWNER);
      const shared=await request('/api/scenes/by-code/abcde23456',{actor:null});
      assert.equal(shared.status,200);assert.deepEqual(shared.body.pins.map(x=>x.id),[sharedId]);
      assert.deepEqual(shared.body.contacts.map(x=>x.id),[sharedContact]);
      assert.equal(shared.body.scene.createdByEmail,null);assert.equal(shared.body.scene.statusChangedByEmail,null);
      await db.saveScenePoint('alpha',SCENE_A,payload(sharedId,{scope:'personal',contactIds:[sharedContact]}),OWNER);
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
