import test from 'node:test';
import assert from 'node:assert/strict';
import { getBasePublicVisitPointId } from '../visit-analytics.js';
import { readFile } from 'node:fs/promises';

test('plain public routes attribute only an explicit base point id', () => {
  assert.equal(getBasePublicVisitPointId('', ''), null);
  assert.equal(getBasePublicVisitPointId('?id=base-123', ''), 'base-123');
  assert.equal(getBasePublicVisitPointId('?id=base-123', '#map'), 'base-123');
});
test('benign performance probe parameters keep base attribution', () => {
  assert.equal(
    getBasePublicVisitPointId('?id=base-123&perf=1&perfHud=0&dragDpr=0.75', ''),
    'base-123'
  );
});

test('scoped and unknown query contexts fail closed', () => {
  const blockedKeys = ['myPin', 'scene', 's', 'd', 'debug', 'model', 'models', 'compare', 'unknown'];
  for (const key of blockedKeys) {
    const params = new URLSearchParams({ id: 'scoped-point', [key]: 'x' });
    assert.equal(getBasePublicVisitPointId(params, ''), null, key);
  }
});
test('shared and non-map hashes fail closed', () => {
  assert.equal(getBasePublicVisitPointId('?id=scoped-point', '#share=payload'), null);
  assert.equal(getBasePublicVisitPointId('?id=scoped-point', '#camera-top'), null);
});

test('ambiguous or blank point ids fail closed', () => {
  assert.equal(getBasePublicVisitPointId('?id=', ''), null);
  assert.equal(getBasePublicVisitPointId('?id=%20%20', ''), null);
  assert.equal(getBasePublicVisitPointId('?id=one&id=two', ''), null);
});
test('viewer keeps classified local analytics and only flushes server visit on backend origin', async () => {
  const viewer = await readFile(new URL('../viewer3d.js', import.meta.url), 'utf8');
  assert.match(
    viewer,
    /const _ptId = getBasePublicVisitPointId\(_params, window\.location\.hash\);/
  );
  assert.match(viewer, /if \(_ptId\) \{[\s\S]*?_LS_PT_VISITS[\s\S]*?\}/);
  assert.match(viewer, /window\._snPendingVisitPointId = _ptId \|\| null/);
  assert.match(viewer, /function _flushBackendVisitIfLocal\(\)[\s\S]*?if \(!shouldProbeStaffSession\(_publicRuntime, window\.location\)\) return;[\s\S]*?fetch\(_apiUrl\('\/api\/visit'\),[\s\S]*?pointId: window\._snPendingVisitPointId \|\| null/);
  assert.doesNotMatch(viewer, /const _ptId = _params\.get\('id'\)/);
});
