import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { requiredPpeForBuilding } from '../ppe-matrix.js';

const require = createRequire(import.meta.url);
const { classifyPublicStaticPath } = require('../static-public-files.js');

const full = ['boots', 'glasses', 'hiVis', 'longClothing'];
const parts = ['boots', 'hiVis'];

test('Mining, Workshop and Reman match the complete site PPE matrix', () => {
  for (const building of ['bld-mining', 'bld-module', 'bld-reman']) {
    assert.deepEqual(requiredPpeForBuilding(building, 'landcros'), full);
  }
});

test('Parts Receival and Parts Despatch require only boots and hi-vis', () => {
  for (const building of ['bld-parts-receival', 'bld-parts-despatch']) {
    assert.deepEqual(requiredPpeForBuilding(building, 'landcros'), parts);
  }
});

test('All other places have no inferred PPE requirement', () => {
  for (const building of ['bld-office', 'gate-1', 'poi-parts-sale', 'mining', '', null, undefined]) {
    assert.equal(requiredPpeForBuilding(building, 'landcros'), null);
  }
});

test('The Forrestdale matrix never appears on another site sharing building IDs', () => {
  for (const slug of ['greenfields', 'other', '', null, undefined]) {
    for (const building of ['bld-mining', 'bld-module', 'bld-reman', 'bld-parts-receival', 'bld-parts-despatch']) {
      assert.equal(requiredPpeForBuilding(building, slug), null);
    }
  }
});

test('PPE module, styles and SVG icons are permitted on the static site', () => {
  for (const path of [
    '/ppe-matrix.js', '/ppe-matrix.css',
    '/assets/ppe/safety-boots.svg', '/assets/ppe/safety-glasses.svg',
    '/assets/ppe/hi-vis.svg', '/assets/ppe/long-clothing.svg',
    '/assets/ppe/no-smoking.svg',
  ]) {
    assert.ok(classifyPublicStaticPath(path), `expected public: ${path}`);
  }
});
