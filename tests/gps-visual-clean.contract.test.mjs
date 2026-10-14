import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../viewer3d.js', import.meta.url),'utf8');
const style = readFileSync(new URL('../style.css', import.meta.url),'utf8');

test('map location is a single reusable CSS2D blue dot and one accuracy disc', () => {
  assert.match(src,/const dot = new CSS2DObject\(dotElement\)/);
  assert.match(src,/dotElement\.className = 'gps-blue-dot'/);
  assert.match(src,/if \(_gpsPositionGroup\) return _gpsMarkerMeshes/);
  assert.match(src,/const marker = _makeGpsMarker\(\)/);
  assert.match(src,/_gpsPositionGroup\.position\.set\(position\.x, 0, position\.z\)/);
  assert.match(src,/scene\.remove\(_gpsPositionGroup\)/);
  assert.doesNotMatch(src,/new CSS2DObject\(cap\)/);
  assert.match(style,/\.gps-blue-dot__visual\s*\{[^}]*width:18px;height:18px/s);
  assert.match(style,/\.gps-blue-dot__visual\s*\{[^}]*border:3px solid white/s);
});

test('routine GPS state is screen-reader only, errors alone may create a toast', () => {
  assert.match(src,/status\.className = 'gps-visually-hidden'/);
  assert.match(src,/function _showGpsError\(message\)/);
  assert.match(style,/\.gps-visually-hidden\s*\{/);
  assert.match(src,/document\.getElementById\('gps-error-toast'\)/);
  assert.doesNotMatch(src,/new CSS2DObject\(cap\)/);
});

test('GPS tracking can stop from Locations and deactivates on leaving the page', () => {
  assert.match(src,/list\.prepend\(stop\)/);
  assert.match(src,/stop\.id = 'gps-stop-tracking'/);
  assert.match(src,/window\.addEventListener\('pagehide'/);
  assert.match(src,/document\.addEventListener\('visibilitychange'/);
  assert.match(src,/navigator\.geolocation\.watchPosition/);
  assert.match(src,/navigator\.geolocation\?\.clearWatch\?\.\(_gpsWatchId\)/);
});

test('guest admin scenes suppress the sign-in banner but hazards retain safety status', () => {
  assert.match(src,/if \(!signedIn && scene\.kind !== 'hazard'\)/);
  assert.match(src,/document\.getElementById\('scene-status-bar'\)\?\.remove\(\)/);
  assert.match(src,/if \(!signedIn\)\s*\{\s*\/\/ Hazard status/);
  assert.doesNotMatch(src,/a\.textContent = 'Sign in to update'/);
});
