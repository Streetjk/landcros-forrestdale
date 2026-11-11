import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const domain=require('../fire-ops-domain');
const feeds=require('../fire-ops-feeds');
const {createFireOpsHandler}=require('../fire-ops-routes');

const validWork={
  workDate:'2026-11-12',startTime:'08:00',endTime:'10:00',department:'Mining',trade:'Boilermaker',
  buildingRef:'bld-mining',locationDetail:'Western bay, roller door 3',
  description:'Grinding steel brackets',equipment:'Angle grinder',enclosure:'open_workshop',
  vegetationWithin30m:null,dbcaWithin3km:false,controls:'Fire-watch officer assigned',fireWatchEmployeeId:null,
};

test('hot-work validation requires precise times, department, location and enclosure',()=>{
  assert.deepEqual(domain.validateHotWork(validWork),validWork);
  assert.throws(()=>domain.validateHotWork({...validWork,endTime:'07:00'}),/End time/);
  assert.throws(()=>domain.validateHotWork({...validWork,workDate:'2026-02-30'}),/Invalid work date/);
  assert.throws(()=>domain.validateHotWork({...validWork,department:'External attacker'}),/department/);
  assert.throws(()=>domain.validateHotWork({...validWork,buildingRef:'../private'}),/SiteNav building/);
  assert.throws(()=>domain.validateHotWork({...validWork,locationDetail:''}),/exact location/);
  assert.throws(()=>domain.validateHotWork({...validWork,vegetationWithin30m:'yes'}),/vegetation/);
  assert.throws(()=>domain.validateHotWork({...validWork,enclosure:'unknown'}),/enclosure/);
});

test('training expiry is never assumed without a recorded expiry',()=>{
  assert.equal(domain.competencyStatus('2026-06-01',null,'2026-11-11'),'no_expiry_recorded');
  assert.equal(domain.competencyStatus(null,'2026-12-01','2026-11-11'),'not_recorded');
  assert.equal(domain.competencyStatus('2026-06-01','2026-11-10','2026-11-11'),'expired');
  assert.equal(domain.competencyStatus('2026-06-01','2026-12-01','2026-11-11'),'due_soon');
  assert.equal(domain.competencyStatus('2026-06-01','2027-12-01','2026-11-11'),'current');
  assert.equal(domain.competencyStatus('2026-06-01','garbage','2026-11-11'),'unknown');
});

test('extinguisher map pin requires both surveyed coordinates',()=>{
  const asset={assetCode:'FE-001',type:'ABE Dry Powder',capacity:9,unit:'kg',buildingRef:'bld-mining',
    locationDetail:'West wall, door 3',condition:'in_service',sceneX:'-7.25',sceneZ:'8.33'};
  assert.equal(domain.validateExtinguisher(asset).sceneX,-7.25);
  assert.throws(()=>domain.validateExtinguisher({...asset,sceneZ:''}),/both valid SiteNav/);
  assert.throws(()=>domain.validateExtinguisher({...asset,sceneX:'NaN'}),/both valid SiteNav/);
  assert.throws(()=>domain.validateExtinguisher({...asset,capacity:0}),/capacity/);
});

test('notification status cannot be mistaken for an exemption or auto-approved',()=>{
  assert.deepEqual(domain.validateTransition('reviewed',{status:'notification_recorded',notNumber:'NOT 2026-001'}),
    {status:'notification_recorded',notNumber:'NOT 2026-001'});
  assert.throws(()=>domain.validateTransition('submitted',{status:'notification_recorded',notNumber:'NOT 1'}),/INVALID_STATUS_TRANSITION/);
  assert.throws(()=>domain.validateTransition('reviewed',{status:'notification_recorded'}),/DFES NOT number/);
  assert.throws(()=>domain.validateTransition('completed',{status:'under_review'}),/INVALID_STATUS_TRANSITION/);
});

const sampleRss=`<?xml version="1.0"?><rss version="2.0"><channel><title>DFES Total Fire Bans</title><pubDate>Wed, 11 Nov 2026 09:00:00 GMT</pubDate>
  <item><title><![CDATA[Fire ban - City of Armadale]]></title><description><![CDATA[Hot work affected in Forrestdale &amp; surrounds.]]></description><pubDate>Wed, 11 Nov 2026 08:00:00 GMT</pubDate><link>https://www.emergency.wa.gov.au/</link></item>
  <item><title>Outside region</title><description>&lt;strong&gt;Geraldton&lt;/strong&gt;</description><link>https://untrusted.example/exfil</link></item>
  </channel></rss>`;

test('official RSS reader decodes descriptions, sanitises external links, enforces per-feed 5-minute cache',async()=>{
  const parsed=feeds.parseRss(sampleRss);
  assert.equal(parsed.items.length,2);
  assert.equal(parsed.items[0].description,'Hot work affected in Forrestdale & surrounds.');
  assert.equal(parsed.items[1].description,'Geraldton');
  assert.equal(parsed.items[1].link,null);
  let calls=0;
  const stub=async()=>{calls++;return {ok:true,text:async()=>sampleRss};};
  const t=Date.UTC(2026,10,11,9);
  assert.equal((await feeds.fetchOne('bans',t,stub)).state,'ok');
  assert.equal((await feeds.fetchOne('bans',t+60_000,stub)).items.length,2);
  assert.equal(calls,1);
  await feeds.fetchOne('bans',t+feeds.MIN_POLL_MS+1,stub);
  assert.equal(calls,2);
  assert.deepEqual(Object.keys(feeds.FEEDS).sort(),['bans','danger','warnings']);
  assert.ok(Object.values(feeds.FEEDS).every(url=>url.startsWith('https://api.emergency.wa.gov.au/v1/rss/')));
});

