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
  assert.match(viewer, /scenePins\.find\(p => p\.id === _deepId\)/);
  assert.match(viewer, /buildMyPinPhotoUrl\(_publicMyPinCode, pt\.id, ph\.id\)/);
  assert.match(viewer, /publicMyPin \? compressedUrl : `\$\{compressedUrl\}\?original=1`/);
  assert.match(viewer, /if \(_sceneBundle\?\.scene && _sceneCode && !_publicMyPinCode\) renderSceneStatusBar/);
  assert.match(viewer, /\(_sceneCode \|\| _publicMyPinCode\) \? null : _params\.get\('d'\)/);
  assert.match(viewer, /const hashMatch = _publicMyPinCode \? null : window\.location\.hash\.match/);
  assert.match(viewer, /const _shortCode = _publicMyPinCode \? null : _params\.get\('s'\)/);
  assert.match(viewer, /u\.searchParams\.delete\('myPin'\);[\s\S]*u\.searchParams\.delete\('d'\);/);
});

test('account-pin editor provides phone override input and viewer displays callable override', () => {
  // Clear label and field
  assert.match(admin, /Phone override \(optional\)/);
  assert.match(admin, /id="field-phone-override"/);
  assert.match(admin, /_editingPoint\.phoneOverride = overrideInput\.value/);
  assert.match(admin, /snapshot\.phoneOverride = rawOverride \|\| null/);
  // Contacts directory is not mutated
  assert.doesNotMatch(admin, /_contacts\[.*\]\.phone\s*=/);

  // Viewer displays callable phone link using the override
  assert.match(viewer, /pt\.phoneOverride/);
  assert.match(viewer, /displayPhone = \(_publicMyPinCode && pt\.id === _publicMyPinPointId && pt\.phoneOverride\) \? pt\.phoneOverride : c\.phone/);
  assert.match(viewer, /const sceneContacts = rawSceneContacts\.filter\(isRenderableContact\)/);
  assert.match(viewer, /_allContacts = \[\.\.\.sceneContacts, \.\.\.contacts\]/);

  // Viewer safely sanitizes phone numbers and does not show an empty phone
  assert.match(viewer, /sanitizePhone/);
  assert.match(viewer, /overridePhone = \(_publicMyPinCode && pt\.id === _publicMyPinPointId && pt\.phoneOverride\)\s*\?\s*sanitizePhone\(pt\.phoneOverride\)\s*:\s*null/);
  assert.match(viewer, /const sanitized = sanitizePhone\(displayPhone\);/);
});
