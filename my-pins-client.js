export const MY_PINS_PURPOSE = 'my-pins-v1';

export class MyPinsError extends Error {
  constructor(status, code) {
    super(`MyPins operation failed with code: ${code}`);
    this.name = 'MyPinsError';
    this.status = status;
    this.code = code;
  }
}

function mapHttpErrorCode(status) {
  switch (status) {
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    default:
      return 'HTTP_ERROR';
  }
}

async function performRequest(url, options, fetchFn) {
  let res;
  try {
    res = await fetchFn(url, options);
  } catch (_networkErr) {
    throw new MyPinsError(0, 'NETWORK_ERROR');
  }

  if (!res || !res.ok) {
    const status = res ? res.status : 0;
    let code = mapHttpErrorCode(status);
    // Narrow stable error allowlist; never surface arbitrary server text.
    if (status === 409) {
      const body = await res.json().catch(() => null);
      if (body?.error === 'POINT_HAS_PHOTOS') code = 'POINT_HAS_PHOTOS';
      else if (body?.error === 'PHOTO_LIMIT') code = 'PHOTO_LIMIT';
    } else if (status === 413) {
      code = 'PHOTO_TOO_LARGE';
    } else if (status === 400) {
      const body = await res.json().catch(() => null);
      if (body?.error === 'PHOTO_BAD_TYPE') code = 'PHOTO_BAD_TYPE';
    }
    throw new MyPinsError(status, code);
  }

  try {
    return await res.json();
  } catch (_jsonErr) {
    throw new MyPinsError(res.status, 'MALFORMED_RESPONSE');
  }
}

export function isMyPinsScene(scene) {
  if (!scene || typeof scene !== 'object') return false;
  if (scene.isMine !== true) return false;
  let camera = scene.camera;
  if (typeof camera === 'string') {
    try {
      camera = JSON.parse(camera);
    } catch (_e) {
      return false;
    }
  }
  if (!camera || typeof camera !== 'object') return false;
  return camera.purpose === MY_PINS_PURPOSE;
}

export async function listMyPinsScenes(slug, { fetchFn = globalThis.fetch } = {}) {
  if (!slug) {
    throw new MyPinsError(0, 'INVALID_INPUT');
  }
  const url = `/api/sites/${encodeURIComponent(slug)}/scenes?kind=admin`;
  const data = await performRequest(url, {
    method: 'GET',
    credentials: 'same-origin'
  }, fetchFn);

  if (!Array.isArray(data)) {
    throw new MyPinsError(200, 'MALFORMED_RESPONSE');
  }

  const matching = data.filter(isMyPinsScene);
  matching.sort((a, b) => {
    const parse = value => { const t = value ? Date.parse(value) : NaN; return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER; };
    const delta = parse(a.createdAt) - parse(b.createdAt);
    return delta || String(a.id || '').localeCompare(String(b.id || ''));
  });

  return matching;
}

export async function ensureMyPinsScene(slug, { fetchFn = globalThis.fetch } = {}) {
  const existing = await listMyPinsScenes(slug, { fetchFn });
  if (existing.length > 0) {
    return {
      scene: existing[0],
      created: false,
      duplicates: existing.length - 1
    };
  }

  const url = `/api/sites/${encodeURIComponent(slug)}/scenes`;
  const payload = {
    name: 'My pins',
    kind: 'admin',
    camera: {
      purpose: MY_PINS_PURPOSE
    }
  };

  const createdScene = await performRequest(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  }, fetchFn);

  if (!createdScene || typeof createdScene !== 'object') {
    throw new MyPinsError(200, 'MALFORMED_RESPONSE');
  }

  if (!createdScene.id || !createdScene.shareCode) {
    throw new MyPinsError(200, 'MALFORMED_RESPONSE');
  }

  if (createdScene.isMine !== undefined && createdScene.isMine !== null && createdScene.isMine !== true) {
    throw new MyPinsError(200, 'MALFORMED_RESPONSE');
  }

  let camera = createdScene.camera;
  if (typeof camera === 'string') {
    try {
      camera = JSON.parse(camera);
    } catch (_e) {
      throw new MyPinsError(200, 'MALFORMED_RESPONSE');
    }
  }
  if (!camera || typeof camera !== 'object' || camera.purpose !== MY_PINS_PURPOSE) {
    throw new MyPinsError(200, 'MALFORMED_RESPONSE');
  }

  return {
    scene: createdScene,
    created: true,
    duplicates: 0
  };
}

