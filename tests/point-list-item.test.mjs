import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPointListItem } from '../point-list-item.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.type = '';
  }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
}

const fakeDocument = { createElement: tag => new FakeElement(tag) };

test('shared point-list item renders public/staff text safely as a native button', () => {
  let activated = 0;
  const row = createPointListItem(fakeDocument, {
    id: 'pin-1',
    label: '<img src=x onerror=alert(1)> Gate 1',
    subtitle: 'drop-off',
    dotColor: '#185FA5',
    selected: true,
    pinSource: 'account',
    trailing: true,
    onActivate: () => { activated += 1; },
  });

  assert.equal(row.tagName, 'BUTTON');
  assert.equal(row.type, 'button');
  assert.equal(row.className, 'point-item selected');
  assert.equal(row.style.minHeight, '44px');
  assert.equal(row.dataset.ptId, 'pin-1');
  assert.equal(row.dataset.pinSource, 'account');
  assert.equal(row.attributes.get('aria-label'), '<img src=x onerror=alert(1)> Gate 1');
  assert.equal(row.attributes.get('aria-current'), 'true');
  assert.equal(row.children[1].children[0].textContent, '<img src=x onerror=alert(1)> Gate 1');
  assert.equal(row.children[1].children[1].textContent, 'drop-off');
  assert.equal(row.children[2].textContent, '›');
  assert.equal(row.children[2].attributes.get('aria-hidden'), 'true');
  row.listeners.get('click')();
  assert.equal(activated, 1);
});

test('shared point-list item omits optional staff metadata cleanly', () => {
  const row = createPointListItem(fakeDocument, { id: 42, label: 'Workshop', dotColor: '#fff' });
  assert.equal(row.dataset.ptId, '42');
  assert.equal('pinSource' in row.dataset, false);
  assert.equal(row.children.length, 2);
  assert.equal(row.children[1].children.length, 1);
});

test('public and staff runtimes both consume the shared point-list primitive', () => {
  const viewer = fs.readFileSync('viewer3d.js', 'utf8');
  const admin = fs.readFileSync('admin3d.js', 'utf8');
  assert.match(viewer, /import \{ createPointListItem \} from '\.\/point-list-item\.js'/);
  assert.match(admin, /import \{ createPointListItem \} from '\.\/point-list-item\.js'/);
  assert.match(viewer, /createPointListItem\(document, \{/);
  assert.match(admin, /createPointListItem\(document, \{/);
  assert.doesNotMatch(admin.match(/function renderPointList\([\s\S]*?\n\}/)?.[0] || '', /innerHTML/);
});

test('staff point-list button CSS preserves touch and keyboard affordances', () => {
  const html = fs.readFileSync('admin3d.html', 'utf8');
  assert.match(html, /\.point-item \{[\s\S]*?min-height: 44px;[\s\S]*?width: 100%;/);
  assert.match(html, /\.point-item:focus-visible \{[^}]*outline:/);
  assert.match(html, /border: 0; background: transparent; color: inherit; font: inherit;/);
});
