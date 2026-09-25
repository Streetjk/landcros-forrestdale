import { loadPublicArray, projectPublicPoint, projectPublicContact, isRenderablePoint, isRenderableContact } from './public-data.js';
import { loadPublicSiteMetadata, validatePublicSiteMetadata } from './public-site.js';

const SITE_COLUMNS = 'id,slug,name,title,address,logo,published';
const POINT_COLUMNS = 'id,site_id,label,type,scope,latlng,position3d,notes,contact_ids,route_waypoints,route_waypoints3d,camera_preset3d,building_ref';
const CONTACT_COLUMNS = 'id,site_id,name,role,phone,active';

function cleanHttpsOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

export function validatePublicRuntimeConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const siteSlug = typeof value.siteSlug === 'string' && /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(value.siteSlug)
    ? value.siteSlug : null;
  const supabaseUrl = cleanHttpsOrigin(value.supabaseUrl);
  const apiOrigin = cleanHttpsOrigin(value.apiOrigin);
  const key = typeof value.supabasePublishableKey === 'string' ? value.supabasePublishableKey.trim() : '';
  if (!siteSlug || !supabaseUrl || !apiOrigin || !/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key)) return null;
  return Object.freeze({ siteSlug, supabaseUrl, apiOrigin, supabasePublishableKey: key });
}

export async function loadPublicRuntimeConfig(fetchFn = globalThis.fetch) {
  if (typeof fetchFn !== 'function') return null;
  try {
    const response = await fetchFn('./data/public-runtime.json', { cache: 'no-store' });
    if (!response?.ok || typeof response.json !== 'function') return null;
    return validatePublicRuntimeConfig(await response.json());
  } catch { return null; }
}

function directHeaders(runtime) {
  return Object.freeze({ apikey: runtime.supabasePublishableKey, Accept: 'application/json' });
}

