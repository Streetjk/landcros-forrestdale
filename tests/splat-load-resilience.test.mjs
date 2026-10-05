import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const viewer = fs.readFileSync(new URL('../viewer3d.js', import.meta.url), 'utf8');

test('splat network stages are bounded and raw download retries once', () => {
  assert.match(viewer, /async function _fetchWithTimeout[\s\S]*AbortController[\s\S]*Promise\.race\(\[request, timeout\]\)/);
  assert.match(viewer, /_fetchWithTimeout\(path, \{ method: 'HEAD', cache: 'no-store' \}, 8000\)/);
  assert.match(viewer, /async function _fetchSplatBytes[\s\S]*for \(let attempt = 0; attempt < 2; attempt\+\+\)/);
  assert.match(viewer, /cache: attempt === 0 \? 'default' : 'reload'/);
  assert.match(viewer, /30000,[\s\S]*return response\.arrayBuffer\(\)/);
  assert.match(viewer, /rawBuf = ext === 'SPLAT' \? await _fetchSplatBytes\(splatPath\) : null/);
  assert.doesNotMatch(viewer, /rawBuf = ext === 'SPLAT' \? await fetch\(splatPath\)/);
});

test('splat parser remains bounded and failure still reaches terminal fallback', () => {
  assert.match(viewer, /setTimeout\(\(\) => reject\(new Error\('GS3D timeout'\)\), 15000\)/);
  assert.match(viewer, /console\.warn\('Splat load failed:', err\)[\s\S]*sendStatus\('error'\)[\s\S]*return 'error'/);
});
