/** Explicitly bounded selection: never interpret arbitrary query strings as URLs. */
export function resolveSplatQuality(requested, tier = 'medium') {
  if (requested === 'lite' || requested === 'full') return requested;
  return tier === 'high' ? 'full' : 'lite';
}

export function resolveSplatCandidates(assets = {}, quality = 'lite') {
  const legacy = Array.isArray(assets.splat) ? assets.splat
    : typeof assets.splat === 'string' ? [assets.splat] : ['./assets/site.splat', './assets/site.ply'];
  const models = assets.splatModels;
  if (!models || typeof models !== 'object') return legacy;
  const preferred = quality === 'full'
    ? [models.full, models.original, models.lite]
    : [models.lite, models.full, models.original];
  return [...new Set([...preferred, ...legacy].filter(p => typeof p === 'string' && p.startsWith('./assets/')))];
}