function makeRouter(role='viewer') {
  const calls=[];
  const ranks={viewer:1,editor:2,admin:3};
  const database={
    list:async slug=>{calls.push(`list:${slug}`);return {work:[],staff:[],extinguishers:[]};},
    listMapAssets:async()=>{calls.push('map');return [];},
    createWork:async(slug,value)=>{calls.push(`create:${slug}`);return value;},
    updateWorkStatus:async()=>{calls.push('update');return {status:'reviewed'};},
    updateWorkDetails:async()=>{calls.push('revise');return {status:'under_review'};},
    upsert:async()=>{calls.push('upsert');return {id:'saved'};},
  };
  const router=createFireOpsHandler({
    database,officialFeeds:{snapshot:async()=>({bans:{items:[]}})},
    requireRole:(req,res,slug,min,cb)=>{
      if ((ranks[role]||0)<ranks[min]) return json(res,role?403:401,{error:'Forbidden'});
      cb({profileId:'test-user'});
    },
    readJson:(req,cb)=>cb(null,req.body),
    json,rateLimit:()=>false,
  });
  function json(res,status,data) {res.status=status;res.data=data;res.done?.();}
  async function invoke(method,path,body={},extraHeaders={}) {
    let resolve;
    const finished=new Promise(r=>{resolve=r;});
    const res={headers:{},setHeader(k,v){this.headers[k]=v;},done:resolve};
    const req={method,headers:{host:'example.test','content-type':'application/json',origin:'https://example.test',...extraHeaders},body};
    assert.equal(router(req,res,path),true);
    await finished;
    return res;
  }
  return {invoke,calls};
}

test('department users can submit plans but cannot alter credentials, assets or coordinator decisions',async()=>{
  const {invoke,calls}=makeRouter('viewer');
  assert.equal((await invoke('GET','/api/sites/landcros/fire-ops')).status,200);
  assert.equal((await invoke('POST','/api/sites/landcros/fire-ops/work',validWork)).status,201);
  assert.equal((await invoke('POST','/api/sites/landcros/fire-ops/staff',{fullName:'Secret'})).status,403);
  assert.equal((await invoke('POST','/api/sites/landcros/fire-ops/extinguishers',{})).status,403);
  assert.equal((await invoke('PATCH','/api/sites/landcros/fire-ops/work/12345678-1234-1234-1234-123456789abc',{status:'reviewed'})).status,403);
  assert.deepEqual(calls,['list:landcros','create:landcros']);
});

test('cross-origin writes refused even for an editor and no DB mutation happens',async()=>{
  const {invoke,calls}=makeRouter('admin');
  const response=await invoke('POST','/api/sites/landcros/fire-ops/work',validWork,{origin:'https://attacker.example'});
  assert.equal(response.status,403);
  assert.equal(calls.length,0);
});

test('ordinary SiteNav editors cannot alter fire registers; admin can',async()=>{
  const editor=makeRouter('editor');
  assert.equal((await editor.invoke('POST','/api/sites/landcros/fire-ops/extinguishers',{})).status,403);
  assert.equal(editor.calls.length,0);
  const admin=makeRouter('admin');
  const staff={fullName:'Test Employee',department:'Mining',trade:'Fitter',active:true};
  assert.equal((await admin.invoke('POST','/api/sites/landcros/fire-ops/staff',staff)).status,200);
  assert.equal((await admin.invoke('PATCH','/api/sites/landcros/fire-ops/work/12345678-1234-1234-1234-123456789abc/details',validWork)).status,200);
  assert.deepEqual(admin.calls,['upsert','revise']);
});

test('migration is private, scoped, audited and cannot store fake approved status',()=>{
  const migration=fs.readFileSync(new URL('../supabase/migrations/0024_fire_operations.sql',import.meta.url),'utf8');
  for(const table of ['fire_hot_works','fire_staff','fire_extinguishers','fire_ops_audit']) {
    assert.match(migration,new RegExp(`alter table ${table} enable row level security`));
  }
  assert.match(migration,/revoke all on fire_hot_works, fire_staff, fire_extinguishers, fire_ops_audit/);
  assert.match(migration,/fire_vehicle_trained_on date/);
  assert.doesNotMatch(migration,/status in \([^)]*approved/i);
  const map=fs.readFileSync(new URL('../viewer3d.js',import.meta.url),'utf8');
  assert.match(map,/_fireLayerRequested = _params\.get\('fire'\) === '1'/);
  assert.match(map,/credentials: 'same-origin', cache: 'no-store'/);
  assert.match(map,/_loadFireEquipmentLayer\(\)/);
});
