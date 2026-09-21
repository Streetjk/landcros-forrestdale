import {
  listMyPinsScenes,
  ensureMyPinsScene,
  listAccountPins,
  saveAccountPin,
  deleteAccountPin,
  buildLegacyImportPlan,
  listAccountPinPhotos,
  uploadAccountPinPhoto,
  setAccountPinPhotoRetention,
  deleteAccountPinPhoto,
  getAccountPinPhotoUrl,
  MyPinsError
} from './my-pins-client.js';

const ALLOWED_PIN_KEYS = [
  'id',
  'label',
  'type',
  'scope',
  'latlng',
  'position3d',
  'notes',
  'contactIds',
  'routeWaypoints',
  'routeWaypoints3d',
  'cameraPreset3d',
  'buildingRef'
];

function deepClone(val) {
  if (val === undefined) return val;
  return typeof structuredClone === 'function' ? structuredClone(val) : JSON.parse(JSON.stringify(val));
}
function verifySavedPoint(saved, requested, sceneId) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)
      || typeof saved.id !== 'string' || typeof saved.sceneId !== 'string'
      || saved.id.toLowerCase() !== String(requested.id).toLowerCase()
      || saved.sceneId.toLowerCase() !== String(sceneId).toLowerCase()) {
    throw new MyPinsError(200, 'MALFORMED_RESPONSE');
  }
}
function verifyReadback(saved, pins) {
  if (!Array.isArray(pins)) throw new MyPinsError(200, 'MALFORMED_RESPONSE');
  const readback = pins.find(pin => pin?.id === saved.id && pin.sceneId === saved.sceneId);
  const keys = ['label', 'scope', 'position3d', 'contactIds', 'notes'];
  if (!readback || keys.some(key => JSON.stringify(readback[key] ?? null) !== JSON.stringify(saved[key] ?? null))) {
    throw new MyPinsError(200, 'SAVE_NOT_VERIFIED');
  }
  return readback;
}

async function verifySessionIdentity(fetchFn, expectedEmail) {
  let res;
  try {
    res = await fetchFn('/api/auth/me', {
      method: 'GET',
      credentials: 'same-origin', cache: 'no-store'
    });
  } catch (_e) {
    throw new MyPinsError(0, 'NETWORK_ERROR');
  }

  if (!res || !res.ok) {
    const status = res ? res.status : 0;
    if (status === 401) {
      throw new MyPinsError(401, 'UNAUTHORIZED');
    }
    if (status === 403) {
      throw new MyPinsError(403, 'SESSION_CHANGED');
    }
    throw new MyPinsError(status, 'HTTP_ERROR');
  }

  let data;
  try {
    data = await res.json();
  } catch (_e) {
    throw new MyPinsError(res.status, 'MALFORMED_RESPONSE');
  }

  if (!data || typeof data !== 'object' || typeof data.email !== 'string') {
    throw new MyPinsError(200, 'MALFORMED_RESPONSE');
  }

  if (data.email.trim().toLowerCase() !== String(expectedEmail).trim().toLowerCase()) {
    throw new MyPinsError(403, 'SESSION_CHANGED');
  }

  return data;
}

