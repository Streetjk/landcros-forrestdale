import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validatePublicRuntimeConfig, loadDirectPublicData, loadPublicTransport, backendRedirectForScopedRoute, shouldProbeStaffSession, PUBLIC_TRANSPORT_COLUMNS } from '../public-transport.js';

const runtime = Object.freeze({
  siteSlug: 'landcros',
  supabaseUrl: 'https://example.supabase.co',
  supabasePublishableKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz123456',
  apiOrigin: 'https://api.example.test',
});

function response(body, status=200) { return { ok: status>=200&&status<300, status, async json(){ return body; } }; }

test('runtime config accepts only HTTPS origins and modern publishable keys', () => {
  assert.deepEqual(validatePublicRuntimeConfig(runtime), runtime);
  assert.equal(validatePublicRuntimeConfig({...runtime, supabasePublishableKey:'sb_secret_nope'}), null);
  assert.equal(validatePublicRuntimeConfig({...runtime, supabaseUrl:'http://example.test'}), null);
  assert.equal(validatePublicRuntimeConfig({...runtime, apiOrigin:'https://u:p@example.test'}), null);
});

test('direct Supabase transport uses the explicit public column contract and normalizes rows', async () => {
  const calls=[];
  const fetchFn=async (url, init={}) => {
    calls.push({url:String(url),init});
    const u=new URL(url);
    assert.equal(init.headers.apikey, runtime.supabasePublishableKey);
    if (u.pathname.endsWith('/sites')) return response([{id:'site-1',slug:'landcros',name:'LANDCROS',title:'Guide',address:'107 Allen Rd',logo:'https://img.example/logo.png',published:true}]);
    if (u.pathname.endsWith('/points')) return response([{id:'p1',site_id:'site-1',label:'Gate',type:'drop-off',scope:'shared',latlng:null,position3d:{x:1,y:2,z:3},notes:'Use gate',contact_ids:['c1'],route_waypoints:[],route_waypoints3d:[],camera_preset3d:null,building_ref:'gate'}]);
    if (u.pathname.endsWith('/contacts')) return response([{id:'c1',site_id:'site-1',name:'Visitor contact',role:'Gate',phone:'08 0000 0000',active:true}]);
    throw new Error('unexpected '+url);
  };
  const out=await loadDirectPublicData(runtime,fetchFn);
  assert.equal(out.transport,'supabase');
  assert.equal(out.unpublished,false);
  assert.equal(out.siteResult.data.slug,'landcros');
  assert.deepEqual(out.pointResult.data[0].contactIds,['c1']);
  assert.equal(out.contactResult.data[0].phone,'08 0000 0000');
  assert.equal(calls.length,3);
  assert.equal(new URL(calls[0].url).searchParams.get('select'),PUBLIC_TRANSPORT_COLUMNS.site);
  assert.equal(new URL(calls[1].url).searchParams.get('select'),PUBLIC_TRANSPORT_COLUMNS.point);
  assert.equal(new URL(calls[2].url).searchParams.get('select'),PUBLIC_TRANSPORT_COLUMNS.contact);
});

test('unpublished Supabase site is an intentional empty result and never falls back to legacy API', async () => {
  let calls=0;
  const fetchFn=async url => { calls++; const u=new URL(url); assert.match(u.hostname,/supabase\.co$/); return response([]); };
  const out=await loadPublicTransport(runtime,fetchFn);
  assert.equal(out.transport,'supabase');
  assert.equal(out.unpublished,true);
  assert.deepEqual(out.pointResult.data,[]);
  assert.deepEqual(out.contactResult.data,[]);
  assert.equal(calls,1);
});

test('configured Supabase outage fails closed without contacting backend', async () => {
  const calls=[];
  const fetchFn=async url => { calls.push(String(url)); throw new Error('offline'); };
  const out=await loadPublicTransport(runtime,fetchFn);
  assert.equal(out.transport,'supabase-unavailable');
  assert.equal(out.pointResult.unavailable,true);
  assert.equal(out.contactResult.unavailable,true);
  assert.deepEqual(out.pointResult.data,[]);
  assert.equal(calls.length,1);
  assert.equal(calls.some(url => url.startsWith(runtime.apiOrigin)),false);
});


test('static host redirects only scoped/capability URLs to backend and never probes staff session', () => {
  const plain={href:'https://static.example.test/'};
  const scene={href:'https://static.example.test/?scene=abcde23456'};
  const pin={href:'https://static.example.test/?id=123#myPin='+'A'.repeat(43)};
  assert.equal(backendRedirectForScopedRoute(runtime,plain),null);
  assert.equal(backendRedirectForScopedRoute(runtime,scene),'https://api.example.test/?scene=abcde23456');
  assert.match(backendRedirectForScopedRoute(runtime,pin),/^https:\/\/api\.example\.test\/\?id=123#myPin=/);
  assert.equal(shouldProbeStaffSession(runtime,plain),false);
  assert.equal(shouldProbeStaffSession(runtime,{href:'https://api.example.test/'}),true);
  const networkPath={href:'https://static.example.test//attacker.example/?scene=abcde23456#myPin='+'A'.repeat(43)};
  const redirected=backendRedirectForScopedRoute(runtime,networkPath);
  assert.equal(new URL(redirected).origin,runtime.apiOrigin);
  assert.equal(new URL(redirected).pathname,'//attacker.example/');
});

test('LANDCROS runtime file contains no server secret and render blueprint defines static front end', () => {
  const cfg=JSON.parse(fs.readFileSync('sites/landcros/data/public-runtime.json','utf8'));
  assert.match(cfg.supabasePublishableKey,/^sb_publishable_/);
  assert.equal(JSON.stringify(cfg).includes('service_role'),false);
  assert.equal(JSON.stringify(cfg).includes('sb_secret_'),false);
  const render=fs.readFileSync('render.yaml','utf8');
  assert.match(render,/name: landcros-forrestdale-static[\s\S]*?runtime: static[\s\S]*?buildCommand: bash build\.sh landcros[\s\S]*?staticPublishPath: dist-landcros/);
});


test('viewer startup does not ping backend analytics or staff auth on a separate static origin', () => {
  const viewer=fs.readFileSync('viewer3d.js','utf8');
  const index=fs.readFileSync('index.html','utf8');
  assert.match(viewer, /function _flushBackendVisitIfLocal\(\)[\s\S]*?if \(!shouldProbeStaffSession\(_publicRuntime, window\.location\)\) return;/);
  assert.match(viewer, /window\._snPendingVisitPointId = _ptId \|\| null/);
  assert.match(viewer, /if \(!shouldProbeStaffSession\(_publicRuntime, window\.location\)\) return;[\s\S]*?_pointPhotoSlug/);
  assert.match(index, /window\._snMountStaffShell = \(\) => window\.SiteNavStaffMapShell\?\.mountAuthenticatedMapNav\?\.\(\);/);
  assert.equal((index.match(/mountAuthenticatedMapNav\?\.\(\)/g) || []).length, 1);
});
