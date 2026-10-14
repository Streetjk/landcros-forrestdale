// Per-editor scene folders. Folder operations never touch scene rows.
const { pool, getSiteId } = require('./supabase-db');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(['admin', 'hazard']);

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
function checkKind(kind) {
  if (!KINDS.has(kind)) throw bad('Invalid scene category');
  return kind;
}
function checkName(name) {
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 60) {
    throw bad('Group name must be 1–60 characters');
  }
  return name.trim();
}
function checkId(id) {
  if (!UUID.test(id || '')) throw bad('Invalid ID');
  return id;
}
async function listGroups(slug, profileId, kind) {
  checkKind(kind);
  const siteId = await getSiteId(slug);
  const { rows: groups } = await pool().query(
    `select id, name, kind from scene_groups
     where site_id=$1::uuid and profile_id=$2::uuid and kind=$3
     order by lower(name), created_at`,
    [siteId, profileId, kind]
  );
  const { rows: assignments } = await pool().query(
    `select a.scene_id, a.group_id from scene_group_assignments a
     join scene_groups g on g.id=a.group_id and g.site_id=a.site_id
       and g.profile_id=a.profile_id
     where a.site_id=$1::uuid and a.profile_id=$2::uuid and g.kind=$3`,
    [siteId, profileId, kind]
  );
  return {
    groups: groups.map(g => ({ id:g.id, name:g.name, kind:g.kind })),
    assignments: assignments.map(a => ({ sceneId:a.scene_id, groupId:a.group_id })),
  };
}
async function createGroup(slug, profileId, { name, kind }) {
  const safeName = checkName(name);
  checkKind(kind);
  const siteId = await getSiteId(slug);
  const { rows: limits } = await pool().query(
    'select count(*)::int as n from scene_groups where site_id=$1::uuid and profile_id=$2::uuid and kind=$3',
    [siteId, profileId, kind]
  );
  if (limits[0].n >= 30) throw bad('Maximum 30 groups', 422);
  try {
    const {rows} = await pool().query(
      `insert into scene_groups (site_id,profile_id,kind,name)
       values ($1::uuid,$2::uuid,$3,$4) returning id,name,kind`,
      [siteId,profileId,kind,safeName]
    );
    return { id:rows[0].id, name:rows[0].name, kind:rows[0].kind };
  } catch (e) {
    if(e.code==='23505') throw bad('A group with that name already exists',409);
    throw e;
  }
}
async function renameGroup(slug, profileId, groupId, name) {
  checkId(groupId);
  const safeName = checkName(name);
  const siteId = await getSiteId(slug);
  try {
    const { rows } = await pool().query(
      `update scene_groups set name=$4
       where id=$3::uuid and site_id=$1::uuid and profile_id=$2::uuid
       returning id,name,kind`,
      [siteId,profileId,groupId,safeName]
    );
    if (!rows.length) throw bad('Group not found',404);
    return { id:rows[0].id, name:rows[0].name, kind:rows[0].kind };
  } catch(e) {
    if(e.code==='23505') throw bad('A group with that name already exists',409);
    throw e;
  }
}
async function deleteGroup(slug, profileId, groupId) {
  checkId(groupId);
  const siteId=await getSiteId(slug);
  const { rowCount } = await pool().query(
    'delete from scene_groups where site_id=$1::uuid and profile_id=$2::uuid and id=$3::uuid',
    [siteId,profileId,groupId]
  );
  if (!rowCount) throw bad('Group not found',404);
  return {ok:true};
}
async function moveScene(slug, profileId, sceneId, groupId) {
  checkId(sceneId);
  if (groupId !== null) checkId(groupId);
  const siteId=await getSiteId(slug);
  const {rows: sceneRows}=await pool().query(
    `select kind from scenes s where s.id=$3::uuid and s.site_id=$1::uuid
      and (s.created_by is null or s.created_by=$2::uuid
      or exists(select 1 from scene_subscriptions ss
        where ss.scene_id=s.id and ss.profile_id=$2::uuid))`,
    [siteId,profileId,sceneId]
  );
  if(!sceneRows.length) throw bad('Scene not found',404);
  if (groupId === null) {
    await pool().query(
      `delete from scene_group_assignments
       where site_id=$1::uuid and profile_id=$2::uuid and scene_id=$3::uuid`,
      [siteId,profileId,sceneId]
    );
    return {sceneId,groupId:null};
  }
  const { rows: allowed } = await pool().query(
    `select id from scene_groups where id=$3::uuid and site_id=$1::uuid
       and profile_id=$2::uuid and kind=$4`,
    [siteId,profileId,groupId,sceneRows[0].kind]
  );
  if(!allowed.length) throw bad('Group not found for this scene',404);
  await pool().query(
    `insert into scene_group_assignments(site_id,profile_id,scene_id,group_id)
     values($1::uuid,$2::uuid,$3::uuid,$4::uuid)
     on conflict(site_id,profile_id,scene_id)
     do update set group_id=excluded.group_id`,
    [siteId,profileId,sceneId,groupId]
  );
  return {sceneId,groupId};
}
module.exports={ listGroups,createGroup,renameGroup,deleteGroup,moveScene };
