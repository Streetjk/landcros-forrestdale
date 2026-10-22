// Atomic, site-scoped scene duplication. The source is NEVER mutated.
// The share capability and every object/point id are regenerated. Linked
// label photos are copied to independent private Supabase Storage objects.
const crypto = require('crypto');
const { pool, getSiteId } = require('./supabase-db');
const photos = require('./scene-photo-storage');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const MAX_OBJECTS = 200;
const MAX_PHOTOS = 25;
const MAX_POINTS = 200;

function clientError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function newCode() {
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, byte => ALPHABET[byte % ALPHABET.length]).join('');
}

function copyName(source, requested) {
  const fallback = String(source ?? '').slice(0, 113).trimEnd() + ' (Copy)';
  const name = requested === undefined ? fallback : requested;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
    throw clientError('Scene name must contain 1–120 characters');
  }
  return name.trim();
}

async function duplicateScene(slug, sourceId, requestedName, actorId, {
  getSite = getSiteId,
  connect = () => pool().connect(),
  copyImage = photos.copySceneLabelPhoto,
  copyGalleryImage = photos.copyGalleryPhotoPath,
  copyGalleryThumbnail = photos.copyGalleryThumbnailPath,
  removeImages = photos.removeClonedSceneLabelPhotos,
} = {}) {
  if (!UUID_RE.test(sourceId || '')) throw clientError('Invalid scene identifier');
  const siteId = await getSite(slug);
  const client = await connect();
  const copiedPaths = [];
  let copiedPhotoCount = 0;
  let committed = false;
  try {
    await client.query('BEGIN');
    const sourceRows = await client.query(
      'select id, name, kind, camera from scenes where id = $1::uuid and site_id = $2::uuid for share',
      [sourceId, siteId]
    );
    const source = sourceRows.rows[0];
    if (!source) throw clientError('Scene not found', 404);
    // Hazard scenes can include separate, time-limited photo/report history.
    // Do not silently produce an incomplete copy of that safety record.
    if (source.kind && source.kind !== 'admin') {
      throw clientError('Only standard scenes can be duplicated', 422);
    }
    const name = copyName(source.name, requestedName);
    const sourceObjects = (await client.query(
      'select id, kind, transform, style, props, script_id, z_index from scene_objects where site_id=$1::uuid and scene_id=$2::uuid order by z_index, created_at',
      [siteId, sourceId]
    )).rows;
    const sourcePoints = (await client.query(
      'select label, type, scope, latlng, position3d, notes, contact_ids, route_waypoints, route_waypoints3d, camera_preset3d, building_ref from points where site_id=$1::uuid and scene_id=$2::uuid order by created_at',
      [siteId, sourceId]
    )).rows;
    if (sourceObjects.length > MAX_OBJECTS || sourcePoints.length > MAX_POINTS) {
      throw clientError('Scene is too large to duplicate safely', 422);
    }
    const photoCount = sourceObjects.reduce((n,o) => o.kind === 'label'
      ? n + (o.props?.photoPath ? 1 : 0) + (Array.isArray(o.props?.photoPaths) ? o.props.photoPaths.length : 0)
      : n, 0);
    if (photoCount > MAX_PHOTOS) throw clientError('Too many photos to duplicate in one operation', 422);
    if (sourcePoints.length) {
      const { rows } = await client.query(
        'select exists (select 1 from point_photos ph join points pt on ph.point_id=pt.id where pt.scene_id=$1::uuid and pt.site_id=$2::uuid) as has_photos',
        [sourceId, siteId]
      );
      if (rows[0]?.has_photos) throw clientError('This scene has point photos that require a separate export', 422);
    }
    const id = crypto.randomUUID();
    const code = newCode();
    await client.query(
      'insert into scenes (id,site_id,name,share_code,camera,created_by,kind) values ($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6::uuid,$7)',
      [id, siteId, name, code, JSON.stringify(source.camera ?? null), actorId, 'admin']
    );
    for (const obj of sourceObjects) {
      const targetId = crypto.randomUUID();
      const props = { ...(obj.props || {}) };
      delete props.photoUrl; delete props.photoUrls; delete props.photoItems;
      if (obj.kind === 'label' && props.photoPath) {
        const expected = photos.photoPath(sourceId, obj.id);
        if (props.photoPath !== expected) throw clientError('Source photo reference is invalid', 422);
        const target = await copyImage(sourceId, obj.id, id, targetId);
        copiedPaths.push(target);
        copiedPhotoCount++;
        props.photoPath = target;
      }
      if (obj.kind === 'label' && Array.isArray(props.photoPaths)) {
        const paths=[];
        const thumbs=[];
        const sourceThumbs=Array.isArray(props.photoThumbPaths)?props.photoThumbPaths:[];
        for (const src of props.photoPaths) {
          const path = await copyGalleryImage(sourceId,obj.id,src,id,targetId);
          copiedPaths.push(path);
          copiedPhotoCount++;
          paths.push(path);
          const originalThumb=photos.thumbnailPathForGallery(src);
          if(sourceThumbs.includes(originalThumb)){
            const thumb=await copyGalleryThumbnail(sourceId,obj.id,originalThumb,id,targetId);
            copiedPaths.push(thumb);
            thumbs.push(thumb);
          }
        }
        props.photoPaths=paths;
        if(sourceThumbs.length)props.photoThumbPaths=thumbs;
      }
      await client.query(
        'insert into scene_objects (id,site_id,scene_id,kind,transform,style,props,script_id,z_index) values ($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::uuid,$9)',
        [targetId,siteId,id,obj.kind,JSON.stringify(obj.transform || {}),
          JSON.stringify(obj.style || {}),JSON.stringify(props),obj.script_id ?? null,obj.z_index ?? 0]
      );
    }
    for (const pt of sourcePoints) {
      await client.query(
        `insert into points (id,site_id,scene_id,label,type,scope,latlng,position3d,notes,
          contact_ids,route_waypoints,route_waypoints3d,camera_preset3d,building_ref)
          values ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8::jsonb,$9,
          $10::uuid[],$11::jsonb,$12::jsonb,$13::jsonb,$14)`,
        [crypto.randomUUID(), siteId, id, pt.label, pt.type, pt.scope,
          JSON.stringify(pt.latlng),JSON.stringify(pt.position3d),pt.notes,
          pt.contact_ids || [],JSON.stringify(pt.route_waypoints || []),
          JSON.stringify(pt.route_waypoints3d || []),JSON.stringify(pt.camera_preset3d),pt.building_ref]
      );
    }
    await client.query(
      "insert into audit_log (site_id,changed_by,action,entity_type,entity_id,entity_label) values ($1::uuid,$2::uuid,'duplicate','scene',$3,$4)",
      [siteId, actorId, id, name]
    );
    await client.query('COMMIT');
    committed = true;
    return {
      id, name, shareCode: code, camera: source.camera,
      kind: 'admin', status: 'open', isMine: true,
      copiedObjects: sourceObjects.length, copiedPoints: sourcePoints.length,
      copiedPhotos: copiedPhotoCount,
    };
  } catch (e) {
    if (!committed) {
      try { await client.query('ROLLBACK'); } catch (err) { console.error('[scene-duplicate] rollback failed:', err.message); }
      if (copiedPaths.length) {
        try { await removeImages(copiedPaths); }
        catch (err) { console.error('[scene-duplicate] private photo cleanup failed:', err.message); }
      }
    }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { duplicateScene, copyName };
