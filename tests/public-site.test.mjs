import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fileUrl = new URL('../public-site.js', import.meta.url);
const code = await readFile(fileUrl, 'utf8');
const dataUri = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const { loadPublicSiteMetadata, resolveSiteBranding, sanitizePublicLogoUrl, validatePublicSiteMetadata } = await import(dataUri);

test('public site client keeps the exact allowlist and trims strings', () => {
  assert.deepEqual(validatePublicSiteMetadata({
    slug: ' landcros ', name: ' LANDCROS ', title: ' Site Navigator ', address: ' 107 Allen Rd ',
    logo: ' /logo.png ', mainPhone: ' 08 0000 0000 ', visitorInfo: ' Reception first. ',
    buildingPhoto: ' /building.webp ', speedLimitSign: '/speed.png', secret: 'never',
  }), {
    slug: 'landcros', name: 'LANDCROS', title: 'Site Navigator', address: '107 Allen Rd',
    logo: '/logo.png', mainPhone: '08 0000 0000', visitorInfo: 'Reception first.',
    buildingPhoto: '/building.webp',
  });
});

test('public site client sanitizes logo URLs before any branding DOM sink', () => {
  const scene7 = 'https://hitachikenki.scene7.com/is/image/hitachikenki/LANDCROS%20logo_orange_RGB-1';
  assert.equal(sanitizePublicLogoUrl(scene7), scene7);
  assert.equal(sanitizePublicLogoUrl('/assets/logo.png'), '/assets/logo.png');
  for (const value of ['javascript:alert(1)', 'data:image/png;base64,no', 'http://example.test/logo.png', '//example.test/logo.png', '/bad\\logo.png', 'https://user:pass@example.test/logo']) {
    assert.equal(sanitizePublicLogoUrl(value), null);
  }
  assert.deepEqual(validatePublicSiteMetadata({ slug: 'landcros', logo: 'javascript:alert(1)' }), { slug: 'landcros' });
  assert.deepEqual(resolveSiteBranding({ logo: '/local.png' }, { logo: 'data:image/png;base64,no' }), { logo: '/local.png' });
  assert.deepEqual(resolveSiteBranding({ logo: 'javascript:bad' }, { logo: 'data:image/png;base64,no' }), {});
});

test('public site client fails closed on malformed roots and omits wrong-type fields', () => {
  for (const value of [null, [], 'site', {}, { slug: '   ' }, { slug: 42 }]) {
    assert.equal(validatePublicSiteMetadata(value), null);
  }
  assert.deepEqual(validatePublicSiteMetadata({
    slug: 'alpha', name: 'Valid', title: 1, address: null, logo: [], mainPhone: {}, visitorInfo: false,
  }), { slug: 'alpha', name: 'Valid' });
});

test('loadPublicSiteMetadata returns validated metadata from /api/site', async () => {
  const calls = [];
  const result = await loadPublicSiteMetadata(async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ slug: 'landcros', name: 'LANDCROS', privateNotes: 'no' }) };
  });
  assert.deepEqual(calls, ['/api/site']);
  assert.deepEqual(result, { data: { slug: 'landcros', name: 'LANDCROS' }, unavailable: false });
});

test('loadPublicSiteMetadata degrades without throwing on HTTP, JSON, shape, and network failures', async () => {
  const unavailable = { data: null, unavailable: true };
  assert.deepEqual(await loadPublicSiteMetadata(async () => ({ ok: false, status: 500 })), unavailable);
  assert.deepEqual(await loadPublicSiteMetadata(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } })), unavailable);
  assert.deepEqual(await loadPublicSiteMetadata(async () => ({ ok: true, json: async () => ({ name: 'missing slug' }) })), unavailable);
  assert.deepEqual(await loadPublicSiteMetadata(async () => { throw new Error('offline'); }), unavailable);
  assert.deepEqual(await loadPublicSiteMetadata(null), unavailable);
});

test('API branding overlays only shell fields and local config remains the fallback', () => {
  const local = { name: 'Local name', title: 'Local title', address: 'Local address', logo: '/local.png', speedLimitSign: '/speed.png' };
  const remote = { slug: 'landcros', name: ' API name ', address: ' API address ', mainPhone: '08 0000 0000', visitorInfo: 'ignored here' };
  assert.deepEqual(resolveSiteBranding(local, remote), {
    name: 'API name', title: 'Local title', address: 'API address', logo: '/local.png',
  });
  assert.deepEqual(resolveSiteBranding(local, null), {
    name: 'Local name', title: 'Local title', address: 'Local address', logo: '/local.png',
  });
  assert.equal('speedLimitSign' in resolveSiteBranding(local, remote), false);
  assert.equal('mainPhone' in resolveSiteBranding(local, remote), false);
});

test('viewer starts public site metadata without gating local config or renderer settings', async () => {
  const viewer = await readFile(new URL('../viewer3d.js', import.meta.url), 'utf8');
  assert.match(viewer, /import \{ loadPublicSiteMetadata, resolveSiteBranding, sanitizePublicLogoUrl \} from '\.\/public-site\.js';/);
  assert.match(viewer, /const _publicSitePromise = loadPublicSiteMetadata\(globalThis\.fetch\);[\s\S]*?_cfg = await fetch\('\.\/data\/config\.json'/);
  assert.match(viewer, /_applyBranding\(_cfg\);[\s\S]*?_publicSitePromise\.then\(\(\{ data \}\) => \{[\s\S]*?if \(data\) _applyBranding\(_cfg, data\);/);
  assert.match(viewer, /_syncSiteInfoAction\(_publicSiteMetadata\)/);
  assert.match(viewer, /function _applyBranding\(cfg, publicSite = null\) \{\s*const s = resolveSiteBranding\(cfg\?\.site, publicSite\);/);
  assert.match(viewer, /_buildPresets\(_cfg\);\s*_buildCamButtons\(_cfg\);/);
  assert.match(viewer, /const _earlyLogo = sanitizePublicLogoUrl\(_cfg\.site\?\.logo\);/);
});

test('site information action is a hidden native button on both public viewer shells', async () => {
  for (const name of ['index.html', 'viewer3d.html']) {
    const html = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.match(html, /<button type="button" class="point-item site-info-item" id="site-info-item" hidden aria-label="Site information">/);
  }
});

test('site information action is detail-only and does not write browser history', async () => {
  const viewer = await readFile(new URL('../viewer3d.js', import.meta.url), 'utf8');
  const start = viewer.indexOf('function _syncSiteInfoAction(publicSite)');
  const end = viewer.indexOf('function _applyBranding(', start);
  const block = viewer.slice(start, end);
  assert.match(block, /hasSiteDetail\(publicSite\)/);
  assert.match(block, /_cancelActiveTour\(\)/);
  assert.match(block, /showSiteDetail\(publicSite, _openDetailPanel\)/);
  assert.doesNotMatch(block, /history\.(pushState|replaceState)/);
  assert.match(viewer, /const fromSiteInfo = _siteInfoDetailOpen;[\s\S]*?fromSiteInfo \? 'none' : 'push'/);

  const selectStart = viewer.indexOf('async function selectPoint(pt, options = {})');
  const selectEnd = viewer.indexOf('window.showPointList = function', selectStart);
  const selectBlock = viewer.slice(selectStart, selectEnd);
  assert.match(selectBlock, /_siteInfoDetailOpen = false;[\s\S]*?history\.pushState\(null, '', nextUrl\)/);
});
