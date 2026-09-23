import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync('index.html', 'utf8');
const viewer = fs.readFileSync('viewer3d.html', 'utf8');
const style = fs.readFileSync('style.css', 'utf8');
const start = style.indexOf('/* ── SiteNav shared shell visual primitives');
const end = style.indexOf('/* ── End SiteNav shared shell visual primitives', start);
const shell = start >= 0 && end > start ? style.slice(start, end) : '';

test('public and staff viewer opt into the shared shell without another stylesheet request', () => {
  for (const [name, html] of [['index', index], ['viewer3d', viewer]]) {
    assert.match(html, /<div id="app" class="sitenav-shell">/);
    assert.equal((html.match(/href="\.\/style\.css"/g) || []).length, 1, `${name} keeps the existing style.css request`);
    assert.doesNotMatch(html, /sitenav-ui\.css/);
  }
});

test('shared shell owns reusable visual tokens and components', () => {
  assert.ok(shell.length > 500);
  for (const token of ['--sn-landcros-orange', '--sn-touch', '--sn-shadow-sheet', '--sn-radius-sheet']) assert.match(shell, new RegExp(token));
  for (const selector of ['.sitenav-shell #side-panel', '.sitenav-shell .cam-preset-btn', '.sitenav-shell .detail-section', '.sitenav-shell .btn-primary', '.sitenav-shell #splat-progress']) assert.ok(shell.includes(selector), selector);
  assert.match(shell, /#e6500a/i);
  assert.match(shell, /--sn-touch:\s*44px/);
});

test('shared shell contains no sheet-state or geometry ownership', () => {
  for (const forbidden of ['sheet-mid','sheet-full','panel-folded','sheet-open','panel-is-folded',':has(']) assert.equal(shell.includes(forbidden), false, forbidden);
  const side = shell.match(/\.sitenav-shell #side-panel\s*\{([^}]+)\}/)?.[1] || '';
  for (const prop of ['position','width','height','transform','overflow','top','bottom','left','right']) assert.doesNotMatch(side, new RegExp(`\\b${prop}\\s*:`, 'i'));
});

test('shared shell is lightweight and self-contained', () => {
  assert.doesNotMatch(shell, /@import|url\(/i);
  assert.ok(Buffer.byteLength(shell, 'utf8') < 7000);
});
