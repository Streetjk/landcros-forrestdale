import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { labelScaleForZoom } from '../label-layout.js';
import { markerScaleForZoom } from '../scene-label-pin.js';

const read = name => readFileSync(new URL('../'+name,import.meta.url), 'utf8');
const viewer = read('viewer3d.js');
const css = read('style.css');
const pins = read('scene-label-pin.js');

test('marker scale follows orange labels with capped minimum and unchanged nearby size', () => {
  assert.equal(markerScaleForZoom(0), 1);
  assert.equal(markerScaleForZoom(10), 1);
  assert.equal(markerScaleForZoom(18), 1);
  assert.ok(Math.abs(markerScaleForZoom(80) - 2/3) < 1e-12);
  assert.ok(Math.abs(markerScaleForZoom(999) - 2/3) < 1e-12);
  assert.equal(markerScaleForZoom(Infinity), markerScaleForZoom(26));
  const values = [0,18,20,32,42,58,80,100].map(markerScaleForZoom);
  for (const value of values) assert.ok(value>=2/3 && value<=1);
  for (let i=1;i<values.length;i++) assert.ok(values[i] <= values[i-1]);
  assert.ok(Math.abs(markerScaleForZoom(32) - labelScaleForZoom(32)/.66)<1e-8);
});

test('scene drop pin and GPS dot scale only their painted children, not world anchors or touch targets', () => {
  assert.match(pins,/visual\.className = 'scene-location-pin__visual'/);
  assert.match(pins,/button\.appendChild\(visual\)/);
  assert.match(css,/\.scene-location-pin__visual\s*\{[^}]*transform:translateX\(-50%\) scale\(var\(--sn-pin-zoom,1\)\)/s);
  assert.match(css,/\.scene-location-pin__button\s*\{[^}]*width:48px; height:88px/s);
  assert.match(css,/\.scene-location-pin__tether\s*\{[^}]*height:calc\(var\(--scene-pin-hover\) \* var\(--sn-pin-zoom,1\)\)/s);
  assert.match(css,/\.gps-blue-dot__visual\s*\{[^}]*transform:scale\(var\(--sn-pin-zoom,1\)\)/s);
  assert.match(viewer,/labelsWrap\.style\.setProperty\('--sn-pin-zoom', _pinZoomScale\)/);
  assert.match(viewer,/markerScaleForZoom\(_zoom\)/);
  assert.match(viewer,/dotElement\.appendChild\(dotVisual\)/);
  assert.match(viewer,/svgEl\.classList\.add\('map-point-pin-icon'\)/);
  assert.match(css,/\.map-point-pin-icon\s*\{[^}]*transform:scale\(var\(--sn-pin-zoom,1\)\)/s);
});

test('GPS location control is a true toggle; no user-facing direction wedge', () => {
  assert.match(viewer,/locateBtn\.addEventListener\('click', \(\) => _toggleGpsTracking\(locateBtn\)\)/);
  assert.match(viewer,/async function _toggleGpsTracking\(button\)/);
  assert.match(viewer,/if \(_gpsWatchId !== null \|\| _gpsWatchStarting\)\s*\{\s*_stopGpsTracking\(true\);\s*return;/);
  assert.match(viewer,/_gpsLocateButton\.title = active\s*\? 'Stop live GPS tracking and hide my location'/);
  assert.match(viewer,/navigator\.geolocation\.watchPosition/);
  assert.match(viewer,/navigator\.geolocation\?\.clearWatch\?\.\(_gpsWatchId\)/);
  assert.doesNotMatch(viewer,/gps-heading-cone|_setGpsHeading|gpsSceneHeading/);
  assert.doesNotMatch(read('gps-tracking.js'),/gpsSceneHeading/);
  assert.match(viewer,/root\.add\(fill, boundary, dot\)/);
});
