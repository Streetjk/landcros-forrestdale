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
