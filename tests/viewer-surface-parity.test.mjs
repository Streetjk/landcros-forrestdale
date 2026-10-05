import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const surfaces = ['index.html', 'viewer3d.html', 'admin3d.html', 'editor.html'];

test('all 3D SiteNav surfaces use the shared viewer and shared mobile stylesheet', () => {
  for (const name of surfaces) {
    const html = read(name);
    assert.match(html, /<link rel="stylesheet" href="\.\/style\.css">/);
    assert.match(html, /<script type="module" src="\.\/viewer3d\.js"><\/script>/);
  }
});

test('shared viewer keeps labels fixed and splat network loading bounded for every surface', () => {
  const viewer = read('viewer3d.js');
  const labels = read('label-layout.js');

  assert.doesNotMatch(labels, /previousSlot|offsetsFor|orderedSlots|clampedPlacement|function overlaps/);
  assert.match(labels, /if \(!inside\(rect, viewport, margin\)\)/);
  assert.match(labels, /visible:\s*true,[\s\S]*?dx:\s*0,[\s\S]*?dy:\s*0,[\s\S]*?slot:\s*0/);

  assert.match(viewer, /_fetchWithTimeout\(path, \{ method: 'HEAD', cache: 'no-store' \}, 8000\)/);
  assert.match(viewer, /for \(let attempt = 0; attempt < 2; attempt\+\+\)/);
  assert.match(viewer, /30000,[\s\S]*return response\.arrayBuffer\(\)/);
});

test('shared mobile camera controls snap rather than animate their vertical movement', () => {
  const style = read('style.css');
  const index = read('index.html');

  assert.match(style, /#cam-presets\s*\{[\s\S]*?transition:\s*none !important;/);
  assert.doesNotMatch(style, /#cam-presets\s*\{[\s\S]*?transition:[^;}]*bottom/);
  assert.match(index, /#cam-presets\s*\{[\s\S]*?transition:\s*opacity 0\.4s ease !important;/);
  assert.doesNotMatch(index, /#cam-presets\s*\{[\s\S]*?transition:[^;}]*bottom/);
});

test('loading address remains visible until the loading overlay itself finishes', () => {
  const viewer = read('viewer3d.js');
  const index = read('index.html');
  const standalone = read('viewer3d.html');

  assert.match(index, /id="load-site-sub"/);
  assert.match(standalone, /id="load-site-sub"/);
  assert.doesNotMatch(viewer, /load-site-sub[\s\S]{0,180}style\.opacity\s*=\s*['"]0['"]/);
  assert.doesNotMatch(viewer, /_siteSub[\s\S]{0,120}opacity/);
  assert.match(viewer, /document\.getElementById\('loading'\)\.classList\.add\('done'\)/);
});

test('portal opens the shared editor surface rather than a separate viewer implementation', () => {
  const portal = read('portal.html');
  assert.match(portal, /openLink\.href = `\/editor\.html\?site=\$\{encodeURIComponent\(slug\)\}`;/);
  assert.doesNotMatch(portal, /viewer3d\.js/);
});
