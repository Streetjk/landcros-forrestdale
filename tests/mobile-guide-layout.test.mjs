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

test('index mobile sheet uses dynamic viewport tokens and a visible peek dock', () => {
  assert.match(index, /height:\s*100vh;[\s\S]*?height:\s*100dvh;/);
  assert.match(index, /min-height:\s*100vh;[\s\S]*?min-height:\s*100svh;/);
  assert.match(index, /--sn-sheet-peek:\s*60px;/);
  assert.match(index, /--sn-sheet-mid:\s*min\(42dvh, 360px\);/);
  assert.match(index, /--sn-sheet-full:\s*min\(88dvh, 760px\);/);
  assert.match(index, /height:\s*calc\(var\(--sn-sheet-full\) \+ var\(--safe-bottom\)\) !important;/);
  assert.match(index, /transform:\s*translateY\(calc\(100% - var\(--sn-sheet-peek\) - var\(--safe-bottom\)\)\);/);
  assert.match(index, /#side-panel\.sheet-mid\s*\{\s*transform:\s*translateY\(calc\(100% - var\(--sn-sheet-mid\) - var\(--safe-bottom\)\)\);\s*\}/);
  assert.match(index, /#cam-presets\s*\{[\s\S]*?bottom:\s*calc\(var\(--sn-sheet-peek\) \+ var\(--safe-bottom\) \+ 10px\) !important;/);
  assert.match(index, /#app\.sheet-open #cam-presets\s*\{\s*bottom:\s*calc\(var\(--sn-sheet-mid\) \+ var\(--safe-bottom\) \+ 10px\) !important;\s*\}/);
  assert.match(index, /font-size:\s*12px;/);
  assert.match(index, /<button[^>]*id="sheet-peek-toggle"[^>]*aria-controls="side-panel"[^>]*aria-expanded="false"[^>]*>[\s\S]*?Locations[\s\S]*?<\/button>/);
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
