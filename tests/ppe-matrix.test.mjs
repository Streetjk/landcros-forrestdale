import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { requiredPpeForBuilding, renderBuildingPpe } from '../ppe-matrix.js';
import { showBuildingDetail } from '../location-details.js';

const require = createRequire(import.meta.url);
const { classifyPublicStaticPath } = require('../static-public-files.js');

const full = ['boots', 'glasses', 'hiVis', 'longClothing', 'noSmoking'];
const parts = ['boots', 'hiVis', 'noSmoking'];

test('Mining, Workshop and Reman match the complete site PPE matrix', () => {
  for (const building of ['bld-mining', 'bld-module', 'bld-reman']) {
    assert.deepEqual(requiredPpeForBuilding(building, 'landcros'), full);
  }
});

test('Parts Receival and Parts Despatch require boots, hi-vis and no smoking', () => {
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

function createMinimalDetailDocument() {
  const nodes = [];
  const createElement = (tagName) => {
    const node = {
      tagName, id: '', className: '', textContent: '', hidden: false, children: [],
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = [...children]; },
      insertAdjacentElement(_position, child) { this.children.push(child); },
      querySelector(selector) {
        const name = selector.replace(/^\./, '');
        const find = (parent) => {
          for (const child of parent.children) {
            if (String(child.className).split(/\s+/).includes(name)) return child;
            const nested = find(child);
            if (nested) return nested;
          }
          return null;
        };
        return find(this);
      },
    };
    nodes.push(node);
    return node;
  };
  const panel = createElement('div');
  panel.id = 'point-detail';
  const hero = createElement('div');
  hero.className = 'detail-hero';
  panel.append(hero);
  hero.insertAdjacentElement = (_position, child) => panel.append(child);
  const documentRef = {
    createElement,
    getElementById(id) { return nodes.find((node) => node.id === id) || null; },
  };
  return { documentRef, createElement };
}

test('No smoking shares the same uniform PPE tile grid', () => {
  const { documentRef } = createMinimalDetailDocument();
  assert.equal(renderBuildingPpe({ id: 'bld-mining' }, documentRef, 'landcros'), true);
  const section = documentRef.getElementById('detail-ppe');
  const list = section.querySelector('.ppe-icon-grid');
  assert.deepEqual(list.children.map((cell) => cell.children[1].textContent), [
    'Safety boots', 'Safety glasses', 'Hi-vis clothing', 'Long clothing', 'No smoking',
  ]);
  assert.equal(documentRef.getElementById('ppe-rule-heading'), null);
  assert.equal(list.children[4].children[0].src, './assets/ppe/no-smoking.svg?v=ppe-20261111c');

  assert.equal(renderBuildingPpe({ id: 'bld-parts-despatch' }, documentRef, 'landcros'), true);
  assert.deepEqual(list.children.map((cell) => cell.children[1].textContent), [
    'Safety boots', 'Hi-vis clothing', 'No smoking',
  ]);
  assert.equal(renderBuildingPpe({ id: 'bld-parts-despatch' }, documentRef, 'greenfields'), false);
  assert.equal(list.children.length, 0);
  assert.equal(section.hidden, true);
});

test('An empty building description stays blank and supports future public details', () => {
  const { documentRef, createElement } = createMinimalDetailDocument();
  for (const id of ['detail-chip', 'detail-label', 'detail-notes']) {
    const node = createElement('div');
    node.id = id;
  }
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const originalDocument = globalThis.document;
  globalThis.document = documentRef;
  try {
    showBuildingDetail({ id: 'bld-office', name: 'Office', details: {} });
    const notes = documentRef.getElementById('detail-notes');
    const visitor = documentRef.getElementById('detail-visitor-info');
    assert.equal(notes.textContent, '');
    assert.ok(visitor, 'future visitor detail node remains available');
    assert.equal(visitor.hidden, true);

    showBuildingDetail({
      id: 'bld-office', name: 'Office',
      details: { description: 'Report to reception', visitorInfo: 'Sign in at the desk' },
    });
    assert.equal(notes.textContent, 'Report to reception');
    assert.equal(visitor.hidden, false);
    assert.equal(visitor.querySelector('.detail-visitor-text').textContent, 'Sign in at the desk');
  } finally {
    if (hadDocument) globalThis.document = originalDocument;
    else delete globalThis.document;
  }
});
