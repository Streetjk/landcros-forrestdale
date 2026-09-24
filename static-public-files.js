'use strict';

// The repository contains both browser assets and server/private source/data.
// Only entries declared here may cross the unauthenticated static-file boundary.
const PUBLIC_ROOT_FILES = Object.freeze([
  'index.html', 'viewer3d.html', 'admin3d.html', 'gallery.html', 'editor.html',
  'portal.html', 'reset-pin.html', 'start.html', 'style.css',
  'coi-serviceworker.js', 'auth-gate.js', 'panel-state.js', 'panel-mobile.js',
  'staff-map-shell.js', 'staff-nav.js', 'admin3d.js', 'gallery.js',
  'scene-editor.js', 'viewer3d.js', 'db.js', 'detail-card.js', 'guide-url.js',
  'location-details.js', 'map-controls.js', 'my-pins-client.js',
  'my-pins-session.js', 'point-list-item.js', 'public-data.js', 'public-site.js',
  'qr.js', 'splat-compare.js', 'splat-normalization.js', 'viewer-perf.js',
  'visit-analytics.js',
]);
const PUBLIC_ROOT_SET = new Set(PUBLIC_ROOT_FILES);

const PUBLIC_DATA_FILES = Object.freeze([
  'config.json', 'buildings.geojson', 'traffic.json', 'roads.json',
]);
const PUBLIC_DATA_SET = new Set(PUBLIC_DATA_FILES);

const PUBLIC_SITE_ROOT_FILES = Object.freeze(['logo.png', 'speedlimit2.png']);
const PUBLIC_SITE_ROOT_SET = new Set(PUBLIC_SITE_ROOT_FILES);

const PUBLIC_ASSET_EXTENSIONS = Object.freeze([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif',
  '.splat', '.ksplat', '.ply', '.glb', '.gltf', '.bin', '.stl',
  '.mp4', '.webm',
]);
const PUBLIC_ASSET_EXTENSION_SET = new Set(PUBLIC_ASSET_EXTENSIONS);
const PUBLIC_ASSET_EXACT_FILES = Object.freeze(['site-map-bounds.json']);
const PUBLIC_ASSET_EXACT_SET = new Set(PUBLIC_ASSET_EXACT_FILES);

function decodePathname(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.includes('\0')) return null;
  try { return decodeURIComponent(pathname); } catch { return null; }
}

function safeRelativePath(value) {
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  const segments = value.split('/');
  return segments.every(seg => seg && seg !== '.' && seg !== '..' && !seg.startsWith('.'));
}

function classifyPublicStaticPath(pathname) {
  const decoded = decodePathname(pathname);
  if (!decoded || decoded.includes('\\')) return null;
  if (decoded === '/') return { kind: 'root', relative: 'index.html' };

  if (decoded.startsWith('/data/')) {
    const relative = decoded.slice('/data/'.length);
    return PUBLIC_DATA_SET.has(relative) ? { kind: 'data', relative } : null;
  }
  if (decoded.startsWith('/assets/')) {
    const relative = decoded.slice('/assets/'.length);
    if (!safeRelativePath(relative)) return null;
    if (PUBLIC_ASSET_EXACT_SET.has(relative)) return { kind: 'asset', relative };
    const dot = relative.lastIndexOf('.');
    const ext = dot >= 0 ? relative.slice(dot).toLowerCase() : '';
    return PUBLIC_ASSET_EXTENSION_SET.has(ext) ? { kind: 'asset', relative } : null;
  }

  if (decoded.startsWith('/sites/') || decoded.startsWith('/.')) return null;
  const relative = decoded.slice(1);
  if (!safeRelativePath(relative)) return null;
  if (PUBLIC_ROOT_SET.has(relative)) return { kind: 'root', relative };
  if (PUBLIC_SITE_ROOT_SET.has(relative)) return { kind: 'site-root', relative };

  // Preserve the existing friendly /viewer3d -> /viewer3d.html behavior, but
  // only when the resolved HTML file is explicitly public.
  if (!relative.includes('/')) {
    const html = `${relative}.html`;
    if (PUBLIC_ROOT_SET.has(html)) return { kind: 'root', relative: html };
  }
  return null;
}

module.exports = {
  PUBLIC_ROOT_FILES,
  PUBLIC_DATA_FILES,
  PUBLIC_SITE_ROOT_FILES,
  PUBLIC_ASSET_EXTENSIONS,
  PUBLIC_ASSET_EXACT_FILES,
  classifyPublicStaticPath,
};
