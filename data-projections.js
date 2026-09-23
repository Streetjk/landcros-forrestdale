'use strict';

function cloneJsonValue(value) {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)])
  );
}

function from(row, camel, db = camel) {
  return row[camel] !== undefined ? row[camel] : row[db];
}

function staffPoint(row) {
  if (!row) return null;
  return {
    id: row.id,
    sceneId: from(row, 'sceneId', 'scene_id') ?? null,
    label: row.label,
    type: row.type,
    scope: row.scope,
    latlng: cloneJsonValue(row.latlng),
    position3d: cloneJsonValue(row.position3d),
    notes: row.notes,
    contactIds: cloneJsonValue(from(row, 'contactIds', 'contact_ids')),
    routeWaypoints: cloneJsonValue(from(row, 'routeWaypoints', 'route_waypoints')),
    routeWaypoints3d: cloneJsonValue(from(row, 'routeWaypoints3d', 'route_waypoints3d')),
    cameraPreset3d: cloneJsonValue(from(row, 'cameraPreset3d', 'camera_preset3d')),
    buildingRef: from(row, 'buildingRef', 'building_ref'),
    createdBy: from(row, 'createdBy', 'created_by'),
    createdAt: from(row, 'createdAt', 'created_at'),
    updatedAt: from(row, 'updatedAt', 'updated_at'),
  };
}

function publicPointCore(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    type: row.type,
    scope: row.scope,
    latlng: cloneJsonValue(row.latlng),
    position3d: cloneJsonValue(row.position3d),
    notes: row.notes,
    contactIds: cloneJsonValue(from(row, 'contactIds', 'contact_ids')),
    routeWaypoints: cloneJsonValue(from(row, 'routeWaypoints', 'route_waypoints')),
    routeWaypoints3d: cloneJsonValue(from(row, 'routeWaypoints3d', 'route_waypoints3d')),
    cameraPreset3d: cloneJsonValue(from(row, 'cameraPreset3d', 'camera_preset3d')),
    buildingRef: from(row, 'buildingRef', 'building_ref'),
  };
}

function publicBasePoint(row) {
  return publicPointCore(row);
}

function publicSharedPoint(row) {
  const out = publicPointCore(row);
  if (!out) return null;
  const raw = from(row, 'phoneOverride', 'phone_override');
  if (typeof raw === 'string' && raw.trim()) out.phoneOverride = raw.trim();
  return out;
}

function staffContact(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    phone: row.phone,
    email: row.email,
    active: row.active,
    createdBy: from(row, 'createdBy', 'created_by'),
    createdAt: from(row, 'createdAt', 'created_at'),
  };
}

function publicContact(row, { phoneOverride = null } = {}) {
  if (!row) return null;
  const override = typeof phoneOverride === 'string' ? phoneOverride.trim() : '';
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    phone: override || row.phone,
    active: row.active,
  };
}

function publicPointPhoto(row) {
  if (!row) return null;
  return {
    id: row.id,
    pointId: from(row, 'pointId', 'point_id'),
    contentType: 'image/jpeg',
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    expiresAt: from(row, 'expiresAt', 'expires_at'),
  };
}

module.exports = {
  staffPoint,
  publicBasePoint,
  publicSharedPoint,
  staffContact,
  publicContact,
  publicPointPhoto,
};
