import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  classifyPublicStaticPath,
  PUBLIC_ROOT_FILES,
  PUBLIC_DATA_FILES,
} = require('../static-public-files.js');
const { projectLegacySharePinData } = require('../data-projections.js');

test('public static allowlist serves required UI/data and denies raw/private repository paths', () => {
  for (const path of ['/', '/viewer3d.html', '/viewer3d', '/viewer3d.js', '/style.css', '/data/config.json', '/data/buildings.geojson', '/assets/site-lite.splat', '/logo.png']) {
    assert.ok(classifyPublicStaticPath(path), `expected public: ${path}`);
  }
  for (const path of [
    '/data/contacts.json', '/data/changelog.json', '/data/shared-links.json', '/data/points.json',
    '/sites/landcros/data/contacts.json', '/sites/greenfields/data/contacts.json',
    '/server.js', '/supabase-db.js', '/auth-db.js', '/package.json', '/render.yaml',
    '/.env', '/.env.example', '/.git/config', '/AGENTS.md', '/README.md',
    '/assets/satellite-labelled.psd', '/assets/dirtwithrocks-ogl.zip', '/assets/.backup.json', '/assets/.private/contacts.json', '/assets/contacts.json',
  ]) assert.equal(classifyPublicStaticPath(path), null, `expected denied: ${path}`);
  assert.ok(classifyPublicStaticPath('/assets/UPPER.PNG'));
  assert.ok(classifyPublicStaticPath('/assets/site-map-bounds.json'));
});

test('static allowlist fails closed for traversal, encoded traversal, dotfiles and unsupported assets', () => {
  for (const path of ['/data/../contacts.json', '/data/%2e%2e/contacts.json', '/assets/../server.js', '/assets/%2e%2e/server.js', '/assets/.secret.png', '/%2eenv', '/sites%2flandcros%2fdata%2fcontacts.json', '/data/%00contacts.json']) {
    assert.equal(classifyPublicStaticPath(path), null, path);
  }
});

test('declared browser root files exist and sensitive site data is absent from the public data set', () => {
  for (const file of PUBLIC_ROOT_FILES) assert.ok(fs.existsSync(file), file);
  assert.deepEqual([...PUBLIC_DATA_FILES].sort(), ['buildings.geojson', 'config.json', 'roads.json', 'traffic.json']);
});

test('legacy share projection strips arbitrary keys and contact email/audit fields', () => {
  const result = projectLegacySharePinData({
    id: 'pin-1', label: 'Gate', type: 'meet-point', scope: 'shared', notes: 'Meet here',
    latlng: [-32, 116], position3d: { x: 1, y: 0, z: 2 }, contactIds: ['c-1'],
    secret: 'never-return', createdBy: 'internal-user',
    contacts: [{ id: 'c-1', name: 'Staff', role: 'Guide', phone: '08 0000 0000', email: 'private@example.com', active: true, createdBy: 'internal' }],
  });
  assert.equal(result.secret, undefined);
  assert.equal(result.createdBy, undefined);
  assert.equal(result.contacts[0].email, undefined);
  assert.equal(result.contacts[0].createdBy, undefined);
  assert.deepEqual(Object.keys(result.contacts[0]).sort(), ['active', 'id', 'name', 'phone', 'role']);
});

test('legacy share projection rejects nested arbitrary keys and malformed typed fields', () => {
  const result = projectLegacySharePinData({
    id: 'pin-2', label: 'Gate', type: 'meet-point',
    position3d: { x: 1, y: 2, z: 3, email: 'nested@example.test' },
    cameraPreset3d: {
      position: { x: 1, y: 2, z: 3, secret: 'x' },
      lookAt: { x: 0, y: 0, z: 0, email: 'camera@example.test' },
      arbitrary: { email: 'x@example.test' },
    },
    routeWaypoints3d: [{ x: 4, y: 5, z: 6, email: 'route@example.test' }],
    contacts: [
      { id: 'c-good', name: 'Valid', phone: '08 0000 0000', email: 'private@example.test', active: true },
      { id: 'c-bad', name: { email: 'nested@example.test' }, phone: { secret: 'x' }, active: true },
    ],
  });
  assert.deepEqual(result.position3d, { x: 1, y: 2, z: 3 });
  assert.deepEqual(result.cameraPreset3d, { position: { x: 1, y: 2, z: 3 }, lookAt: { x: 0, y: 0, z: 0 } });
  assert.deepEqual(result.routeWaypoints3d, [{ x: 4, y: 5, z: 6 }]);
  assert.equal(result.contacts.length, 1);
  assert.deepEqual(result.contacts[0], { id: 'c-good', name: 'Valid', phone: '08 0000 0000', active: true });
  assert.doesNotMatch(JSON.stringify(result), /example\.test|secret/);
});

test('runtime source disables arbitrary legacy share creation and projects legacy GET payloads', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  assert.match(server, /LEGACY_SHARE_CREATE_DISABLED/);
  assert.match(server, /projectLegacySharePinData\(entry\.pinData\)/);
  assert.doesNotMatch(server, /links\[code\] = \{ pinData, created:/);
  const viewer = fs.readFileSync('viewer3d.js', 'utf8');
  assert.doesNotMatch(viewer, /fetch\(['"]\.\/data\/points\.json/);
});
