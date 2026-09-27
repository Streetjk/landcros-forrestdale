import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../viewer3d.js', import.meta.url), 'utf8');

test('scoped My Pin failures are visible and remain fail-closed', () => {
  assert.match(source, /let _scopedGuideUnavailable = _publicMyPinMode && !_publicMyPinActive;/);
  assert.match(source, /if \(_publicMyPinActive && _deepId[\s\S]*?response\.ok[\s\S]*?_scopedGuideUnavailable = true;[\s\S]*?catch \{\s*_scopedGuideUnavailable = true;/);
  assert.match(source, /_publicMyPinMode\s*\?\s*scenePins\.find\(p => p\.id === _deepId\) \?\? null\s*:\s*points\.find\(p => p\.id === _deepId\)/);
});

test('scene share failures show a generic notice while hazard 401 still hands off to login', () => {
  assert.match(source, /else if \(_sceneCode && !_publicMyPinMode[\s\S]*?response\.status === 401[\s\S]*?window\._snHazardLoginRequired\?\.\(d\);[\s\S]*?else \{\s*_scopedGuideUnavailable = true;/);
  assert.match(source, /_scopedGuideUnavailable\s*\?\s*'This shared guide is temporarily unavailable\. The site map is still available\.'/);
  assert.doesNotMatch(source, /temporarily unavailable[^\n]*(?:_publicMyPinToken|_sceneCode|response\.status)/);
});

test('valid My Pins recipient route uses progressive base-guide reveal without broadening other scoped routes', () => {
  const start = source.indexOf('function _isVanillaProgressiveRoute()');
  const end = source.indexOf('function _resolveModels', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.ok(block.includes('if (_publicMyPinActive)'));
  assert.ok(block.includes("new Set(['id', 'perf', 'perfHud', 'dragDpr'])"));
  assert.ok(block.includes("_params.getAll('id').length !== 1"));
  assert.ok(block.includes('hash === `#myPin=${_publicMyPinToken}`'));
  assert.equal(block.includes('scene'), false);
  assert.equal(block.includes('share'), false);
  assert.equal(block.includes('code'), false);
  assert.ok(source.includes('const _progressivePublic = !_compOnly && _isVanillaProgressiveRoute();'));
  assert.ok(source.includes("if (_progressivePublic && _splatStatus !== 'ready')"));
  assert.ok(source.includes('fetch(`/api/my-pins/points/${encodeURIComponent(_deepId)}`'));
});
