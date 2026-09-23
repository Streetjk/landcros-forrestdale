const PUBLIC_SITE_FIELDS = Object.freeze([
  'name',
  'title',
  'address',
  'logo',
  'mainPhone',
  'visitorInfo',
  'buildingPhoto',
]);

const BRAND_FIELDS = Object.freeze(['name', 'title', 'address', 'logo']);

function cleanString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function sanitizePublicLogoUrl(value) {
  const trimmed = cleanString(value);
  if (!trimmed || /[\x00-\x1F\x7F\\]/.test(trimmed) || /\s/.test(trimmed)) return null;
  if (trimmed.startsWith('//')) return null;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/i.test(trimmed)) {
    if (!/^https:/i.test(trimmed)) return null;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
      return parsed.href;
    } catch {
      return null;
    }
  }
  return trimmed;
}

export function validatePublicSiteMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const slug = cleanString(value.slug);
  if (!slug) return null;

  const out = { slug };
  for (const field of PUBLIC_SITE_FIELDS) {
    const cleaned = field === 'logo' ? sanitizePublicLogoUrl(value[field]) : cleanString(value[field]);
    if (cleaned) out[field] = cleaned;
  }
  return out;
}

export async function loadPublicSiteMetadata(fetchFn = globalThis.fetch) {
  if (typeof fetchFn !== 'function') return { data: null, unavailable: true };
  try {
    const response = await fetchFn('/api/site');
    if (!response?.ok || typeof response.json !== 'function') {
      return { data: null, unavailable: true };
    }
    const data = validatePublicSiteMetadata(await response.json());
    return data
      ? { data, unavailable: false }
      : { data: null, unavailable: true };
  } catch {
    return { data: null, unavailable: true };
  }
}

export function resolveSiteBranding(localSite, publicSite) {
  const local = localSite && typeof localSite === 'object' && !Array.isArray(localSite)
    ? localSite
    : {};
  const remote = publicSite && typeof publicSite === 'object' && !Array.isArray(publicSite)
    ? publicSite
    : {};
  const out = {};
  for (const field of BRAND_FIELDS) {
    const value = field === 'logo'
      ? sanitizePublicLogoUrl(remote[field]) ?? sanitizePublicLogoUrl(local[field])
      : cleanString(remote[field]) ?? cleanString(local[field]);
    if (value) out[field] = value;
  }
  return out;
}
