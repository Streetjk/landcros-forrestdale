import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../' + path, import.meta.url),'utf8');
const viewer = read('viewer3d.js');
const editor = read('scene-editor.js');
const pin = read('scene-label-pin.js');
const style = read('style.css');
const server = read('server.js');

test('pins anchor to the projected centre of the floor square instead of world-height drift',()=>{
  assert.match(pin,/SCENE_PIN_GROUND_Y = 0\.05/);
  assert.match(viewer,/obj\.kind === 'label' \? SCENE_PIN_GROUND_Y/);
  assert.match(editor,/obj\.kind === 'label' \? SCENE_PIN_GROUND_Y/);
  assert.match(style,/\.scene-location-pin__button\s*\{[^}]*bottom:var\(--scene-pin-hover\)/s);
  assert.match(style,/\.scene-location-pin__tether\s*\{/);
});

test('mobile GPS is permission-gated, calibrated, and does not enable a background watch',()=>{
  assert.match(viewer,/window\.innerWidth <= 1024/);
  assert.match(viewer,/navigator\.geolocation\.getCurrentPosition/);
  assert.doesNotMatch(viewer,/navigator\.geolocation\.watchPosition/);
  assert.match(viewer,/GPS location centred/);
  assert.match(viewer,/_getSiteGpsCalibration\(\)/);
});

test('clone button is user initiated and the API demands editor authorization',()=>{
  assert.match(editor,/className = 'scene-duplicate-btn'/);
  assert.match(editor,/event\.stopPropagation\(\);\s*onDuplicateSceneClick/);
  assert.match(editor,/credentials: 'same-origin'/);
  assert.match(server,/_duplicateMatch && req\.method === 'POST'/);
  const route=server.slice(server.indexOf('const _duplicateMatch'),server.indexOf('const _sceneItemMatch'));
  assert.match(route,/_requireSiteEditor\(req, res, slug/);
  assert.match(route,/duplicateScene\(slug, sourceId/);
  assert.match(route,/if \(_rateLimited/);
  assert.doesNotMatch(route,/req\.method === 'GET'/);
});
