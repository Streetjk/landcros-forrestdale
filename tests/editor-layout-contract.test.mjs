import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../editor.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../scene-editor.js', import.meta.url), 'utf8');

test('scene editor keeps action ids but prioritises compact tools and inspection', () => {
  for (const id of ['scenes-list', 'add-label-btn', 'add-button-btn', 'add-widget-btn',
    'property-panel', 'prop-text', 'prop-description', 'prop-photo-upload-btn',
    'prop-photo-remove-btn', 'scene-share-url', 'scene-share-copy-btn', 'scene-qr-wrap']) {
    assert.match(html, new RegExp('id="' + id + '"'), id);
  }
  assert.ok(html.indexOf('id="add-buttons"') < html.indexOf('id="property-panel"'));
  assert.match(html, /<details id="scene-share-details"/);
  assert.match(html, /#prop-pin-details\s*\{[^}]*flex-direction:column/s);
  assert.match(html, /\.editor-tool-grid\s*\{[^}]*grid-template-columns:repeat\(3/s);
  assert.match(js, /generateQR\(url, 'scene-qr-wrap', \{ width: 192, height: 192/);
});

test('small-screen drawer provides reachable map placement and accessible controls', () => {
  assert.match(html, /id="editor-mobile-open"[^>]*aria-expanded="false"/);
  assert.match(html, /id="editor-mobile-scrim" hidden/);
  assert.match(html, /#app\.editor-panel-open #editor-toolbar/);
  assert.match(html, /#sn-auth-bar\s*\{[^}]*bottom:/s);
  assert.match(js, /window\._snSetEditorPanelOpen\?\.\(false\)/);
  assert.match(js, /setAttribute\('aria-pressed', String\(buttonKind === kind\)\)/);
});
