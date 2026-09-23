export function isRenderablePoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.id !== 'string' || value.id.trim() === '') return false;
  if (typeof value.label !== 'string' || value.label.trim() === '') return false;
  if (typeof value.type !== 'string') return false;
  const position = value.position3d;
  if (!position || typeof position !== 'object' || Array.isArray(position)) return false;
  return Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
}

export function isRenderableContact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.id === 'string' && value.id.trim() !== ''
    && typeof value.name === 'string' && value.name.trim() !== '';
}

function clonePublicValue(value) {
  if (Array.isArray(value)) return value.map(clonePublicValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, clonePublicValue(item)])
  );
}

export function projectPublicPoint(value) {
  if (!isRenderablePoint(value)) return null;
  return {
    id: value.id,
    label: value.label,
    type: value.type,
    scope: value.scope,
    latlng: clonePublicValue(value.latlng),
    position3d: clonePublicValue(value.position3d),
    notes: value.notes,
    contactIds: clonePublicValue(value.contactIds),
    routeWaypoints: clonePublicValue(value.routeWaypoints),
    routeWaypoints3d: clonePublicValue(value.routeWaypoints3d),
    cameraPreset3d: clonePublicValue(value.cameraPreset3d),
    buildingRef: value.buildingRef,
  };
}

export function projectPublicContact(value) {
  if (!isRenderableContact(value)) return null;
  return {
    id: value.id,
    name: value.name,
    role: value.role,
    phone: value.phone,
    active: value.active,
  };
}

export async function loadPublicArray(url, fetchFn = globalThis.fetch, itemValidator = null, itemProjector = null) {
  try {
    const response = await fetchFn(url);
    if (!response || !response.ok) {
      return { data: [], unavailable: true };
    }
    const parsed = await response.json();
    if (!Array.isArray(parsed)) {
      return { data: [], unavailable: true };
    }
    if (typeof itemValidator !== 'function' && typeof itemProjector !== 'function') {
      return { data: parsed, unavailable: false };
    }

    const data = [];
    let unavailable = false;
    for (const item of parsed) {
      if (typeof itemValidator === 'function' && !itemValidator(item)) {
        unavailable = true;
        continue;
      }
      if (typeof itemProjector === 'function') {
        const projected = itemProjector(item);
        if (!projected) {
          unavailable = true;
          continue;
        }
        data.push(projected);
      } else {
        data.push(item);
      }
    }
    return { data, unavailable };
  } catch {
    return { data: [], unavailable: true };
  }
}

export function renderPublicDataNotice(container, unavailable, message = null) {
  if (!container) {
    return;
  }

  const existing = container.querySelector('[data-public-data-notice]');
  if (existing) {
    existing.remove();
  }

  if (!unavailable) {
    return;
  }

  const doc = container.ownerDocument || globalThis.document;
  if (!doc || typeof doc.createElement !== 'function') {
    return;
  }

  const notice = doc.createElement('p');
  notice.className = 'public-data-notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('data-public-data-notice', '');
  notice.textContent = typeof message === 'string' && message.trim()
    ? message.trim()
    : 'Some shared locations or contacts are temporarily unavailable. The site map is still available.';
  container.appendChild(notice);
}
