'use strict';

// Auth is enforced by the HTTP router. The database client is server-only;
// tenant site_id is always resolved from the authorised URL slug.
const { randomUUID } = require('crypto');
const { pool, getSiteId } = require('./supabase-db');
const { FireOpsError } = require('./fire-ops-domain');

const WORK_FIELDS = ['work_date','start_time','end_time','department','trade','building_ref','location_detail',
  'description','equipment','enclosure','vegetation_within_30m','dbca_within_3km','controls','fire_watch_employee_id'];
const STAFF_FIELDS = ['employee_number','full_name','department','trade','extinguisher_trained_on','extinguisher_expires_on',
  'fire_watch_trained_on','fire_watch_expires_on','fire_vehicle_trained_on','fire_vehicle_expires_on',
  'bushfire_trained_on','bushfire_expires_on',
  'evidence_reference','active','notes'];
const ASSET_FIELDS = ['asset_code','type','capacity','unit','building_ref','location_detail','scene_x','scene_z',
  'inspected_on','inspection_due_on','condition','notes'];
const DATE_FIELDS = new Set(['work_date','extinguisher_trained_on','extinguisher_expires_on',
  'fire_watch_trained_on','fire_watch_expires_on','fire_vehicle_trained_on','fire_vehicle_expires_on',
  'bushfire_trained_on','bushfire_expires_on',
  'inspected_on','inspection_due_on']);

function dateString(value) {
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
  return String(value).slice(0,10);
}

