import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const editor = fs.readFileSync(new URL('../editor.html', import.meta.url), 'utf8');

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
