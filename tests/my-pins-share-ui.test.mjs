import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const admin = await readFile(new URL('../admin3d.js', import.meta.url), 'utf8');
const viewer = await readFile(new URL('../viewer3d.js', import.meta.url), 'utf8');

test('account My Pins require an explicit publish action and use point-qualified share URLs', () => {
  assert.match(admin, /Publish guide/);
  assert.match(admin, /Stop sharing/);
  assert.match(admin, /_adminSetAccountPublished/);
  assert.match(admin, /_adminSave\(target\)/);
  assert.match(admin, /requestedAccountScope/);
  assert.match(admin, /buildMyPinShareUrl\(location\.origin, scene\.shareCode, pt\.id\)/);
  assert.match(admin, /pt\?\.scope !== 'shared'/);
  assert.match(admin, /if \(_editingIsAccount\) return showToast\('Scoped share link is unavailable/);
  assert.match(admin, /if \(_editingIsAccount\) \{ sec\.style\.display = 'none'; return showToast\('Scoped QR is unavailable/);
  assert.doesNotMatch(admin, /Share link — not enabled/);
});

test('public My Pins viewer consumes only the point-qualified capability and compressed media', () => {
  assert.match(viewer, /_params\.get\('myPin'\)/);
  assert.match(viewer, /\/api\/scenes\/by-code\/\$\{encodeURIComponent\(_publicMyPinCode\)\}\/points\/\$\{encodeURIComponent\(_deepId\)\}/);
  assert.match(viewer, /_sceneBundle\?\.pins\?\.find\(p => p\.id === _deepId\)/);
  assert.match(viewer, /buildMyPinPhotoUrl\(_publicMyPinCode, pt\.id, ph\.id\)/);
  assert.match(viewer, /publicMyPin \? compressedUrl : `\$\{compressedUrl\}\?original=1`/);
  assert.match(viewer, /if \(_sceneBundle\?\.scene && _sceneCode && !_publicMyPinCode\) renderSceneStatusBar/);
  assert.match(viewer, /\(_sceneCode \|\| _publicMyPinCode\) \? null : _params\.get\('d'\)/);
  assert.match(viewer, /u\.searchParams\.delete\('myPin'\);[\s\S]*u\.searchParams\.delete\('d'\);/);
});
