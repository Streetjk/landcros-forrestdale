import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const admin = await readFile(new URL('../admin3d.js', import.meta.url), 'utf8');
const viewer = await readFile(new URL('../viewer3d.js', import.meta.url), 'utf8');
const session = await readFile(new URL('../my-pins-session.js', import.meta.url), 'utf8');

test('account My Pins publish/revoke a per-pin capability and never fall back to scene shareCode', () => {
  assert.match(admin, /Publish guide/);
  assert.match(admin, /Stop sharing/);
  assert.match(admin, /_accountShareTokens = new Map\(\)/);
  assert.match(admin, /revokeShareCapability\(pointId\)[\s\S]*_adminSave\('shared'\)[\s\S]*issueShareCapability\(pointId\)/);
  assert.match(admin, /revokeShareCapability\(pointId\)[\s\S]*_adminSave\('personal'\)/);
  assert.match(admin, /buildMyPinShareUrl\(location\.origin, token, pt\.id\)/);
  assert.match(admin, /Guide is published, but secure sharing is unavailable\. No public link was issued\./);
  assert.doesNotMatch(admin, /buildMyPinShareUrl\([^\n]*shareCode/);
  assert.match(admin, /_accountShareTokens\.delete\(snapshot\.id\)/);
  assert.match(admin, /_accountShareTokens\.clear\(\)/);
});

test('plaintext account share capability is transient memory, not persisted by My Pins state/UI', () => {
  assert.match(admin, /_accountShareTokens = new Map\(\)/);
  assert.doesNotMatch(admin, /localStorage\.(?:setItem|getItem)\([^\n]*_accountShareTokens/);
  assert.doesNotMatch(admin, /sessionStorage\.(?:setItem|getItem)\([^\n]*_accountShareTokens/);
  assert.doesNotMatch(admin, /JSON\.stringify\(_accountShareTokens/);
  assert.match(session, /return deepClone\(await api\.issueAccountPinShareCapability/);
  assert.doesNotMatch(session, /state\.[A-Za-z0-9_]*(?:token|capabilit)/i);
});

test('public My Pins viewer reads fragment bearer only for the exact point and compressed photos', () => {
  assert.match(viewer, /new URLSearchParams\(\(window\.location\.hash \|\| ''\)\.replace\(\/\^#\//);
  assert.doesNotMatch(viewer, /_params\.get\('myPin'\)/);
  assert.match(viewer, /_publicMyPinActive/);
  assert.match(viewer, /fetch\(`\/api\/my-pins\/points\/\$\{encodeURIComponent\(_deepId\)\}`/);
  assert.match(viewer, /Authorization: `Bearer \$\{_publicMyPinToken\}`/);
  assert.match(viewer, /cache: 'no-store', referrerPolicy: 'no-referrer'/);
  assert.match(viewer, /buildMyPinPhotoUrl\(pt\.id, ph\.id\)/);
  assert.match(viewer, /URL\.createObjectURL\(blob\)/);
  assert.match(viewer, /URL\.revokeObjectURL\(url\)/);
  assert.doesNotMatch(viewer, /\/api\/scenes\/by-code\/\$\{encodeURIComponent\(_publicMyPin/);
  assert.match(viewer, /_sceneCode && !_publicMyPinMode/);
  assert.match(viewer, /const hashMatch = _publicMyPinMode \? null/);
  assert.match(viewer, /const _shortCode = _publicMyPinMode \? null/);
  assert.match(viewer, /\(_sceneCode \|\| _publicMyPinMode\) \? null : _params\.get\('d'\)/);
});

test('account-pin phone override is callable only in the authorized My Pin context', () => {
  assert.match(admin, /Phone override \(optional\)/);
  assert.match(admin, /id="field-phone-override"/);
  assert.match(admin, /snapshot\.phoneOverride = rawOverride \|\| null/);
  assert.doesNotMatch(admin, /_contacts\[.*\]\.phone\s*=/);

  assert.match(viewer, /buildPointDetailModel\(pt, _allContacts, \{[\s\S]*phoneOverride: \(_publicMyPinActive && pt\.id === _publicMyPinPointId\) \? pt\.phoneOverride : null/);
  assert.match(viewer, /const overridePhone = detailModel\.fallbackPhone;/);
  assert.match(viewer, /const sanitized = c\.phone;/);
});
