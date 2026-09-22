import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateSplatNormalization, resolveSplatPlacement } from '../splat-normalization.js';

test('validateSplatNormalization validates valid values and enforces immutability', () => {
  const input = { center: [1.5, -2, 3], scale: 2.5 };
  const res = validateSplatNormalization(input);
  assert.deepEqual(res, { center: [1.5, -2, 3], scale: 2.5 });
  assert.ok(Object.isFrozen(res));
  assert.ok(Object.isFrozen(res.center));
  assert.notEqual(res.center, input.center);
});

test('input mutation does not alter validated output', () => {
  const center = [10, 20, 30];
  const input = { center, scale: 4 };
  const res = validateSplatNormalization(input);
  center[0] = 999;
  input.scale = 100;
  assert.equal(res.center[0], 10);
  assert.equal(res.scale, 4);
});

test('validateSplatNormalization rejects null, missing, primitives, and top-level arrays', () => {
  assert.equal(validateSplatNormalization(null), null);
  assert.equal(validateSplatNormalization(undefined), null);
  assert.equal(validateSplatNormalization(123), null);
  assert.equal(validateSplatNormalization('string'), null);
  assert.equal(validateSplatNormalization([1, 2, 3]), null);
  assert.equal(validateSplatNormalization({}), null);
});

test('validateSplatNormalization rejects invalid center shapes and lengths', () => {
  assert.equal(validateSplatNormalization({ center: [1, 2], scale: 1 }), null);
  assert.equal(validateSplatNormalization({ center: [1, 2, 3, 4], scale: 1 }), null);
  assert.equal(validateSplatNormalization({ center: '1,2,3', scale: 1 }), null);
  assert.equal(validateSplatNormalization({ center: null, scale: 1 }), null);
});

test('validateSplatNormalization rejects non-numbers, string numbers, NaN, and Infinity in center', () => {
  assert.equal(validateSplatNormalization({ center: ['1', 2, 3], scale: 1 }), null);
  assert.equal(validateSplatNormalization({ center: [NaN, 2, 3], scale: 1 }), null);
  assert.equal(validateSplatNormalization({ center: [Infinity, 2, 3], scale: 1 }), null);
  assert.equal(validateSplatNormalization({ center: [1, -Infinity, 3], scale: 1 }), null);
  assert.equal(validateSplatNormalization({ center: [1, null, 3], scale: 1 }), null);
});

test('validateSplatNormalization rejects invalid scale values (strings, non-positive, NaN, Infinity)', () => {
  assert.equal(validateSplatNormalization({ center: [0, 0, 0], scale: 0 }), null);
  assert.equal(validateSplatNormalization({ center: [0, 0, 0], scale: -1 }), null);
  assert.equal(validateSplatNormalization({ center: [0, 0, 0], scale: '1.5' }), null);
  assert.equal(validateSplatNormalization({ center: [0, 0, 0], scale: NaN }), null);
  assert.equal(validateSplatNormalization({ center: [0, 0, 0], scale: Infinity }), null);
});

test('resolveSplatPlacement defaults correctly when empty or invalid', () => {
  const expectedDefault = { center: [0, 0, 0], scale: 1, source: 'default' };
  assert.deepEqual(resolveSplatPlacement(), expectedDefault);
  assert.deepEqual(resolveSplatPlacement({}), expectedDefault);
  assert.deepEqual(resolveSplatPlacement({ configured: null, scanned: null }), expectedDefault);
  assert.deepEqual(resolveSplatPlacement({ configured: { scale: -1 }, scanned: { center: [1] } }), expectedDefault);
});

test('resolveSplatPlacement prioritizes configured over scanned and applies correct source labels', () => {
  const configured = { center: [1, 1, 1], scale: 2 };
  const scanned = { center: [2, 2, 2], scale: 3 };

  const resConfigured = resolveSplatPlacement({ configured, scanned });
  assert.deepEqual(resConfigured, { center: [1, 1, 1], scale: 2, source: 'configured' });
  assert.ok(Object.isFrozen(resConfigured));
  assert.ok(Object.isFrozen(resConfigured.center));

  const resScanned = resolveSplatPlacement({ configured: { scale: 0 }, scanned });
  assert.deepEqual(resScanned, { center: [2, 2, 2], scale: 3, source: 'scanned' });
  assert.ok(Object.isFrozen(resScanned));
  assert.ok(Object.isFrozen(resScanned.center));
});

test('resolveSplatPlacement protects against input mutations', () => {
  const configuredCenter = [5, 6, 7];
  const res = resolveSplatPlacement({ configured: { center: configuredCenter, scale: 2 } });
  configuredCenter[0] = 99;
  assert.equal(res.center[0], 5);
});


test('viewer loads normalization helper only for opt-in metadata and identifies KSplat explicitly', () => {
  const viewer = fs.readFileSync(new URL('../viewer3d.js', import.meta.url), 'utf8');
  assert.doesNotMatch(viewer, /^import .*splat-normalization/m);
  assert.match(viewer, /await import\('\.\/splat-normalization\.js'\)/);
  assert.match(viewer, /ext === 'KSPLAT'[\s\S]*SceneFormat\.KSplat/);
});
