'use strict';

const supabaseDb = require('./supabase-db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PointError = supabaseDb.PointWriteError;

function isCanonicalUuid(val) {
  return typeof val === 'string' && UUID_RE.test(val);
}

function canonicalizeUuid(val) {
  return val.toLowerCase();
}

function isFiniteNumber(val) {
  return typeof val === 'number' && Number.isFinite(val);
}

function validateCoordinateTree(val, depth = 0) {
  if (depth > 12) return false;
  if (typeof val === 'number') return Number.isFinite(val) && Math.abs(val) <= 1e6;
  if (Array.isArray(val)) return val.length <= 100 && val.every(item => validateCoordinateTree(item, depth + 1));
  if (val && typeof val === 'object') {
    const proto = Object.getPrototypeOf(val);
    return (proto === Object.prototype || proto === null) && Object.keys(val).length <= 100
      && Object.values(val).every(item => validateCoordinateTree(item, depth + 1));
  }
  return false;
}
function coordinateJson(value, code) {
  if (!validateCoordinateTree(value)) throw new PointError(400, code);
  const text = JSON.stringify(value);
  if (text.length > 16000) throw new PointError(400, code);
  return JSON.parse(text);
}

function normalizeScenePoint(sceneId, rawPoint) {
  if (!rawPoint || typeof rawPoint !== 'object' || Array.isArray(rawPoint)) {
    throw new PointError(400, 'INVALID_POINT_PAYLOAD');
  }

  if (!isCanonicalUuid(sceneId)) {
    throw new PointError(400, 'INVALID_SCENE_ID');
  }
  const canonicalSceneId = canonicalizeUuid(sceneId);

  if (rawPoint.sceneId !== undefined) {
    if (
      rawPoint.sceneId === null ||
      typeof rawPoint.sceneId !== 'string' ||
      !isCanonicalUuid(rawPoint.sceneId) ||
      canonicalizeUuid(rawPoint.sceneId) !== canonicalSceneId
    ) {
      throw new PointError(400, 'SCENE_ID_MISMATCH');
    }
  }

  if (!rawPoint.id || !isCanonicalUuid(rawPoint.id)) {
    throw new PointError(400, 'INVALID_POINT_ID');
  }
  const canonicalPointId = canonicalizeUuid(rawPoint.id);

  if (typeof rawPoint.label !== 'string') {
    throw new PointError(400, 'INVALID_LABEL');
  }
  const trimmedLabel = rawPoint.label.trim();
  if (!trimmedLabel || trimmedLabel.length > 160) {
    throw new PointError(400, 'INVALID_LABEL');
  }

  const VALID_TYPES = new Set(['drop-off', 'collection', 'both', 'meet-point']);
  let type = 'meet-point';
  if (rawPoint.type !== undefined && rawPoint.type !== null) {
    if (typeof rawPoint.type !== 'string' || !VALID_TYPES.has(rawPoint.type.trim())) {
      throw new PointError(400, 'INVALID_TYPE');
    }
    type = rawPoint.type.trim();
  }

  let scope = 'personal';
  if (rawPoint.scope !== undefined && rawPoint.scope !== null) {
    if (rawPoint.scope !== 'personal' && rawPoint.scope !== 'shared') {
      throw new PointError(400, 'INVALID_SCOPE');
    }
    scope = rawPoint.scope;
  }

  const pos = rawPoint.position3d;
  if (
    !pos ||
    typeof pos !== 'object' ||
    Array.isArray(pos) ||
    !isFiniteNumber(pos.x) ||
    !isFiniteNumber(pos.y) ||
    !isFiniteNumber(pos.z) ||
    Math.abs(pos.x) > 1e6 ||
    Math.abs(pos.y) > 1e6 ||
    Math.abs(pos.z) > 1e6
  ) {
    throw new PointError(400, 'INVALID_POSITION3D');
  }
  const position3d = { x: pos.x, y: pos.y, z: pos.z };

  let latlng = null;
  if (rawPoint.latlng !== undefined && rawPoint.latlng !== null) {
    const ll = rawPoint.latlng;
    let lat, lng;
    if (Array.isArray(ll) && ll.length === 2) {
      lat = ll[0];
      lng = ll[1];
    } else if (ll && typeof ll === 'object' && !Array.isArray(ll)) {
      lat = ll.lat ?? ll.latitude;
      lng = ll.lng ?? ll.longitude;
    } else {
      throw new PointError(400, 'INVALID_LATLNG');
    }
    if (!isFiniteNumber(lat) || !isFiniteNumber(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new PointError(400, 'INVALID_LATLNG');
    }
    latlng = [lat, lng];
  }

  let notes = null;
  if (rawPoint.notes !== undefined && rawPoint.notes !== null) {
    if (typeof rawPoint.notes !== 'string' || rawPoint.notes.length > 4000) {
      throw new PointError(400, 'INVALID_NOTES');
    }
    notes = rawPoint.notes;
  }

  let buildingRef = null;
  if (rawPoint.buildingRef !== undefined && rawPoint.buildingRef !== null) {
    if (typeof rawPoint.buildingRef !== 'string' || rawPoint.buildingRef.length > 160) {
      throw new PointError(400, 'INVALID_BUILDING_REF');
    }
    buildingRef = rawPoint.buildingRef;
  }

  let contactIds = [];
  if (rawPoint.contactIds !== undefined && rawPoint.contactIds !== null) {
    if (!Array.isArray(rawPoint.contactIds)) {
      throw new PointError(400, 'INVALID_CONTACT_IDS');
    }
    if (rawPoint.contactIds.length > 20) {
      throw new PointError(400, 'INVALID_CONTACT_IDS');
    }
    const seen = new Set();
    for (const cid of rawPoint.contactIds) {
      if (!isCanonicalUuid(cid)) {
        throw new PointError(400, 'INVALID_CONTACT_IDS');
      }
      seen.add(canonicalizeUuid(cid));
    }
    contactIds = Array.from(seen);
  }

  let routeWaypoints = [];
  if (rawPoint.routeWaypoints !== undefined && rawPoint.routeWaypoints !== null) {
    if (!Array.isArray(rawPoint.routeWaypoints) || rawPoint.routeWaypoints.length > 100) {
      throw new PointError(400, 'INVALID_ROUTE_WAYPOINTS');
    }
    routeWaypoints = coordinateJson(rawPoint.routeWaypoints, 'INVALID_ROUTE_WAYPOINTS');
  }

  let routeWaypoints3d = [];
  if (rawPoint.routeWaypoints3d !== undefined && rawPoint.routeWaypoints3d !== null) {
    if (!Array.isArray(rawPoint.routeWaypoints3d) || rawPoint.routeWaypoints3d.length > 100) {
      throw new PointError(400, 'INVALID_ROUTE_WAYPOINTS3D');
    }
    routeWaypoints3d = coordinateJson(rawPoint.routeWaypoints3d, 'INVALID_ROUTE_WAYPOINTS3D');
  }

  let cameraPreset3d = null;
  if (rawPoint.cameraPreset3d !== undefined && rawPoint.cameraPreset3d !== null) {
    if (
      typeof rawPoint.cameraPreset3d !== 'object' ||
      Array.isArray(rawPoint.cameraPreset3d)
    ) {
      throw new PointError(400, 'INVALID_CAMERA_PRESET3D');
    }
    cameraPreset3d = coordinateJson(rawPoint.cameraPreset3d, 'INVALID_CAMERA_PRESET3D');
  }

  return {
    id: canonicalPointId,
    sceneId: canonicalSceneId,
    label: trimmedLabel,
    type,
    scope,
    latlng,
    position3d,
    notes,
    contactIds,
    routeWaypoints,
    routeWaypoints3d,
    cameraPreset3d,
    buildingRef,
  };
}

function pointToJsonWithScene(r) {
  return supabaseDb.pointToJson(r);
}

async function getScenePoints(slug, sceneId) {
  if (!isCanonicalUuid(sceneId)) throw new PointError(400, 'INVALID_SCENE_ID');
  const canonicalSceneId = canonicalizeUuid(sceneId);
  const siteId = await supabaseDb.getSiteId(slug);
  const pool = supabaseDb.pool();
  const { rows } = await pool.query(
    'select * from points where site_id = $1::uuid and scene_id = $2::uuid order by created_at',
    [siteId, canonicalSceneId]
  );
  return rows.map(pointToJsonWithScene);
}

async function saveScenePoint(slug, sceneId, rawPoint, changedBy) {
  if (!isCanonicalUuid(changedBy)) throw new PointError(400, 'INVALID_ACTOR_ID');
  const canonicalActorId = canonicalizeUuid(changedBy);
  const normalized = normalizeScenePoint(sceneId, rawPoint);
  const siteId = await supabaseDb.getSiteId(slug);
  const pool = supabaseDb.pool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const sceneRes = await client.query(
      'select id from scenes where site_id = $1::uuid and id = $2::uuid for key share',
      [siteId, normalized.sceneId]
    );
    if (!sceneRes.rows.length) {
      throw new PointError(404, 'SCENE_NOT_FOUND');
    }

    if (normalized.contactIds.length > 0) {
      const contactRes = await client.query(
        'select id from contacts where site_id = $1::uuid and id = any($2::uuid[]) for key share',
        [siteId, normalized.contactIds]
      );
      const foundIds = new Set(contactRes.rows.map(r => r.id.toLowerCase()));
      for (const cid of normalized.contactIds) {
        if (!foundIds.has(cid)) {
          throw new PointError(400, 'INVALID_CONTACT_REFERENCE');
        }
      }
    }

    const upsertSql = `
      insert into points (
        id, site_id, scene_id, label, type, scope, latlng, position3d, notes,
        contact_ids, route_waypoints, route_waypoints3d, camera_preset3d, building_ref, created_by
      )
      values (
        $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb, $9,
        $10::uuid[], $11::jsonb, $12::jsonb, $13::jsonb, $14, $15
      )
      on conflict (id) do update set
        label = excluded.label,
        type = excluded.type,
        scope = excluded.scope,
        latlng = excluded.latlng,
        position3d = excluded.position3d,
        notes = excluded.notes,
        contact_ids = excluded.contact_ids,
        route_waypoints = excluded.route_waypoints,
        route_waypoints3d = excluded.route_waypoints3d,
        camera_preset3d = excluded.camera_preset3d,
        building_ref = excluded.building_ref,
        updated_at = now()
      where points.site_id = excluded.site_id
        and points.scene_id is not distinct from excluded.scene_id
      returning *`;

    const upsertParams = [
      normalized.id,
      siteId,
      normalized.sceneId,
      normalized.label,
      normalized.type,
      normalized.scope,
      supabaseDb.j(normalized.latlng),
      supabaseDb.j(normalized.position3d),
      normalized.notes,
      normalized.contactIds,
      supabaseDb.j(normalized.routeWaypoints),
      supabaseDb.j(normalized.routeWaypoints3d),
      supabaseDb.j(normalized.cameraPreset3d),
      normalized.buildingRef,
      canonicalActorId,
    ];

    const { rows } = await client.query(upsertSql, upsertParams);
    if (!rows.length) {
      throw new PointError(409, 'POINT_CONFLICT');
    }

    const saved = pointToJsonWithScene(rows[0]);

    await client.query(
      `insert into audit_log (site_id, changed_by, action, entity_type, entity_id, entity_label)
       values ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)`,
      [siteId, canonicalActorId, 'save', 'point', saved.id, saved.label]
    );

    await client.query('COMMIT');
    return saved;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function deleteScenePoint(slug, sceneId, id, changedBy) {
  if (!isCanonicalUuid(sceneId)) throw new PointError(400, 'INVALID_SCENE_ID');
  if (!isCanonicalUuid(id)) throw new PointError(400, 'INVALID_POINT_ID');
  if (!isCanonicalUuid(changedBy)) throw new PointError(400, 'INVALID_ACTOR_ID');

  const canonicalSceneId = canonicalizeUuid(sceneId);
  const canonicalPointId = canonicalizeUuid(id);
  const canonicalActorId = canonicalizeUuid(changedBy);
  const siteId = await supabaseDb.getSiteId(slug);
  const pool = supabaseDb.pool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const pointRes = await client.query(
      'select id, label from points where site_id = $1::uuid and scene_id = $2::uuid and id = $3::uuid for update',
      [siteId, canonicalSceneId, canonicalPointId]
    );
    if (!pointRes.rows.length) throw new PointError(404, 'POINT_NOT_FOUND');

    // Storage cannot participate in the Postgres transaction. Never destroy
    // photo bytes before the point delete commits. Require explicit authorized
    // photo removal first; the media-authorization slice owns that workflow.
    const photoRes = await client.query(
      'select 1 from point_photos where site_id = $1::uuid and point_id = $2::uuid limit 1',
      [siteId, canonicalPointId]
    );
    if (photoRes.rows.length) throw new PointError(409, 'POINT_HAS_PHOTOS');

    const pointLabel = pointRes.rows[0].label;
    await client.query(
      'delete from points where site_id = $1::uuid and scene_id = $2::uuid and id = $3::uuid',
      [siteId, canonicalSceneId, canonicalPointId]
    );
    await client.query(
      `insert into audit_log (site_id, changed_by, action, entity_type, entity_id, entity_label)
       values ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)`,
      [siteId, canonicalActorId, 'delete', 'point', canonicalPointId, pointLabel]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  PointError,
  UUID_RE,
  normalizeScenePoint,
  getScenePoints,
  saveScenePoint,
  deleteScenePoint,
};
