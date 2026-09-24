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


function staffSite(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    title: row.title ?? null,
    published: row.published === true,
    createdAt: from(row, 'createdAt', 'created_at') ?? null,
  };
}

function staffScene(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    shareCode: from(row, 'shareCode', 'share_code'),
    camera: cloneJsonValue(row.camera),
    kind: row.kind || 'admin',
    status: row.status || 'open',
    statusChangedAt: from(row, 'statusChangedAt', 'status_changed_at') ?? null,
    statusChangedByEmail: from(row, 'statusChangedByEmail', 'status_changed_by_email') ?? null,
    createdBy: from(row, 'createdBy', 'created_by') ?? null,
    createdByEmail: from(row, 'createdByEmail', 'created_by_email') ?? null,
    isMine: from(row, 'isMine', 'is_mine') ?? null,
    subscribed: row.subscribed ?? null,
    createdAt: from(row, 'createdAt', 'created_at'),
    updatedAt: from(row, 'updatedAt', 'updated_at'),
  };
}

function publicSharedScene(row, { includeAuditEmails = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    camera: cloneJsonValue(row.camera),
    kind: row.kind || 'admin',
    status: row.status || 'open',
    statusChangedAt: from(row, 'statusChangedAt', 'status_changed_at'),
    statusChangedByEmail: includeAuditEmails
      ? from(row, 'statusChangedByEmail', 'status_changed_by_email')
      : null,
    createdByEmail: includeAuditEmails
      ? from(row, 'createdByEmail', 'created_by_email')
      : null,
  };
}

function publicMyPinScene(row) {
  if (!row) return null;
  return {
    name: row.name,
    kind: row.kind || 'admin',
  };
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
  if (!row) return null;
  const camelSceneId = row.sceneId;
  const dbSceneId = row.scene_id;
  if ((camelSceneId !== undefined && camelSceneId !== null) ||
      (dbSceneId !== undefined && dbSceneId !== null) ||
      row.scope !== 'shared') return null;
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


function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function legacyString(value, max = 500) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : '';
}

function legacyPosition3d(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const x = finiteNumber(value.x), y = finiteNumber(value.y), z = finiteNumber(value.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function legacyLatlng(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lat = finiteNumber(value[0]), lng = finiteNumber(value[1]);
  return lat === null || lng === null ? null : [lat, lng];
}

function legacyCameraPreset(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const position = legacyPosition3d(value.position);
  const lookAt = legacyPosition3d(value.lookAt);
  return position && lookAt ? { position, lookAt } : null;
}

function legacyContact(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const id = legacyString(row.id, 128);
  const name = legacyString(row.name, 160);
  if (!id || !name) return null;
  const out = { id, name };
  const role = legacyString(row.role, 160);
  const phone = legacyString(row.phone, 80);
  if (role !== null) out.role = role;
  if (phone !== null) out.phone = phone;
  out.active = row.active === true;
  return out;
}

function projectLegacySharePinData(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const id = legacyString(row.id, 128);
  const label = legacyString(row.label, 200);
  if (!id || label === null) return null;
  const out = {
    id,
    label,
    type: legacyString(row.type, 80) || 'drop-off',
    scope: 'shared',
  };
  const notes = legacyString(row.notes, 4000);
  const latlng = legacyLatlng(row.latlng);
  const position3d = legacyPosition3d(row.position3d);
  const cameraPreset3d = legacyCameraPreset(row.cameraPreset3d);
  const buildingRef = legacyString(row.buildingRef, 160);
  const phoneOverride = legacyString(row.phoneOverride, 80);
  if (notes !== null) out.notes = notes;
  if (latlng) out.latlng = latlng;
  if (position3d) out.position3d = position3d;
  if (cameraPreset3d) out.cameraPreset3d = cameraPreset3d;
  if (buildingRef !== null) out.buildingRef = buildingRef;
  if (phoneOverride) out.phoneOverride = phoneOverride;

  const contactIds = Array.isArray(row.contactIds)
    ? row.contactIds.map(value => legacyString(value, 128)).filter(Boolean).slice(0, 64)
    : [];
  out.contactIds = contactIds;

  const routeWaypoints = Array.isArray(row.routeWaypoints)
    ? row.routeWaypoints.map(legacyLatlng).filter(Boolean).slice(0, 256)
    : [];
  const routeWaypoints3d = Array.isArray(row.routeWaypoints3d)
    ? row.routeWaypoints3d.map(legacyPosition3d).filter(Boolean).slice(0, 256)
    : [];
  out.routeWaypoints = routeWaypoints;
  out.routeWaypoints3d = routeWaypoints3d;
  out.contacts = Array.isArray(row.contacts)
    ? row.contacts.map(legacyContact).filter(Boolean).slice(0, 64)
    : [];
  return out;
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
  staffSite,
  staffScene,
  publicSharedScene,
  publicMyPinScene,
  staffPoint,
  publicBasePoint,
  publicSharedPoint,
  staffContact,
  publicContact,
  projectLegacySharePinData,
  publicPointPhoto,
};
