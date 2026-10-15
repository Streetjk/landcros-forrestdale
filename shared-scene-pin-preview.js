// Lightweight preview of labels from exactly one share-code-authorised admin
// scene. The RPC returns only bounded public title, description and position;
// photos, scripts, contacts and other scene tables remain inaccessible.
const CODE_RE = /^[a-z0-9]{10}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const UUID_RE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export function sanitizeSharedScenePinPreview(payload) {
  if (!payload || !Array.isArray(payload.objects) || payload.objects.length > 25) return null;
  const seen = new Set();
  const objects = [];
  for (const row of payload.objects) {
    const coords = row?.transform?.position;
    const text = row?.props?.text;
    const description = row?.props?.description ?? '';
    if (row?.kind !== 'label' || typeof row.id !== 'string' || !UUID_RE.test(row.id)
      || seen.has(row.id) || !Array.isArray(coords) || coords.length !== 3
      || !coords.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 200)
      || typeof text !== 'string' || !text.trim() || text.length > 160
      || typeof description !== 'string' || description.length > 4000) return null;
    seen.add(row.id);
    objects.push({
      id: row.id, kind: 'label',
      transform: { position: [...coords] },
      props: { text, description },
    });
  }
  return {objects};
}

export async function loadSharedScenePinPreview(runtime, code, {
  fetchFn = globalThis.fetch,
  timeoutMs = 4000,
} = {}) {
  if (!runtime || typeof fetchFn !== 'function' || !CODE_RE.test(code || '')
    || !SLUG_RE.test(runtime.siteSlug || '')
    || !/^https:\/\//.test(runtime.supabaseUrl || '')
    || !/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(runtime.supabasePublishableKey || '')) return null;
  let endpoint;
  try {
    endpoint = new URL('/rest/v1/rpc/sitenav_shared_scene_pin_preview',runtime.supabaseUrl).href;
  } catch { return null; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),timeoutMs);
  try {
    const response = await fetchFn(endpoint,{
      method:'POST',
      headers:{
        apikey:runtime.supabasePublishableKey,
        Accept:'application/json',
        'Content-Type':'application/json',
      },
      body:JSON.stringify({p_code:code,p_site_slug:runtime.siteSlug}),
      cache:'no-store',
      referrerPolicy:'no-referrer',
      signal:controller.signal,
    });
    if (!response?.ok) return null;
    return sanitizeSharedScenePinPreview(await response.json());
  } catch {
    // RPC absence/network timeout never grants a broader fallback.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
