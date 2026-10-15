import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const css = read('mobile-detail-sheet.css');
const landscape = css.slice(css.indexOf('@media (max-width:1024px) and (orientation:landscape)'));

test('portrait keeps the Locations-dock offset when details are dismissed', () => {
  assert.match(css, /#app\.sn-details-dismissed #cam-presets, #app\.sn-details-dismissed #btn-fullscreen\s*\{\s*bottom:calc\(58px \+ env\(safe-area-inset-bottom,0px\)\)!important;/);
});

test('landscape restores the normal map-edge offset after a fully expanded detail closes', () => {
  assert.match(landscape, /#app\.sn-details-dismissed #cam-presets,\s*#app\.sn-details-dismissed #btn-fullscreen\s*\{\s*bottom:calc\(16px \+ var\(--safe-bottom\)\)!important;/);
  assert.match(landscape, /body\[data-staff-nav-mounted="true"\] #app\.sn-details-dismissed #cam-presets,[\s\S]*?#app\.sn-details-dismissed #btn-fullscreen\s*\{\s*bottom:calc\(var\(--sn-map-staff-nav-lift,55px\) \+ 16px \+ var\(--safe-bottom\)\)!important;/);
  assert.match(landscape, /#app\.sn-details-dismissed #sn-details-browse\s*\{display:none!important;\}/);
  assert.match(landscape, /#app\.sn-details-dismissed #panel-tab\s*\{display:flex!important;right:0!important;\}/);
});

test('both public entrypoints bypass cached detail styles on mobile', () => {
  for (const name of ['index.html','viewer3d.html']) {
    assert.match(read(name), /mobile-detail-sheet\.css\?v=20261015c/);
  }
});