export async function listAccountPins(slug, sceneId, { fetchFn = globalThis.fetch } = {}) {
  if (!slug || !sceneId) {
    throw new MyPinsError(0, 'INVALID_INPUT');
  }
  const url = `/api/sites/${encodeURIComponent(slug)}/scenes/${encodeURIComponent(sceneId)}/points`;
  const data = await performRequest(url, {
    method: 'GET',
    credentials: 'same-origin'
  }, fetchFn);

  if (!Array.isArray(data)) {
    throw new MyPinsError(200, 'MALFORMED_RESPONSE');
  }
  return data;
}

export async function saveAccountPin(slug, sceneId, point, { fetchFn = globalThis.fetch, createOnly = false } = {}) {
  if (!slug || !sceneId || !point || typeof point !== 'object' || Array.isArray(point)) {
    throw new MyPinsError(0, 'INVALID_INPUT');
  }
  const url = `/api/sites/${encodeURIComponent(slug)}/scenes/${encodeURIComponent(sceneId)}/points`;
  const saved = await performRequest(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(createOnly ? { 'If-None-Match': '*' } : {})
    },
    body: JSON.stringify(point)
  }, fetchFn);

  if (!saved || typeof saved !== 'object' || !saved.id) {
    throw new MyPinsError(200, 'MALFORMED_RESPONSE');
  }
  return saved;
}

export async function deleteAccountPin(slug, sceneId, pointId, { fetchFn = globalThis.fetch } = {}) {
  if (!slug || !sceneId || !pointId) {
    throw new MyPinsError(0, 'INVALID_INPUT');
  }
  const url = `/api/sites/${encodeURIComponent(slug)}/scenes/${encodeURIComponent(sceneId)}/points/${encodeURIComponent(pointId)}`;
  const res = await performRequest(url, {
    method: 'DELETE',
    credentials: 'same-origin'
  }, fetchFn);

  if (!res || res.ok !== true) {
    throw new MyPinsError(200, 'MALFORMED_RESPONSE');
  }
  return res;
}

export async function listAccountPinPhotos(slug, sceneId, pointId, { fetchFn = globalThis.fetch } = {}) {
  if (!slug || !sceneId || !pointId) {
    throw new MyPinsError(0, 'INVALID_INPUT');
  }
  const url = `/api/sites/${encodeURIComponent(slug)}/scenes/${encodeURIComponent(sceneId)}/points/${encodeURIComponent(pointId)}/photos`;
  const data = await performRequest(url, {
    method: 'GET',
    credentials: 'same-origin'
  }, fetchFn);

  if (!Array.isArray(data)) {
    throw new MyPinsError(200, 'MALFORMED_RESPONSE');
  }
  return data;
}

export async function uploadAccountPinPhoto(slug, sceneId, pointId, body, { fetchFn = globalThis.fetch } = {}) {
  if (!slug || !sceneId || !pointId || !body) {
    throw new MyPinsError(0, 'INVALID_INPUT');
  }
  const url = `/api/sites/${encodeURIComponent(slug)}/scenes/${encodeURIComponent(sceneId)}/points/${encodeURIComponent(pointId)}/photos`;
  const data = await performRequest(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/octet-stream'
    },
    body
  }, fetchFn);

  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.id) {
    throw new MyPinsError(200, 'MALFORMED_RESPONSE');
  }
  return data;
}

