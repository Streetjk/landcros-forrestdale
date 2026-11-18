// Correct the known truncated Forrestdale editor bookmark before any scene
// requests run. Keep this deliberately narrow: site slugs are tenant IDs,
// so arbitrary prefixes must never be resolved to another tenant.
const EDITOR_PATHS = new Set(['/editor', '/editor/', '/editor.html']);

function canonicalEditorPath(url, site) {
  if (site !== 'landcros' || !EDITOR_PATHS.has(url.pathname)) return null;
  if (url.searchParams.get('site') !== 'lan') return null;

  const canonical = new URL(url.href);
  canonical.searchParams.set('site', 'landcros');
  return canonical.pathname + canonical.search;
}

module.exports = { canonicalEditorPath };
