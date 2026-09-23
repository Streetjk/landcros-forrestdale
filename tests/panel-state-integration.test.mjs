import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync('index.html', 'utf8');
const viewer = fs.readFileSync('viewer3d.html', 'utf8');
const runtime = fs.readFileSync('viewer3d.js', 'utf8');

test('both viewer pages load the shared panel-state adapter before viewer runtime', () => {
  for (const [name, html, mode] of [['index', index, 'sheet'], ['viewer3d', viewer, 'fold']]) {
    const adapter = html.indexOf('src="./panel-state.js"');
    const viewerScript = html.indexOf('type="module" src="./viewer3d.js"');
    assert.ok(adapter >= 0, `${name} loads panel-state.js`);
    assert.ok(viewerScript > adapter, `${name} loads adapter before viewer3d.js`);
    assert.match(html, new RegExp(`SiteNavPanelState\\.init\\(\\{ mode: '${mode}' \\}\\)`));
  }
});

test('duplicated inline panel state machines are removed from guide/viewer pages', () => {
  assert.doesNotMatch(index, /const SHEET_BP\s*=|let _wasSheet\s*=|classList\.toggle\('sheet-open'/);
  assert.doesNotMatch(viewer, /function _isBottomSheet\(|src="panel-mobile\.js"/);
  assert.match(index, /window\.togglePanel\s*=\s*\(\)\s*=>\s*window\.SiteNavPanelState\.toggle\(\)/);
  assert.match(viewer, /window\.togglePanel\s*=\s*\(\)\s*=>\s*window\.SiteNavPanelState\.toggle\(\)/);
});

test('viewer runtime uses semantic panel operations with legacy fallback centralized', () => {
  assert.match(runtime, /SiteNavPanelState\.openDetail\(\)/);
  assert.match(runtime, /SiteNavPanelState\.expandFull\(\)/);
  assert.match(runtime, /SiteNavPanelState\.collapseList\(\)/);
  const directVocabulary = runtime.match(/(?:sheet-mid|sheet-full|panel-folded)/g) || [];
  assert.ok(directVocabulary.length <= 8, `legacy fallback vocabulary remains centralized: ${directVocabulary.length}`);
});
