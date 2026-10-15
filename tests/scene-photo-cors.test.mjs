import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const editor = readFileSync(new URL('../scene-editor.js', import.meta.url), 'utf8');
const viewer = readFileSync(new URL('../viewer3d.js', import.meta.url), 'utf8');

test('scene editor previews private Supabase images using CORS', () => {
  const start = editor.indexOf('function renderPinPhoto(');
  assert.ok(start >= 0);
  const end = editor.indexOf('function ', start + 15);
  const section = editor.slice(start, end >= 0 ? end : undefined);
  assert.match(section, /img\.crossOrigin\s*=\s*'anonymous'/);
  assert.match(section, /img\.referrerPolicy\s*=\s*'no-referrer'/);
  assert.ok(section.indexOf('img.crossOrigin') < section.indexOf('img.src=selected.url'));
});

test('public viewer opts into CORS before setting signed photo src', () => {
  const backendForm = viewer.includes('function resetSceneLabelPhoto(');
  const start = viewer.indexOf(backendForm ? 'function resetSceneLabelPhoto(' : 'function _renderSceneLabelBody(');
  assert.ok(start >= 0);
  const end = viewer.indexOf(backendForm ? '// ── Point selection' : '// Hazard pin detail:', start);
  assert.ok(end > start);
  const section = viewer.slice(start, end);
  assert.match(section, /img\.crossOrigin = 'anonymous'/);
  assert.match(section, /img\.referrerPolicy = 'no-referrer'/);
  assert.ok(section.indexOf('img.crossOrigin') < section.indexOf(backendForm ? 'img.src = url' : 'photo.src = url'));
});
