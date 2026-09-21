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
    if (u.searchParams.has('d') && !u.searchParams.has('scene') && !u.searchParams.has('s')
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
