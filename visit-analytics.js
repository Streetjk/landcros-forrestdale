// visit-analytics.js — privacy boundary for anonymous visit attribution.
// Site-total visits are always recorded by the caller. A point id is eligible
// only on the plain/base public guide; scoped/share/editor routes fail closed.
const BASE_VISIT_QUERY_KEYS = new Set(['id', 'perf', 'perfHud', 'dragDpr']);

export function getBasePublicVisitPointId(search = '', hash = '') {
  let params;
  try {
    params = search instanceof URLSearchParams
      ? search
      : new URLSearchParams(typeof search === 'string' ? search : '');
  } catch {
    return null;
  }

  for (const key of params.keys()) {
    if (!BASE_VISIT_QUERY_KEYS.has(key)) return null;
  }

  const routeHash = typeof hash === 'string' ? hash : '';
  if (routeHash !== '' && routeHash !== '#map') return null;

  const ids = params.getAll('id');
  if (ids.length !== 1) return null;
  const id = ids[0];
  return typeof id === 'string' && id.trim() !== '' ? id : null;
}
