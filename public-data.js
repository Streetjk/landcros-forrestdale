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

export async function loadPublicArray(url, fetchFn = globalThis.fetch, itemValidator = null) {
  try {
    const response = await fetchFn(url);
    if (!response || !response.ok) {
      return { data: [], unavailable: true };
    }
    const parsed = await response.json();
    if (!Array.isArray(parsed)) {
      return { data: [], unavailable: true };
    }
    if (typeof itemValidator !== 'function') {
      return { data: parsed, unavailable: false };
    }
    const data = parsed.filter(itemValidator);
    return { data, unavailable: data.length !== parsed.length };
  } catch {
    return { data: [], unavailable: true };
  }
}

export function renderPublicDataNotice(container, unavailable) {
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
  notice.textContent = 'Some shared locations or contacts are temporarily unavailable. The site map is still available.';
  container.appendChild(notice);
}