export function createMyPinsSession(slug, options = {}) {
  const {
    identity,
    fetchFn = globalThis.fetch,
    storage,
    api: injectedApi
  } = options;

  if (!identity || typeof identity !== 'string' || identity.trim() === '') {
    throw new MyPinsError(0, 'INVALID_INPUT');
  }

  const api = {
    listMyPinsScenes,
    ensureMyPinsScene,
    listAccountPins,
    saveAccountPin,
    deleteAccountPin,
    buildLegacyImportPlan,
    listAccountPinPhotos,
    uploadAccountPinPhoto,
    setAccountPinPhotoRetention,
    deleteAccountPinPhoto,
    getAccountPinPhotoUrl,
    ...injectedApi
  };

  const state = {
    scene: null,
    pins: [],
    duplicates: 0,
    busy: false,
    loaded: false
  };

  function getState() {
    return deepClone(state);
  }

  function normalizePinPayload(point, sceneId) {
    if (!point || typeof point !== 'object' || Array.isArray(point)) {
      throw new MyPinsError(0, 'INVALID_INPUT');
    }

    const normalized = {};
    for (const key of ALLOWED_PIN_KEYS) {
      if (Object.prototype.hasOwnProperty.call(point, key) && point[key] !== undefined) {
        normalized[key] = deepClone(point[key]);
      }
    }

    if (!normalized.scope) {
      normalized.scope = 'personal';
    }
    normalized.sceneId = sceneId;
    return normalized;
  }

  async function load() {
    if (state.busy) {
      throw new MyPinsError(0, 'BUSY');
    }
    state.busy = true;
    try {
      await verifySessionIdentity(fetchFn, identity);

      const scenes = await api.listMyPinsScenes(slug, { fetchFn });
      let selectedScene = null;
      let duplicatesCount = 0;
      let loadedPins = [];

      if (!Array.isArray(scenes)) throw new MyPinsError(200, 'MALFORMED_RESPONSE');
      if (scenes.length > 0) {
        selectedScene = scenes[0];
        duplicatesCount = Math.max(0, scenes.length - 1);
        loadedPins = await api.listAccountPins(slug, selectedScene.id, { fetchFn });
      }

      if (!Array.isArray(loadedPins)) throw new MyPinsError(200, 'MALFORMED_RESPONSE');
      state.scene = selectedScene;
      state.duplicates = duplicatesCount;
      state.pins = loadedPins;
      state.loaded = true;

      return getState();
    } finally {
      state.busy = false;
    }
  }

  async function save(point) {
    if (state.busy) {
      throw new MyPinsError(0, 'BUSY');
    }
    state.busy = true;
    try {
      await verifySessionIdentity(fetchFn, identity);

      let scene = state.scene;
      if (!scene) {
        const ensured = await api.ensureMyPinsScene(slug, { fetchFn });
        if (!ensured || !ensured.scene) {
          throw new MyPinsError(200, 'MALFORMED_RESPONSE');
        }
        scene = ensured.scene;
        state.scene = scene;
        state.duplicates = ensured.duplicates || 0;
      }

      let effectiveScope = point && point.scope;
      if (!effectiveScope && point && point.id) {
        const existing = state.pins.find(p => p.id === point.id);
        if (existing && existing.scope) {
          effectiveScope = existing.scope;
        }
      }

      const payload = normalizePinPayload(
        effectiveScope ? { ...point, scope: effectiveScope } : point,
        scene.id
      );

      await verifySessionIdentity(fetchFn, identity);
      const saved = await api.saveAccountPin(slug, scene.id, payload, { fetchFn });

      verifySavedPoint(saved, payload, scene.id);
      const readback = await api.listAccountPins(slug, scene.id, { fetchFn });
      verifyReadback(saved, readback);
      state.pins = readback;
      state.loaded = true;

      return deepClone(saved);
    } finally {
      state.busy = false;
    }
  }

  async function remove(id) {
    if (state.busy) {
      throw new MyPinsError(0, 'BUSY');
    }
    state.busy = true;
    try {
      await verifySessionIdentity(fetchFn, identity);

      if (!state.scene || !state.scene.id || !id) {
        throw new MyPinsError(0, 'INVALID_INPUT');
      }

      await api.deleteAccountPin(slug, state.scene.id, id, { fetchFn });
      state.pins = state.pins.filter(p => p.id !== id);
    } finally {
      state.busy = false;
    }
  }

  async function importLegacy(confirmFn) {
    if (typeof confirmFn !== 'function') {
      throw new MyPinsError(0, 'INVALID_INPUT');
    }

    if (state.busy) {
      throw new MyPinsError(0, 'BUSY');
    }
    state.busy = true;
    try {
      const plan = api.buildLegacyImportPlan(storage ?? null);
      const sourcePins = (plan && Array.isArray(plan.pins)) ? plan.pins : [];

      const uniqueMap = new Map();
      for (const p of sourcePins) {
        if (!p || !p.id) continue;
        const lower = String(p.id).toLowerCase();
        if (!uniqueMap.has(lower)) {
          uniqueMap.set(lower, { ...p, id: lower });
        }
      }
      const dedupedPins = Array.from(uniqueMap.values());

      if (dedupedPins.length === 0) {
        return {
          imported: 0,
          skipped: 0,
          failed: 0,
          verified: 0,
          cancelled: false
        };
      }

      const confirmPayload = {
        email: identity,
        count: dedupedPins.length,
        labels: dedupedPins.map(p => p.label).filter(Boolean)
      };

      const confirmed = await confirmFn(confirmPayload);
      if (!confirmed) {
        return {
          imported: 0,
          skipped: 0,
          failed: 0,
          verified: 0,
          cancelled: true
        };
      }

      await verifySessionIdentity(fetchFn, identity);

      let scene = state.scene;
      if (!scene) {
        const ensured = await api.ensureMyPinsScene(slug, { fetchFn });
        if (!ensured || !ensured.scene) {
          throw new MyPinsError(200, 'MALFORMED_RESPONSE');
        }
        scene = ensured.scene;
        state.scene = scene;
        state.duplicates = ensured.duplicates || 0;
      }

      const existingServerPins = await api.listAccountPins(slug, scene.id, { fetchFn });
      const existingIds = new Set((existingServerPins || []).map(p => String(p.id).toLowerCase()));

      let skipped = 0;
      let successfulSaves = 0;
      let failed = 0;
      const savedPoints = [];

      for (const pin of dedupedPins) {
        if (existingIds.has(String(pin.id).toLowerCase())) {
          skipped++;
          continue;
        }

        await verifySessionIdentity(fetchFn, identity);

        const payload = normalizePinPayload(pin, scene.id);
        payload.scope = 'personal';

        try {
          const saved = await api.saveAccountPin(slug, scene.id, payload, { fetchFn, createOnly: true });
          verifySavedPoint(saved, payload, scene.id);
          successfulSaves++;
          savedPoints.push(saved);
        } catch (err) {
          if (err instanceof MyPinsError && (err.status === 401 || err.status === 403)) throw err;
          if (err instanceof MyPinsError && err.status === 409) {
            // A concurrent import/save may have won after our initial list.
            // Re-read only this account scene: if the ID now exists here it is
            // safely "already present"; a conflict elsewhere remains a failure.
            const racedPins = await api.listAccountPins(slug, scene.id, { fetchFn });
            if (Array.isArray(racedPins) && racedPins.some(existing => String(existing?.id).toLowerCase() === String(pin.id).toLowerCase())) {
              existingIds.add(String(pin.id).toLowerCase()); skipped++; continue;
            }
          }
          failed++;
        }
      }

      const readbackPins = await api.listAccountPins(slug, scene.id, { fetchFn });
      if (!Array.isArray(readbackPins)) {
        throw new MyPinsError(200, 'MALFORMED_RESPONSE');
      }

      const verifiedCount = savedPoints.filter(saved => {
        try { verifyReadback(saved, readbackPins); return true; } catch { return false; }
      }).length;

      state.pins = readbackPins;
      state.loaded = true;

      return {
        imported: successfulSaves,
        skipped,
        failed,
        verified: verifiedCount,
        cancelled: false
      };
    } finally {
      state.busy = false;
    }
  }

  function _findOwnedPin(pointId) {
    if (!pointId || typeof pointId !== 'string') {
      throw new MyPinsError(0, 'INVALID_INPUT');
    }
    const pin = state.pins.find(p => String(p?.id).toLowerCase() === String(pointId).toLowerCase());
    if (!pin) {
      throw new MyPinsError(0, 'INVALID_INPUT');
    }
    return pin;
  }

  function _getAuthoritativeScene() {
    const scene = state.scene;
    if (!scene || !scene.id) {
      throw new MyPinsError(0, 'INVALID_INPUT');
    }
    return scene;
  }

  function getOwnedSceneId() {
    return state.scene?.id || null;
  }

  async function listPhotos(pointId) {
    await verifySessionIdentity(fetchFn, identity);
    const pin = _findOwnedPin(pointId);
    const scene = _getAuthoritativeScene();
    return await api.listAccountPinPhotos(slug, scene.id, pin.id, { fetchFn });
  }

  async function uploadPhoto(pointId, body) {
    if (!body) {
      throw new MyPinsError(0, 'INVALID_INPUT');
    }
    if (state.busy) {
      throw new MyPinsError(0, 'BUSY');
    }
    state.busy = true;
    try {
      await verifySessionIdentity(fetchFn, identity);
      const pin = _findOwnedPin(pointId);
      const scene = _getAuthoritativeScene();
      const photo = await api.uploadAccountPinPhoto(slug, scene.id, pin.id, body, { fetchFn });
      return deepClone(photo);
    } finally {
      state.busy = false;
    }
  }

  async function setPhotoRetention(pointId, photoId, keepIndefinitely) {
    if (!photoId || typeof photoId !== 'string') {
      throw new MyPinsError(0, 'INVALID_INPUT');
    }
    if (state.busy) {
      throw new MyPinsError(0, 'BUSY');
    }
    state.busy = true;
    try {
      await verifySessionIdentity(fetchFn, identity);
      const pin = _findOwnedPin(pointId);
      const scene = _getAuthoritativeScene();
      const updated = await api.setAccountPinPhotoRetention(slug, scene.id, pin.id, photoId, keepIndefinitely, { fetchFn });
      return deepClone(updated);
    } finally {
      state.busy = false;
    }
  }

  async function deletePhoto(pointId, photoId) {
    if (!photoId || typeof photoId !== 'string') {
      throw new MyPinsError(0, 'INVALID_INPUT');
    }
    if (state.busy) {
      throw new MyPinsError(0, 'BUSY');
    }
    state.busy = true;
    try {
      await verifySessionIdentity(fetchFn, identity);
      const pin = _findOwnedPin(pointId);
      const scene = _getAuthoritativeScene();
      return await api.deleteAccountPinPhoto(slug, scene.id, pin.id, photoId, { fetchFn });
    } finally {
      state.busy = false;
    }
  }

  function getPhotoUrl(pointId, photoId, { original = false } = {}) {
    const pin = _findOwnedPin(pointId);
    if (!photoId || typeof photoId !== 'string') {
      throw new MyPinsError(0, 'INVALID_INPUT');
    }
    const scene = _getAuthoritativeScene();
    return api.getAccountPinPhotoUrl(slug, scene.id, pin.id, photoId, { original });
  }

  return {
    load,
    save,
    remove,
    importLegacy,
    getState,
    listPhotos,
    uploadPhoto,
    setPhotoRetention,
    deletePhoto,
    getPhotoUrl,
    getOwnedSceneId
  };
}
