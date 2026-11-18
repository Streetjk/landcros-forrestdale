import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalEditorPath } = require('../editor-site-route.js');
const route = (path, site = 'landcros') =>
  canonicalEditorPath(new URL(path, 'https://landcros-forrestdale.onrender.com'), site);

test('corrects the truncated Forrestdale editor slug and retains other query values', () => {
  assert.equal(route('/editor.html?site=lan'), '/editor.html?site=landcros');
  assert.equal(route('/editor?site=lan&debug=1'), '/editor?site=landcros&debug=1');
  assert.equal(route('/editor/?debug=1&site=lan'), '/editor/?debug=1&site=landcros');
});

test('does not remap other tenants, longer slugs, API routes or missing parameters', () => {
  assert.equal(route('/editor.html?site=lan', 'greenfields'), null);
  assert.equal(route('/editor.html?site=greenfields'), null);
  assert.equal(route('/editor.html?site=landcros'), null);
  assert.equal(route('/editor.html?site=lantern'), null);
  assert.equal(route('/api/sites/lan/scenes'), null);
  assert.equal(route('/editor.html'), null);
});