export async function setAccountPinPhotoRetention(slug, sceneId, pointId, photoId, keepIndefinitely, { fetchFn = globalThis.fetch } = {}) {
  if (!slug || !sceneId || !pointId || !photoId) {
    throw new MyPinsError(0, 'INVALID_INPUT');
  }
  const url = `/api/sites/${encodeURIComponent(slug)}/scenes/${encodeURIComponent(sceneId)}/points/${encodeURIComponent(pointId)}/photos/${encodeURIComponent(photoId)}`;
  const data = await performRequest(url, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ keepIndefinitely: Boolean(keepIndefinitely) })
  }, fetchFn);

  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.id) {
    throw new MyPinsError(200, 'MALFORMED_RESPONSE');
  }
  return data;
}

export async function deleteAccountPinPhoto(slug, sceneId, pointId, photoId, { fetchFn = globalThis.fetch } = {}) {
  if (!slug || !sceneId || !pointId || !photoId) {
    throw new MyPinsError(0, 'INVALID_INPUT');
  }
  const url = `/api/sites/${encodeURIComponent(slug)}/scenes/${encodeURIComponent(sceneId)}/points/${encodeURIComponent(pointId)}/photos/${encodeURIComponent(photoId)}`;
  const res = await performRequest(url, {
    method: 'DELETE',
    credentials: 'same-origin'
  }, fetchFn);

  if (!res || res.ok !== true) {
    throw new MyPinsError(200, 'MALFORMED_RESPONSE');
  }
  return res;
}

export function getAccountPinPhotoUrl(slug, sceneId, pointId, photoId, { original = false } = {}) {
  if (!slug || !sceneId || !pointId || !photoId) {
    throw new MyPinsError(0, 'INVALID_INPUT');
  }
  const base = `/api/sites/${encodeURIComponent(slug)}/scenes/${encodeURIComponent(sceneId)}/points/${encodeURIComponent(pointId)}/photos/${encodeURIComponent(photoId)}`;
  return original ? `${base}?original=1` : base;
}

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isPlainObject(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function readLegacyLocalPins(storage = globalThis.localStorage) {
  if (!storage || typeof storage.getItem !== 'function') {
    return [];
  }
  let raw;
  try { raw = storage.getItem('sn_user_pins'); } catch { return []; }
  if (!raw || typeof raw !== 'string') {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const validPins = [];
  for (const item of parsed) {
    if (validPins.length >= 100) break;
    if (!isPlainObject(item)) continue;

    if (typeof item.id !== 'string' || !UUID_REGEX.test(item.id)) {
      continue;
    }
    if (typeof item.label !== 'string' || item.label.trim() === '') {
      continue;
    }

    if (!Array.isArray(item.latlng) || item.latlng.length !== 2) {
      continue;
    }
    if (!isFiniteNumber(item.latlng[0]) || !isFiniteNumber(item.latlng[1])) {
      continue;
    }

    if (!isPlainObject(item.position3d)) {
      continue;
    }
    const { x, y, z } = item.position3d;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
      continue;
    }

    const pin = {
      id: item.id,
      label: item.label,
      type: item.type,
      scope: 'personal',
      latlng: [item.latlng[0], item.latlng[1]],
      position3d: { x, y, z },
      notes: item.notes,
      contactIds: item.contactIds,
      routeWaypoints: item.routeWaypoints,
      routeWaypoints3d: item.routeWaypoints3d,
      cameraPreset3d: item.cameraPreset3d,
      buildingRef: item.buildingRef
    };

    validPins.push(pin);
  }

  return validPins;
}

export function buildLegacyImportPlan(storage = globalThis.localStorage) {
  const pins = readLegacyLocalPins(storage);
  return {
    count: pins.length,
    pins,
    requiresConfirmation: true,
    sourceKey: 'sn_user_pins'
  };
}