async function restRows(runtime, table, params, fetchFn) {
  const url = new URL(`/rest/v1/${table}`, runtime.supabaseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetchFn(url.href, {
    method: 'GET', headers: directHeaders(runtime), cache: 'no-store', referrerPolicy: 'no-referrer'
  });
  if (!response?.ok) throw new Error(`SUPABASE_PUBLIC_${table.toUpperCase()}_${response?.status || 'UNAVAILABLE'}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error(`SUPABASE_PUBLIC_${table.toUpperCase()}_SHAPE`);
  return data;
}

function normalizePoint(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  return {
    id: row.id, label: row.label, type: row.type, scope: row.scope,
    latlng: row.latlng, position3d: row.position3d, notes: row.notes,
    contactIds: row.contact_ids, routeWaypoints: row.route_waypoints,
    routeWaypoints3d: row.route_waypoints3d, cameraPreset3d: row.camera_preset3d,
    buildingRef: row.building_ref,
  };
}

function normalizeContact(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  return { id: row.id, name: row.name, role: row.role, phone: row.phone, active: row.active };
}

function projectRows(rows, normalize, validate, project) {
  const data = [];
  let unavailable = false;
  for (const row of rows) {
    const normalized = normalize(row);
    if (!normalized || !validate(normalized)) { unavailable = true; continue; }
    const projected = project(normalized);
    if (!projected) { unavailable = true; continue; }
    data.push(projected);
  }
  return { data, unavailable };
}

export async function loadDirectPublicData(runtime, fetchFn = globalThis.fetch) {
  if (!runtime || typeof fetchFn !== 'function') throw new Error('PUBLIC_RUNTIME_REQUIRED');
  const siteRows = await restRows(runtime, 'sites', {
    select: SITE_COLUMNS,
    slug: `eq.${runtime.siteSlug}`,
    published: 'eq.true',
    limit: '1',
  }, fetchFn);

  // An unpublished site is an intentional empty public state, not an outage and
  // not a reason to fall back to a less restrictive legacy backend.
  if (!siteRows.length) {
    return {
      transport: 'supabase', runtime, unpublished: true,
      siteResult: { data: null, unavailable: false },
      pointResult: { data: [], unavailable: false },
      contactResult: { data: [], unavailable: false },
    };
  }

  const siteRow = siteRows[0];
  if (siteRow?.published !== true || typeof siteRow.id !== 'string') throw new Error('SUPABASE_PUBLIC_SITE_SHAPE');
  const site = validatePublicSiteMetadata(siteRow);
  if (!site) throw new Error('SUPABASE_PUBLIC_SITE_PROJECTION');

  const [pointRows, contactRows] = await Promise.all([
    restRows(runtime, 'points', { select: POINT_COLUMNS, site_id: `eq.${siteRow.id}` }, fetchFn),
    restRows(runtime, 'contacts', { select: CONTACT_COLUMNS, site_id: `eq.${siteRow.id}` }, fetchFn),
  ]);

  return {
    transport: 'supabase', runtime, unpublished: false,
    siteResult: { data: site, unavailable: false },
    pointResult: projectRows(pointRows, normalizePoint, isRenderablePoint, projectPublicPoint),
    contactResult: projectRows(contactRows, normalizeContact, isRenderableContact, projectPublicContact),
  };
}

export function backendApiUrl(runtime, path, currentHref = globalThis.location?.href) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) return path;
  if (!runtime?.apiOrigin) return path;
  try { return new URL(path, runtime.apiOrigin).href; } catch { return path; }
}

function fallbackFetch(runtime, fetchFn) {
  return (input, init) => {
    const target = typeof input === 'string' && input.startsWith('/api/')
      ? backendApiUrl(runtime, input) : input;
    return fetchFn(target, init);
  };
}

async function loadFallbackPublicData(runtime, fetchFn) {
  const apiFetch = fallbackFetch(runtime, fetchFn);
  const [siteResult, pointResult, contactResult] = await Promise.all([
    loadPublicSiteMetadata(apiFetch),
    loadPublicArray('/api/points', apiFetch, isRenderablePoint, projectPublicPoint),
    loadPublicArray('/api/contacts', apiFetch, isRenderableContact, projectPublicContact),
  ]);
  return { transport: 'api-fallback', runtime, unpublished: false, siteResult, pointResult, contactResult };
}

export async function loadPublicTransport(runtime, fetchFn = globalThis.fetch) {
  if (runtime) {
    try { return await loadDirectPublicData(runtime, fetchFn); }
    catch {
      // A configured direct-public boundary fails closed. Falling back to an
      // older backend could both wake a sleeping service and retrieve a wider
      // legacy response before client-side projection.
      return {
        transport: 'supabase-unavailable', runtime, unpublished: false,
        siteResult: { data: null, unavailable: true },
        pointResult: { data: [], unavailable: true },
        contactResult: { data: [], unavailable: true },
      };
    }
  }
  // Sites without a public runtime config preserve their historical API path.
  return loadFallbackPublicData(null, fetchFn);
}

export function backendRedirectForScopedRoute(runtime, locationLike = globalThis.location) {
  if (!runtime?.apiOrigin || !locationLike) return null;
  let current;
  try { current = new URL(locationLike.href); } catch { return null; }
  if (current.origin === runtime.apiOrigin) return null;
  const hash = new URLSearchParams((current.hash || '').replace(/^#/, ''));
  const needsBackend = current.searchParams.has('scene') || current.searchParams.has('s') || hash.has('myPin');
  if (!needsBackend) return null;
  const target = new URL(runtime.apiOrigin);
  target.pathname = current.pathname.startsWith('/') ? current.pathname : `/${current.pathname}`;
  target.search = current.search;
  target.hash = current.hash;
  // Assigning components separately prevents a network-path reference such as
  // //attacker.example/ from replacing the configured backend authority.
  if (target.origin !== runtime.apiOrigin) return null;
  return target.href;
}

export function shouldProbeStaffSession(runtime, locationLike = globalThis.location) {
  if (!runtime?.apiOrigin || !locationLike) return true;
  try { return new URL(locationLike.href).origin === runtime.apiOrigin; }
  catch { return true; }
}

export const PUBLIC_TRANSPORT_COLUMNS = Object.freeze({ site: SITE_COLUMNS, point: POINT_COLUMNS, contact: CONTACT_COLUMNS });
