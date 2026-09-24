import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { mapControlLabel, syncPressedButton, syncPressedButtons } from '../map-controls.js';

const viewer = fs.readFileSync(new URL('../viewer3d.js', import.meta.url), 'utf8');

function fakeButton() {
  const classes = new Set();
  const attrs = new Map();
  return {
    classes,
    attrs,
    classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); } },
    setAttribute(name, value) { attrs.set(name, value); },
  };
}

test('map-control labels preserve configured text and use bounded fallbacks', () => {
  assert.equal(mapControlLabel({ label: '  Entry  ', id: 'entry' }), 'Entry');
  assert.equal(mapControlLabel({ action: 'fullscreen' }), 'Fullscreen map');
  assert.equal(mapControlLabel({ action: 'autopan' }), 'Auto-pan map');
  assert.equal(mapControlLabel({ id: 'north' }), 'Camera view: north');
  assert.equal(mapControlLabel({}), 'Camera view');
});

test('pressed control runtime helper keeps active class and aria-pressed synchronized', () => {
  const button = fakeButton();
  assert.equal(syncPressedButton(button, true), true);
  assert.equal(button.classes.has('active'), true);
  assert.equal(button.attrs.get('aria-pressed'), 'true');
  assert.equal(syncPressedButton(button, false), false);
  assert.equal(button.classes.has('active'), false);
  assert.equal(button.attrs.get('aria-pressed'), 'false');
  assert.equal(syncPressedButton(null, true), false);
});

test('pressed group runtime helper synchronizes each matching autopan control', () => {
  const first = fakeButton();
  const second = fakeButton();
  const root = { querySelectorAll(selector) {
    assert.equal(selector, '[data-map-toggle="autopan"]');
    return [first, second];
  } };
  assert.equal(syncPressedButtons(root, '[data-map-toggle="autopan"]', true), 2);
  for (const button of [first, second]) {
    assert.equal(button.classes.has('active'), true);
    assert.equal(button.attrs.get('aria-pressed'), 'true');
  }
  assert.equal(syncPressedButtons({}, '[data-map-toggle="autopan"]', false), 0);
});

test('runtime-generated actionable camera controls are explicit named buttons', () => {
  assert.match(viewer, /rotBtn\.type = 'button'/);
  assert.match(viewer, /rotBtn\.setAttribute\('aria-label', 'Toggle auto-rotate'\)/);
  assert.match(viewer, /mBtn\.type = 'button'/);
  assert.match(viewer, /mBtn\.setAttribute\('aria-label', 'Measure distance'\)/);
  assert.match(viewer, /btn\.type = 'button'/);
  assert.match(viewer, /btn\.setAttribute\('aria-label', mapControlLabel\(p\)\)/);
});

test('rotate, measure and autopan lifecycle paths call shared pressed-state synchronization', () => {
  assert.match(viewer, /window\._syncRotateBtn = \(\) => \{\s*syncPressedButton\(document\.getElementById\('btn-auto-rotate'\), controls\.autoRotate\);\s*\}/);
  assert.match(viewer, /function _toggleMeasure\(on\)[\s\S]*?syncPressedButton\(btn, on\)/);
  assert.match(viewer, /function _syncAutoPanButtons\(\)[\s\S]*?syncPressedButtons\(document, '\[data-map-toggle="autopan"\]', _orbitActive\)/);
  assert.match(viewer, /function startAutoOrbit[\s\S]*?_orbitActive = true;\s*_syncAutoPanButtons\(\)/);
  assert.match(viewer, /function stopAutoOrbit[\s\S]*?_orbitActive\s*=\s*false;[\s\S]*?_syncAutoPanButtons\(\)/);
  const selectStart = viewer.indexOf('function selectPoint');
  const selectEnd = viewer.indexOf('window.showPointList', selectStart);
  const selectBlock = viewer.slice(selectStart, selectEnd);
  assert.match(selectBlock, /_orbitActive = true;[\s\S]*?controls\.autoRotate\s*=\s*true;[\s\S]*?_syncAutoPanButtons\(\);[\s\S]*?window\._syncRotateBtn\?\.\(\)/);
});

test('fullscreen and ordinary presets remain non-toggle controls', () => {
  const presetLoopStart = viewer.indexOf('(cfg.camera?.presets ?? []).forEach');
  const measureStart = viewer.indexOf('// Measurement tool button', presetLoopStart);
  const block = viewer.slice(presetLoopStart, measureStart);
  assert.match(block, /if \(p\.action === 'autopan'\) \{[\s\S]*?syncPressedButton\(btn, _orbitActive\)/);
  assert.doesNotMatch(block, /p\.action === 'fullscreen'[\s\S]{0,260}aria-pressed/);
});
