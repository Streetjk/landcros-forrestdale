import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../viewer3d.js',import.meta.url),'utf8');

test('custom scene labels initiate the same camera flight as standard drop pins',()=>{
  const scene=src.slice(src.indexOf('function showSceneLabelDetail('),src.indexOf('function showHazardDetail('));
  assert.match(scene,/_mobileDetails\.repeat\('scene:' \+ obj\.id\)/);
  assert.match(scene,/_focusPinCamera\(new THREE\.Vector3\(x,y,z\)\)/);
  const start=src.indexOf('function selectPoint(');
  const end=src.indexOf('window.showPointList',start);
  const point=src.slice(start,end);
  assert.match(point,/_focusPinCamera\(new THREE\.Vector3/);
  assert.doesNotMatch(point,/duration:\s*2\.5|_camTween = gsap\.to/);
});

test('single spherical flight hands off to OrbitControls and pauses until arrival',()=>{
  const focus=src.slice(src.indexOf('function _focusPinCamera('),src.indexOf('window._syncRotateBtn ='));
  assert.match(focus,/planPinCameraFlight\(/);
  assert.match(focus,/samplePinCameraFlight\(/);
  assert.match(focus,/controls\.enabled = false/);
  assert.match(focus,/_orbitActive = true/);
  assert.match(focus,/controls\.autoRotate = true/);
  assert.match(focus,/controls\.autoRotateSpeed = PIN_ORBIT_SPEED/);
  assert.match(focus,/duration:plan\.duration/);
  assert.match(focus,/ease:'none'/);
  assert.match(focus,/controls\.target\.set\(sample\.target\.x/);
});

test('interruptions remove listeners and cancel the owner-only tween',()=>{
  const cancel=src.slice(src.indexOf('function _cancelPinFocusFlight('),src.indexOf('function _focusPinCamera('));
  for(const event of ['pointerdown','wheel','keydown','visibilitychange'])
    assert.ok(cancel.includes("removeEventListener('"+event+"'"),event);
  assert.match(cancel,/if \(_camTween === flight\.tween\)/);
  assert.match(cancel,/flight\.tween\.kill\(\)/);
  assert.match(src,/function _centreCameraOnGps\(position\)\s*\{\s*_cancelPinFocusFlight\(\)/);
  assert.match(src,/function startAutoOrbit\(target, radius, elevDeg\)\s*\{\s*_cancelPinFocusFlight\(\)/);
  assert.match(src,/window\.setCameraPreset = function setCameraPreset\(name, duration = 2500\)\s*\{\s*_cancelPinFocusFlight\(\)/);
  assert.match(src,/window\.startNav = function\(pt\)\s*\{\s*_cancelPinFocusFlight\(\)/);
  assert.match(src,/if \(window\.matchMedia\?\.\('\(prefers-reduced-motion: reduce\)'\)\.matches\)/);
});

test('editing a pin never changes the camera pose automatically',()=>{
  assert.match(src,/document\.getElementById\('add-label-btn'\) \|\| document\.getElementById\('admin-controls'\)/);
});

test('site labels do not request server-side geolocation or camera state',()=>{
  const start=src.indexOf('function _focusPinCamera(');
  const end=src.indexOf('window._syncRotateBtn =',start);
  const flight=src.slice(start,end);
  assert.doesNotMatch(flight, /fetch\(|localStorage|sessionStorage|XMLHttpRequest/);
});
