export async function loadPublicArray(url, fetchFn = globalThis.fetch) {
  try {
    const response = await fetchFn(url);
    if (!response || !response.ok) {
      return { data: [], unavailable: true };
    }
    const parsed = await response.json();
    if (!Array.isArray(parsed)) {
      return { data: [], unavailable: true };
    }
    return { data: parsed, unavailable: false };
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
