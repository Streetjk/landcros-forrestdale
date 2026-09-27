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
  assert.match(admin, /revokeShareCapability\(pointId\)[\s\S]*_adminSave\('shared', \{[\s\S]*?operationLock: true[\s\S]*?expectedPointId: pointId[\s\S]*?expectedSession: session[\s\S]*?issueShareCapability\(pointId\)/);
  assert.match(admin, /revokeShareCapability\(pointId\)[\s\S]*_adminSave\('personal', \{[\s\S]*?operationLock: true[\s\S]*?expectedPointId: pointId[\s\S]*?expectedSession: session/);
  assert.match(admin, /const stillCurrent = \(\) => \([\s\S]*?_accountSession === session[\s\S]*?_editingPoint\?\.id === pointId/);
  assert.match(admin, /_saving = true;\s*_setBusy\(true\);[\s\S]*?finally \{\s*_saving = false;\s*_setBusy\(false\);/);
  assert.match(admin, /Stop-sharing could not be confirmed[\s\S]*?_accountShareRecovery\.set\(pointId, 'uncertain'\)/);
  assert.match(admin, /buildMyPinShareUrl\(location\.origin, token, pt\.id\)/);
  assert.match(admin, /Guide is published, but link issuance could not be confirmed/);
  assert.doesNotMatch(admin, /buildMyPinShareUrl\([^\n]*shareCode/);
  assert.match(admin, /_accountShareTokens\.delete\(snapshot\.id\)/);
  assert.match(admin, /_accountShareTokens\.clear\(\)/);
});

test('switching editor pins clears any QR from the previous pin', () => {
  const start = admin.indexOf('function openEditor(');
  const end = admin.indexOf('window.closeEditor = function()', start);
  assert.ok(start >= 0 && end > start);
  const body = admin.slice(start, end);
  assert.match(body, /_clearShareQr\(\);[\s\S]*?_editingPoint = _copy\(pt\)/);
});

test('ordinary share-link access never implicitly rotates a distributed capability', () => {
  const helperStart = admin.indexOf('async function _buildShareUrl');
  const helperEnd = admin.indexOf('// ── Share link (inline display)', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = admin.slice(helperStart, helperEnd);
  assert.doesNotMatch(helper, /issueShareCapability/);
  assert.match(helper, /_accountShareTokens\.get\(pt\.id\)/);
  assert.match(helper, /explicitly rotate the link/);
  assert.match(admin, /Replace share link/);
  assert.match(admin, /A previously distributed link may still be active/);
  assert.match(admin, /Recover with new link/);
  assert.match(admin, /last link replacement could not be confirmed/);
  assert.match(admin, /previous scoped link is known to be revoked/);
  assert.match(admin, /currently distributed link and printed QR will stop working immediately/);
  assert.match(admin, /window\._adminReplaceShareCapability = async/);
  assert.match(admin, /if \(!ok\) return;\s*_captureDraft\(\);[\s\S]*?_clearShareQr\(\);\s*_saving = true/);
  assert.match(admin, /_clearShareQr\(\);[\s\S]*?issueShareCapability\(pointId\)/);
  assert.match(admin, /_accountShareTokens\.set\(pointId, cap\.token\);[\s\S]*_accountShareRecovery\.delete\(pointId\);[\s\S]*renderDrawerBody\(\)/);
  assert.match(admin, /_accountShareRecovery\.set\(pointId, 'uncertain'\);[\s\S]*renderDrawerBody\(\)/);
  assert.match(admin, /Share-link replacement could not be confirmed/);
  // Explicit publish/replacement still issues a fresh capability; only
  // ordinary display/QR/download access is non-mutating.
  assert.match(admin, /const cap = await _accountSession\.issueShareCapability\(pointId\)/);
});

test('recipient preview reuses the current in-memory capability without rotating or persisting it', () => {
  const previewStart = admin.indexOf('window._adminPreviewRecipient = () => {');
  const previewEnd = admin.indexOf('window._adminCopyShareUrl', previewStart);
  assert.ok(previewStart >= 0 && previewEnd > previewStart);
  const preview = admin.slice(previewStart, previewEnd);
  assert.match(admin, /Preview recipient/);
  assert.match(preview, /_accountShareTokens\.get\(_editingPoint\.id\)/);
  assert.match(preview, /buildMyPinShareUrl\(location\.origin, token, _editingPoint\.id\)/);
  assert.match(preview, /link\.target = '_blank'/);
  assert.match(preview, /link\.rel = 'noopener noreferrer'/);
  assert.doesNotMatch(preview, /issueShareCapability|localStorage|sessionStorage/);
});

test('reloaded published account pins expose explicit replacement but no unusable recipient controls', () => {
  const tokenBranch = admin.indexOf(': _accountShareTokens.has(pt.id)');
  const recoveryBranch = admin.indexOf(': shareRecovery === \'uncertain\'', tokenBranch);
  assert.ok(tokenBranch >= 0 && recoveryBranch > tokenBranch);
  const liveTokenUi = admin.slice(tokenBranch, recoveryBranch);
  assert.match(liveTokenUi, /QR/);
  assert.match(liveTokenUi, /Share link/);
  assert.match(liveTokenUi, /Preview recipient/);

  const recoveredStart = admin.indexOf(': \`<button class="pin-action-btn action" type="button" onclick="window._adminReplaceShareCapability()">Replace share link</button>');
  assert.ok(recoveredStart >= 0);
  const recoveredEnd = admin.indexOf(': isPersonal', recoveredStart);
  const recoveredUi = admin.slice(recoveredStart, recoveredEnd);
  assert.match(recoveredUi, /Replace share link/);
  assert.match(recoveredUi, /previously distributed link may still be active/);
  assert.doesNotMatch(recoveredUi, /Preview recipient|>QR<|>Share link</);
});

test('reloaded owners can revoke a published guide without recovering the bearer secret', () => {
  const start = admin.indexOf('window._adminSetAccountPublished = async');
  const end = admin.indexOf('window._adminReplaceShareCapability = async', start);
  assert.ok(start >= 0 && end > start);
  const lifecycle = admin.slice(start, end);
  assert.match(lifecycle, /await session\.revokeShareCapability\(pointId\)/);
  assert.match(lifecycle, /_adminSave\('personal'/);
  assert.doesNotMatch(lifecycle, /_accountShareTokens\.get\(pointId\)/);
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
  assert.match(viewer, /renderDetailContacts\(document, contactsEl, \{[\s\S]*contacts: detailModel\.contacts,[\s\S]*fallbackPhone: detailModel\.fallbackPhone/);
  assert.doesNotMatch(viewer, /fallbackPhone:\s*pt\.phoneOverride/);
});
