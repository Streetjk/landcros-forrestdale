import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const viewer = fs.readFileSync(new URL('../viewer3d.js', import.meta.url), 'utf8');
const htmlFiles = ['viewer3d.html', 'index.html'];

test('public location list uses native buttons with stable accessible names', () => {
  assert.match(viewer, /document\.createElement\('button'\)/);
  assert.match(viewer, /el\.type = 'button'/);
  assert.match(viewer, /el\.setAttribute\('aria-label', pt\.label\)/);
  assert.match(viewer, /el\.onclick = \(\) => selectPoint\(pt\)/);
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
