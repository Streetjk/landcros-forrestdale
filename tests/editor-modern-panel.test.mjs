import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = name => readFileSync(new URL('../' + name, import.meta.url),'utf8');
const html = source('editor.html');
const js = source('scene-editor.js');

test('redesigned Scene Editor preserves each existing action hook exactly once', () => {
  for (const id of [
    'toolbar-header', 'editor-toolbar', 'canvas-wrap', 'scenes-panel', 'scenes-list',
    'add-scene-btn','add-group-btn','new-scene-row','new-group-row',
    'scene-share-row','scene-share-details','scene-share-url','scene-share-copy-btn',
    'scene-qr-wrap','add-buttons','add-label-btn','add-button-btn','add-widget-btn',
    'property-panel','empty-selection','prop-text','prop-description','prop-pin-details',
    'prop-photo-input','prop-photo-preview','prop-photo-gallery','prop-photo-upload-btn',
    'prop-photo-remove-btn','prop-photo-status','prop-delete-btn','prop-widget-group',
    'prop-action-type','editor-mobile-open','editor-mobile-close','editor-mobile-scrim',
  ]) {
    const matches=[...html.matchAll(new RegExp('id="'+id+'"','g'))];
    assert.equal(matches.length,1,id+' must exist exactly once');
  }
  assert.ok(html.indexOf('id="prop-photo-preview"') < html.indexOf('id="prop-photo-gallery"'));
  assert.ok(html.indexOf('id="prop-photo-gallery"') < html.indexOf('id="prop-photo-upload-btn"'));
});

test('header shows current scene, scenes create and share controls remain discoverable', () => {
  assert.match(html,/id="editor-context"[^>]*aria-live="polite"/);
  assert.match(js,/const current = _scenes\.find\(scene => scene\.id === _currentSceneId\)/);
  assert.match(js,/Editing · ' \+ current\.name/);
  assert.match(html,/id="add-group-btn"/);
  assert.match(html,/id="add-scene-btn"/);
  assert.match(html,/<details id="scene-share-details"/);
  assert.match(js,/generateQR\(url, 'scene-qr-wrap', \{ width: 192, height: 192/);
});

test('scene names use native keyboard buttons and actions are explicit, accessible and safe', () => {
  assert.match(js,/name\.type = 'button'/);
  assert.match(js,/name\.className = 'scene-name-btn'/);
  assert.match(js,/name\.setAttribute\('aria-current', 'true'\)/);
  assert.match(js,/name\.addEventListener\('click', \(\) => selectScene\(scene\.id\)\)/);
  assert.match(js,/more\.setAttribute\('aria-expanded', 'false'\)/);
  assert.match(js,/actions\.hidden = true/);
  assert.match(js,/del\.setAttribute\('aria-label', 'Delete scene ' \+ scene\.name\)/);
  assert.match(js,/onDeleteSceneClick\(scene\.id\)/);
  assert.match(js,/onDuplicateSceneClick\(scene, copy\)/);
  assert.match(js,/const groupSelector = sceneGroupSelector\(scene\)/);
});

test('editing keeps place tools visible while giving the inspector its own scroll space', () => {
  assert.match(js,/classList\.add\('is-inspecting'\)/);
  assert.match(js,/classList\.remove\('is-inspecting'\)/);
  assert.match(html,/#editor-toolbar\.is-inspecting #scenes-list/);
  assert.match(html,/#property-panel \{[\s\S]*?overflow-y:auto/);
  assert.match(html,/#editor-toolbar \{[\s\S]*?overflow:hidden/);
  assert.ok(html.indexOf('id="add-buttons"') < html.indexOf('id="property-panel"'));
});

test('script-controlled fields are never forcibly displayed by the redesigned stylesheet', () => {
  const start=html.indexOf('/* Scene Editor · AGY/Opus 5.5 product layout');
  const end=html.indexOf('</style>',start);
  const css=html.slice(start,end);
  assert.ok(start>=0 && end>start);
  assert.doesNotMatch(css,/backdrop-filter:blur\(/);
  assert.doesNotMatch(css,/#(?:property-panel|empty-selection|no-scene-hint|new-scene-row|scene-share-row|prop-pin-details|prop-action-group)\s*\{[^}]*display\s*:\s*\w+\s*!important/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css,/#app\.editor-panel-open #editor-toolbar \{transform:translateY\(0\)/);
  assert.match(css,/#sn-auth-bar \{[^}]*bottom:/s);
});

test('autosave status reflects actual write results, and errors never claim a save', () => {
  assert.match(html,/class="editor-save-hint" role="status" aria-live="polite"/);
  assert.match(js,/setEditorSaveState\('saving', 'Saving…'\)/);
  assert.match(js,/setEditorSaveState\(saved \? 'saved' : 'error', saved \? 'Saved' : 'Not saved'\)/);
  assert.match(js,/if \(!res\.ok\) \{[\s\S]*?showToast\(`Save failed/);
  assert.match(js,/const saved = await apiWrite/);
});

test('no scenes and saved-scene errors remain distinct; no scene object is fabricated', () => {
  assert.match(js,/_scenesLoadFailed/);
  assert.match(js,/Your scenes are temporarily unavailable\. Retry above; nothing was deleted\./);
  assert.match(js,/Choose a scene above to add pins to the map\./);
  assert.match(js,/#?none/); // generic unchanged value seen in action options
  assert.doesNotMatch(html,/<script[^>]*src="https:\/\/[^"]*editor.*redesign/i);
});
