import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const viewer = fs.readFileSync(new URL('../viewer3d.js', import.meta.url), 'utf8');
const pointListItem = fs.readFileSync(new URL('../point-list-item.js', import.meta.url), 'utf8');
const htmlFiles = ['viewer3d.html', 'index.html'];

test('public location list uses shared native buttons with stable accessible names', () => {
  assert.match(viewer, /createPointListItem\(document, \{/);
  assert.match(viewer, /onActivate: \(\) => selectPoint\(pt\)/);
  assert.match(pointListItem, /doc\.createElement\('button'\)/);
  assert.match(pointListItem, /el\.type = 'button'/);
  assert.match(pointListItem, /el\.setAttribute\('aria-label', label\)/);
  assert.match(pointListItem, /labelEl\.textContent = label/);
});

test('selected public location is exposed with aria-current', () => {
  assert.match(viewer, /el\.setAttribute\('aria-current', 'true'\)/);
  assert.match(viewer, /el\.removeAttribute\('aria-current'\)/);
});

for (const name of htmlFiles) {
  test(`${name} keeps button visuals and visible keyboard focus`, () => {
    const html = fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.match(html, /<button type="button" class="back-link" onclick="showPointList\(\)">&#8249; Back<\/button>/);
    assert.doesNotMatch(html, /<div class="back-link"/);
    assert.match(html, /\.point-item:focus-visible\s*\{[^}]*outline:/s);
    assert.match(html, /\.back-link:focus-visible\s*\{[^}]*outline:/s);
    assert.match(html, /\.point-item\s*\{[^}]*appearance:\s*none/s);
    assert.match(html, /\.point-item\s*\{[^}]*width:\s*100%/s);
  });
}


test('scene status chrome passes map taps through while its controls stay interactive', () => {
  assert.match(viewer, /scene-status-bar[\s\S]*pointer-events:none/);
  assert.match(viewer, /b\.style\.cssText = `[^`]*pointer-events:auto;/);
  assert.match(viewer, /a\.style\.cssText = '[^']*pointer-events:auto;'/);
});
