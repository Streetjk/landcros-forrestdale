import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const viewer = fs.readFileSync(new URL('../viewer3d.html', import.meta.url), 'utf8');

for (const [name, html] of [['index.html', index], ['viewer3d.html', viewer]]) {
  test(`${name} opts into viewport safe areas and offsets the public brand`, () => {
    assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*">/);
    assert.match(html, /#site-brand\s*\{[\s\S]*?top:\s*calc\(16px \+ var\(--safe-top\)\) !important;/);
  });
}

test('index mobile translate sheet preserves peek and mid content above safe bottom', () => {
  assert.match(index, /height:\s*calc\(85vh \+ var\(--safe-bottom\)\) !important;/);
  assert.match(index, /padding-bottom:\s*var\(--safe-bottom\);/);
  assert.match(index, /transform:\s*translateY\(calc\(100% - 36px - var\(--safe-bottom\)\)\);/);
  assert.match(index, /#side-panel\.sheet-mid\s*\{\s*transform:\s*translateY\(calc\(100% - 22vh - var\(--safe-bottom\)\)\);\s*\}/);
  assert.match(index, /#cam-presets\s*\{[\s\S]*?bottom:\s*calc\(44px \+ var\(--safe-bottom\)\) !important;/);
  assert.match(index, /#app\.sheet-open #cam-presets\s*\{\s*bottom:\s*calc\(22vh \+ var\(--safe-bottom\) \+ 8px\) !important;\s*\}/);
  assert.match(index, /#nav-progress\s*\{\s*bottom:\s*calc\(44px \+ var\(--safe-bottom\)\);\s*\}/);
  assert.match(index, /#app\.sheet-open #nav-progress\s*\{\s*bottom:\s*calc\(22vh \+ var\(--safe-bottom\) \+ 12px\);\s*\}/);
});

test('viewer height-based sheet keeps tablet and phone content above safe bottom', () => {
  assert.match(viewer, /#side-panel\s*\{[\s\S]*?height:\s*calc\(16vh \+ var\(--safe-bottom\)\) !important;[\s\S]*?padding-bottom:\s*var\(--safe-bottom\) !important;/);
  assert.match(viewer, /#side-panel\.panel-folded\s*\{\s*height:\s*calc\(52px \+ var\(--safe-bottom\)\) !important;\s*\}/);
  assert.match(viewer, /#cam-presets\s*\{\s*bottom:\s*calc\(16vh \+ var\(--safe-bottom\) \+ 8px\) !important;\s*\}/);
  assert.match(viewer, /bottom:\s*calc\(52px \+ var\(--safe-bottom\) \+ 8px\) !important;/);
  assert.match(viewer, /#nav-progress\s*\{\s*bottom:\s*calc\(16vh \+ var\(--safe-bottom\) \+ 20px\);\s*\}/);
  assert.match(viewer, /#side-panel\s*\{\s*height:\s*calc\(19vh \+ var\(--safe-bottom\)\) !important;\s*\}/);
  assert.match(viewer, /#side-panel\.panel-folded\s*\{\s*height:\s*calc\(48px \+ var\(--safe-bottom\)\) !important;\s*\}/);
  assert.match(viewer, /#cam-presets\s*\{\s*bottom:\s*calc\(19vh \+ var\(--safe-bottom\) \+ 8px\) !important;\s*\}/);
  assert.match(viewer, /bottom:\s*calc\(48px \+ var\(--safe-bottom\) \+ 8px\) !important;/);
  assert.match(viewer, /#nav-progress\s*\{\s*bottom:\s*calc\(19vh \+ var\(--safe-bottom\) \+ 20px\);\s*\}/);
});