function camel(row) {
  return Object.fromEntries(Object.entries(row).map(([key,value]) =>
    [key.replace(/_([a-z])/g,(_,char)=>char.toUpperCase()),
      value != null && DATE_FIELDS.has(key) ? dateString(value) :
        value != null && (key==='start_time'||key==='end_time') ? String(value).slice(0,5) : value]));
}
async function transaction(fn) {
  const client = await pool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally { client.release(); }
}
async function audit(client,siteId,entity,entityId,action,actor,fields) {
  await client.query(
    `insert into fire_ops_audit(site_id,entity,entity_id,action,actor,details)
      values($1,$2,$3,$4,$5,$6::jsonb)`,
    [siteId,entity,entityId,action,actor,JSON.stringify({ fields })]
  );
}
async function list(slug) {
  const siteId = await getSiteId(slug);
  const db = pool();
  const [work,staff,assets] = await Promise.all([
    db.query(`select * from fire_hot_works where site_id=$1 order by work_date desc,start_time desc limit 1000`,[siteId]),
    db.query(`select * from fire_staff where site_id=$1 order by department,trade,full_name`,[siteId]),
    db.query(`select * from fire_extinguishers where site_id=$1 order by building_ref,asset_code`,[siteId]),
  ]);
  return {
    work: work.rows.map(camel), staff: staff.rows.map(camel), extinguishers: assets.rows.map(camel),
  };
}
async function listMapAssets(slug) {
  const siteId = await getSiteId(slug);
  const { rows } = await pool().query(
    `select id,asset_code,type,capacity,unit,building_ref,location_detail,scene_x,scene_z,condition
       from fire_extinguishers where site_id=$1 and scene_x is not null and scene_z is not null
       order by asset_code`,[siteId]);
  return rows.map(camel);
}
async function createWork(slug,input,actor) {
  const siteId = await getSiteId(slug);
  return transaction(async client => {
    const { rows } = await client.query(
      `insert into fire_hot_works(site_id,${WORK_FIELDS.join(',')},created_by,updated_by)
       values(${[...Array(WORK_FIELDS.length+1)].map((_,i)=>`$${i+1}`).join(',')},$${WORK_FIELDS.length+2},$${WORK_FIELDS.length+2})
       returning *`,
      [siteId,input.workDate,input.startTime,input.endTime,input.department,input.trade,input.buildingRef,
       input.locationDetail,input.description,input.equipment,input.enclosure,input.vegetationWithin30m,
       input.dbcaWithin3km,input.controls,input.fireWatchEmployeeId,actor]
    );
    await audit(client,siteId,'hot_work',rows[0].id,'submitted',actor,WORK_FIELDS);
    return camel(rows[0]);
  });
}
async function updateWorkStatus(slug,id,input,actor) {
  const siteId = await getSiteId(slug);
  return transaction(async client => {
    const { rows: currentRows } = await client.query(
      `select status,work_date,fire_watch_employee_id,enclosure,vegetation_within_30m,dbca_within_3km
       from fire_hot_works where site_id=$1 and id=$2 for update`,[siteId,id]);
    if (!currentRows.length) throw new FireOpsError(404,'NOT_FOUND');
    const { validateTransition } = require('./fire-ops-domain');
    const decision = validateTransition(currentRows[0].status,input);
    if (decision.notNumber) {
      // One official NOT receipt can cover multiple jobs in the same DFES
      // region on one ban day, but not a second consecutive TFB day.
      const { rows: reused } = await client.query(
        `select 1 from fire_hot_works where site_id=$1 and not_number=$2
         and work_date<>$3 and id<>$4 limit 1`,
        [siteId,decision.notNumber,currentRows[0].work_date,id]);
      if (reused.length) throw new FireOpsError(409,'REUSED_DFES_NOT_REFERENCE');
    }
    // Reviewed is an internal record of coordinator assessment, not external
    // permission to begin work. The UI must never label it 'DFES approved'.
    if (decision.status === 'reviewed' && currentRows[0].enclosure !== 'fully_enclosed') {
      if (currentRows[0].vegetation_within_30m === null)
        throw new FireOpsError(409,'VEGETATION_ASSESSMENT_REQUIRED');
      if (currentRows[0].dbca_within_3km === null)
        throw new FireOpsError(409,'DBCA_ASSESSMENT_REQUIRED');
      const watchId = currentRows[0].fire_watch_employee_id;
      if (!watchId) throw new FireOpsError(409,'FIRE_WATCH_REQUIRED');
      const { rows: watchRows } = await client.query(
        `select active,extinguisher_trained_on,extinguisher_expires_on,
            fire_vehicle_trained_on,fire_vehicle_expires_on,bushfire_trained_on,bushfire_expires_on
         from fire_staff where id=$1 and site_id=$2`,[watchId,siteId]);
      const staff = watchRows[0];
      const today = new Intl.DateTimeFormat('sv-SE',{timeZone:'Australia/Perth',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const { competencyStatus } = require('./fire-ops-domain');
      const valid = kind => staff?.[`${kind}_trained_on`] &&
        ['current','due_soon','no_expiry_recorded'].includes(competencyStatus(staff[`${kind}_trained_on`],staff[`${kind}_expires_on`],today));
      if (!staff?.active || !valid('extinguisher'))
        throw new FireOpsError(409,'FIRE_WATCH_TRAINING_UNVERIFIED');
      if (currentRows[0].vegetation_within_30m === true && (!valid('fire_vehicle') || !valid('bushfire')))
        throw new FireOpsError(409,'BUSHFIRE_TRAINING_UNVERIFIED');
    }
    const { rows } = await client.query(
      `update fire_hot_works set status=$3,
         not_number=case when $3='notification_recorded' then $4 else not_number end,
         notified_at=case when $3='notification_recorded' then now() else notified_at end,
         notified_by=case when $3='notification_recorded' then $5 else notified_by end,
         updated_by=$5,updated_at=now()
       where site_id=$1 and id=$2 returning *`,
      [siteId,id,decision.status,decision.notNumber,actor]);
    await audit(client,siteId,'hot_work',id,decision.status,actor,['status',...(decision.notNumber?['not_number']:[])]);
    return camel(rows[0]);
  });
}
async function updateWorkDetails(slug,id,input,actor) {
  const siteId=await getSiteId(slug);
  return transaction(async client => {
    const { rows }=await client.query(`select status from fire_hot_works where site_id=$1 and id=$2 for update`,[siteId,id]);
    if (!rows.length) throw new FireOpsError(404,'NOT_FOUND');
    if (!['submitted','under_review','reviewed'].includes(rows[0].status))
      throw new FireOpsError(409,'WORK_DETAILS_LOCKED');
    const values=[input.workDate,input.startTime,input.endTime,input.department,input.trade,input.buildingRef,
      input.locationDetail,input.description,input.equipment,input.enclosure,input.vegetationWithin30m,
      input.dbcaWithin3km,input.controls,input.fireWatchEmployeeId];
    const assignments=WORK_FIELDS.map((key,i)=>`${key}=$${i+3}`).join(',');
    const { rows: saved }=await client.query(
      `update fire_hot_works set ${assignments},status='under_review',updated_by=$${WORK_FIELDS.length+3},updated_at=now()
       where site_id=$1 and id=$2 returning *`,[siteId,id,...values,actor]);
    await audit(client,siteId,'hot_work',id,'details_revised',actor,WORK_FIELDS);
    return camel(saved[0]);
  });
}
async function upsert(slug,entity,input,actor) {
  const siteId = await getSiteId(slug);
  const isStaff = entity === 'staff';
  const table = isStaff ? 'fire_staff':'fire_extinguishers';
  const fields = isStaff ? STAFF_FIELDS:ASSET_FIELDS;
  const id = input.id || randomUUID();
  const values = isStaff ? [input.employeeNumber,input.fullName,input.department,input.trade,
    input.extinguisherTrainedOn,input.extinguisherExpiresOn,input.fireWatchTrainedOn,input.fireWatchExpiresOn,
    input.fireVehicleTrainedOn,input.fireVehicleExpiresOn,input.bushfireTrainedOn,input.bushfireExpiresOn,
    input.evidenceReference,input.active,input.notes] :
    [input.assetCode,input.type,input.capacity,input.unit,input.buildingRef,input.locationDetail,
     input.sceneX,input.sceneZ,input.inspectedOn,input.inspectionDueOn,input.condition,input.notes];
  return transaction(async client => {
    const columns = ['id','site_id',...fields,'updated_by'];
    const params = columns.map((_,i)=>`$${i+1}`);
    const updates = [...fields,'updated_by'].map(field => `${field}=excluded.${field}`).join(',');
    const { rows } = await client.query(
      `insert into ${table} (${columns.join(',')}) values (${params.join(',')})
       on conflict (id) do update set ${updates},updated_at=now()
       where ${table}.site_id=excluded.site_id
       returning *`,[id,siteId,...values,actor]);
    if (!rows.length) throw new FireOpsError(404,'NOT_FOUND');
    await audit(client,siteId,isStaff?'staff':'extinguisher',id,'saved',actor,fields);
    return camel(rows[0]);
  });
}
module.exports = { list,listMapAssets,createWork,updateWorkStatus,updateWorkDetails,upsert };
