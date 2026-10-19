import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canManageScene } = require('../resource-ownership.js');
const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const server = read('server.js');
const scenes = read('scenes-db.js');
const editor = read('scene-editor.js');
const viewer = read('viewer3d.js');

test('photo/gallery/group JSON response helper is defined on the deployed-base hotfix', () => {
  assert.match(server, /function _json\(res, code, obj\)\s*\{[^}]*res\.writeHead\(code/);
  assert.match(server, /const _galleryMatch[\s\S]*?_json\(res,200,result\)/);
  assert.match(server, /const _groupList[\s\S]*?perform\(body\)\.then\(data => _json\(res,200,data\)\)/);
  assert.match(server, /const _scenesCopyMatch|const _sceneCopyMatch|const _duplicateMatch|sceneDuplicate/);
});

test('gallery writes enforce scene ownership as well as editor role and site scope', () => {
  assert.match(server, /function _requireSiteEditor\(req, res, slug, cb\)/);
  assert.match(server, /async function _managedSceneOrRespond\(res, slug, sceneId, session\)/);
  assert.match(server, /scenesDb\.getSceneMeta\(slug, sceneId\)/);
  assert.match(server, /canManageScene\(meta, session, auth\.isPlatformAdmin\(session\.email\)\)/);
  assert.match(scenes, /select id, created_by from scenes where id = \$1 and site_id = \$2/);
  assert.match(server, /if \(!await _managedSceneOrRespond\(res,slug,body\.sceneId,session\)\) return/);
});

test('only the owner, platform admin, or legacy ownerless scene can receive a write', () => {
  const scene = { id: 'scene', createdBy: 'creator' };
  assert.equal(canManageScene(scene, { profileId: 'creator' }), true);
  assert.equal(canManageScene(scene, { profileId: 'someone-else' }), false);
  assert.equal(canManageScene(scene, { profileId: 'someone-else' }, true), true);
  assert.equal(canManageScene({ createdBy: null }, { profileId: 'site-editor' }), true);
  assert.equal(canManageScene(scene, null, true), false);
  assert.equal(canManageScene(null, { profileId: 'creator' }, true), false);
});

test('failed scene or pin loads stay visible as failures and can be retried', () => {
  assert.match(editor, /function showSceneReloadError\(message, retry, replaceList = false\)/);
  assert.match(editor, /text\.textContent = message \+ ' This loading error did not delete any records\.'/);
  assert.match(editor, /button\.addEventListener\('click', \(\) => void retry\(\)\)/);
  assert.match(editor, /if \(!response\.ok\) throw new Error\('scene list unavailable'\)/);
  assert.match(editor, /if \(!response\.ok\) throw new Error\('pin list unavailable'\)/);
  assert.match(editor, /showSceneReloadError\('Saved scenes could not be loaded\.', loadScenes, true\)/);
  assert.match(editor, /showSceneReloadError\('Saved pins could not be loaded\.', loadObjects\)/);
  assert.match(editor, /const enabled = !!_currentSceneId && _sceneObjectsReady/);
  assert.match(editor, /_sceneObjectsReady = true;\s*updateAddButtonsEnabled\(\)/);
  assert.match(editor, /status\.textContent = uploadFailure \? uploadFailure \+ ' — photo was not added\.'/);
});

test('editor splat worker matches static performance policy with Edge/Brave fallback', () => {
  assert.match(viewer, /navigator\.brave && await navigator\.brave\.isBrave\(\)/);
  assert.match(viewer, /\/Edg\\\/\/.test\(navigator\.userAgent\)/);
  assert.match(viewer, /self\.crossOriginIsolated === true/);
  assert.match(viewer, /gpuAcceleratedSort: gpuSortOk/);
  assert.match(viewer, /sharedMemoryForWorkers: sharedMemOk/);
  assert.doesNotMatch(viewer, /gpuAcceleratedSort: false,[\s\S]{0,50}sharedMemoryForWorkers: false/);
});
