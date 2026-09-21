// guide-url.js - Pure ESM helper for query parameter URL manipulation

/**
 * Builds a URL updating the pin 'id' parameter while preserving
 * pathname, guide parameters (scene/s), compatible legacy d, and hash.
 * @param {string} currentHref - The current location href or relative path.
 * @param {string} id - The pin identifier to set.
 * @returns {string} The updated URL.
 */
export function buildPinUrl(currentHref, id) {
  if (!currentHref) return '';
  const isRelative = !/^[a-zA-Z][a-zA-Z\d+\-.]*:/i.test(currentHref);
  const base = isRelative ? 'http://dummy.local' : undefined;
  const u = new URL(currentHref, base);
  if (id !== undefined && id !== null && String(id).trim() !== '') {
    // A legacy embedded payload belongs to its original pin. Do not let
    // selecting a different base-map pin reapply that old contact/title data.
    if (u.searchParams.has('d') && !u.searchParams.has('scene') && !u.searchParams.has('s') && !u.searchParams.has('myPin')
        && u.searchParams.get('id') !== String(id)) u.searchParams.delete('d');
    u.searchParams.set('id', String(id));
  }
  if (isRelative) {
    if (currentHref.startsWith('?')) {
      return `${u.search}${u.hash}`;
    }
    const relPath = currentHref.split('?')[0].split('#')[0];
    return `${relPath}${u.search}${u.hash}`;
  }
  return u.toString();
}

/**
 * Clears only the 'id' parameter from the URL, preserving pathname,
 * all other search parameters (scene, s, d, etc.), and hash.
 * @param {string} currentHref - The current location href or relative path.
 * @returns {string} The updated URL.
 */
export function clearPinUrl(currentHref) {
  if (!currentHref) return '';
  const isRelative = !/^[a-zA-Z][a-zA-Z\d+\-.]*:/i.test(currentHref);
  const base = isRelative ? 'http://dummy.local' : undefined;
  const u = new URL(currentHref, base);
  u.searchParams.delete('id');
  if (isRelative) {
    if (currentHref.startsWith('?')) {
      return `${u.search}${u.hash}`;
    }
    const relPath = currentHref.split('?')[0].split('#')[0];
    return `${relPath}${u.search}${u.hash}`;
  }
  return u.toString();
}


/**
 * Builds the scoped public URL for one account-owned My Pin. The workspace
 * share code is never sufficient on its own; the point UUID is always paired
 * with it so recipients cannot enumerate the rest of the workspace.
 */
export function buildMyPinShareUrl(origin, shareCode, pointId) {
  if (!origin || !shareCode || !pointId) throw new Error('My Pin share URL requires origin, share code and point id');
  const u = new URL('/viewer3d.html', origin);
  u.searchParams.set('myPin', String(shareCode));
  u.searchParams.set('id', String(pointId));
  return u.toString();
}

/** Public My Pins media is compressed-only; there is intentionally no original flag. */
export function buildMyPinPhotoUrl(shareCode, pointId, photoId) {
  if (!shareCode || !pointId || !photoId) throw new Error('My Pin photo URL requires share code, point id and photo id');
  return `/api/scenes/by-code/${encodeURIComponent(String(shareCode))}/points/${encodeURIComponent(String(pointId))}/photos/${encodeURIComponent(String(photoId))}`;
}
