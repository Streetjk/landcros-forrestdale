import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const editor = fs.readFileSync(new URL('../editor.html', import.meta.url), 'utf8');
const sceneEditor = fs.readFileSync(new URL('../scene-editor.js', import.meta.url), 'utf8');

test('Reports editor opts into safe areas and keeps camera controls touch sized', () => {
  assert.match(editor, /<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*">/);
  assert.match(editor, /#cam-presets\s*\{[\s\S]*?top:\s*calc\(16px \+ var\(--safe-top\)\);[\s\S]*?left:\s*calc\(16px \+ env\(safe-area-inset-left, 0px\)\);/);
  assert.match(editor, /\.cam-preset-btn\s*\{[\s\S]*?width:\s*44px;\s*height:\s*44px;/);
  assert.match(editor, /\.cam-preset-btn \.icon-wrap\s*\{[\s\S]*?width:\s*44px;\s*height:\s*44px;/);
});

test('mobile Reports chrome clears fixed staff nav and notch insets', () => {
  assert.match(editor, /@media \(max-width: 1024px\)[\s\S]*?#editor-toolbar\s*\{[^}]*padding-bottom:\s*calc\(54px \+ var\(--safe-bottom\)\);/);
  assert.match(editor, /id="sn-auth-bar" style="[^"]*top:calc\(8px \+ var\(--safe-top\)\);right:calc\(8px \+ env\(safe-area-inset-right, 0px\)\);/);
});


test('Reports actions keep 44px touch targets without changing action semantics', () => {
  assert.match(editor, /\.scene-list-item \.scene-del-btn\s*\{[\s\S]*?min-width:\s*44px;[\s\S]*?min-height:\s*44px;/);
  assert.match(editor, /\.hazard-photo button\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/);
  assert.match(editor, /\.scenes-section button\s*\{[\s\S]*?min-width:\s*44px;[\s\S]*?min-height:\s*44px;/);
  assert.match(editor, /#scene-status-row \.status-btn\s*\{[\s\S]*?min-width:\s*44px;[\s\S]*?min-height:\s*44px;/);
  assert.match(editor, /\.prop-del-btn\s*\{[\s\S]*?min-height:\s*44px;/);
  assert.match(sceneEditor, /del\.type = 'button';[\s\S]*?del\.setAttribute\('aria-label', del\.title\);[\s\S]*?del\.dataset\.action = mine \? 'delete' : 'remove';/);
  assert.match(sceneEditor, /btn\.id = 'archive-toggle';[\s\S]*?btn\.setAttribute\('aria-expanded', String\(_archiveOpen\)\);/);
  assert.match(sceneEditor, /del\.title = 'Remove photo';[\s\S]*?del\.setAttribute\('aria-label', del\.title\);/);
});
