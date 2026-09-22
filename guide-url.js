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
 * Builds one account-owned My Pin share URL. The bearer capability stays in
 * the URL fragment so it is not sent in the document request or Referer.
 */
export function buildMyPinShareUrl(origin, token, pointId) {
  const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const tokenRe = /^[A-Za-z0-9_-]{43}$/;
  if (!origin || !uuid.test(String(pointId || "")) || !tokenRe.test(String(token || ""))) {
    throw new Error("My Pin share URL requires point id and capability token");
  }
  const u = new URL("/viewer3d.html", origin);
  u.searchParams.set("id", String(pointId));
  u.hash = `myPin=${encodeURIComponent(String(token))}`;
  return u.toString();
}

/** Public My Pins media is compressed-only; bearer auth is sent by fetch. */
export function buildMyPinPhotoUrl(pointId, photoId) {
  if (!pointId || !photoId) throw new Error("My Pin photo URL requires point id and photo id");
  return `/api/my-pins/points/${encodeURIComponent(String(pointId))}/photos/${encodeURIComponent(String(photoId))}`;
}
