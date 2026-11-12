// Static contract for the EX2000-7 route toolbar's portrait-phone layout.
// Layout itself is measured in a real browser by the local harness; this
// guards the markup/CSS decisions that make that layout possible.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const source = readFileSync(new URL('../excavator-route.js', import.meta.url), 'utf8');
const css = source.match(/const TOOLBAR_CSS = `([\s\S]*?)`;/)[1];
const markup = source.match(/wrap\.innerHTML = `([\s\S]*?)`;/)[1];
const mobile = css.slice(css.indexOf('@media ${MOBILE_TOOLBAR_QUERY}'));

test('no inline styles that would beat the mobile media query', () => {
  assert.equal(/style\s*=\s*"/.test(markup), false, 'markup must not carry style attributes');
  assert.equal(source.includes('style.cssText'), false);
  assert.equal(css.includes('!important'), false);
});

test('mobile breakpoint covers portrait phones only', () => {
  assert.ok(source.includes("const MOBILE_TOOLBAR_QUERY = '(max-width:600px)'"));
  assert.ok(mobile.length > 0);
});

test('mobile overlay is compact and sits below the brand/address', () => {
  assert.match(mobile, /width:min\(320px,calc\(100vw - 20px\)\)/);
  assert.match(mobile, /top:calc\(70px \+ env\(safe-area-inset-top, 0px\)\)/);
  assert.match(mobile, /left:calc\(10px \+ env\(safe-area-inset-left, 0px\)\);right:auto/);
});

test('mobile hides repetitive explanatory text but desktop keeps it', () => {
  assert.match(mobile, /\.exr-detail,\s*#excavator-route-controls \.exr-note \{display:none\}/);
  const desktop = css.slice(0, css.indexOf('@media'));
  assert.match(desktop, /\.exr-note \{font-size:10px;color:#8fa3b5;margin-top:8px\}/);
  assert.match(desktop, /\.exr-state \{display:none\}/);
  assert.ok(markup.includes('One-way journey · automatic camera orbit · not an approved vehicle route'));
});

test('controls stay on one non-wrapping row with practical tap targets', () => {
  assert.match(mobile, /\.exr-row \{\s*display:grid;grid-template-columns:minmax\(0,1fr\) minmax\(0,1\.2fr\) auto;/);
  assert.match(mobile, /min-height:40px/);
  assert.match(mobile, /\.exr-speed \{\s*display:flex;align-items:center;gap:5px;white-space:nowrap/);
});

test('accessible names, live state and focus ring', () => {
  assert.ok(markup.includes('id="ex-state" class="exr-state" role="status"'));
  assert.ok(markup.includes('id="excavator-demo-status" class="exr-detail" role="status"'));
  assert.ok(markup.includes('<label for="ex-speed">Speed</label>'));
  assert.ok(markup.includes('aria-label="Animation speed"'));
  assert.ok(markup.includes('role="group" aria-label="Playback and camera"'));
  assert.match(css, /button:focus-visible,#excavator-route-controls select:focus-visible \{\s*outline:2px solid #fbbf24/);
  for (const state of ['Loading', 'Moving', 'Paused', 'Parked']) assert.ok(source.includes(`'${state}'`));
});

test('speed options unchanged and no dig control', () => {
  assert.ok(markup.includes('<option value="1">1×</option><option value="2" selected>2×</option>'));
  assert.ok(markup.includes('<option value="5">5×</option>'));
  assert.equal(/ex-work|>Dig</.test(source), false);
});
