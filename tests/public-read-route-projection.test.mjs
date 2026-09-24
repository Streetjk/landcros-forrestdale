import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { publicBasePoint, publicContact } = require('../data-projections.js');
const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

function routeBlock(startNeedle, endNeedle) {
  const start = serverSource.indexOf(startNeedle);
  assert.notEqual(start, -1, `missing route start: ${startNeedle}`);
  const end = serverSource.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `missing route end: ${endNeedle}`);
  return serverSource.slice(start, end);
}

test('anonymous point/contact HTTP routes re-project DAL results before serialization', () => {
  assert.match(
    serverSource,
    /require\('\.\/data-projections'\)/,
    'server must source anonymous allowlists from data-projections',
  );

  const points = routeBlock(
    "if (pathname === '/api/points' && (req.method === 'GET' || req.method === 'POST'))",
    'const _pointDeleteMatch',
  );
  assert.match(points, /sdb\.getPoints\(SITE, \{ baseOnly: true \}\)/);
  assert.match(points, /points\.map\(publicBasePoint\)\.filter\(Boolean\)/);
  assert.match(points, /JSON\.stringify\(publicPoints\)/);
  assert.doesNotMatch(points, /JSON\.stringify\(points\)/);

  const contacts = routeBlock(
    "if (pathname === '/api/contacts' && req.method === 'GET')",
    "if (pathname === '/api/contacts' && req.method === 'POST')",
  );
  assert.match(contacts, /sdb\.getContacts\(SITE, \{ baseOnly: true \}\)/);
  assert.match(contacts, /contacts\.map\(publicContact\)\.filter\(Boolean\)/);
  assert.match(contacts, /JSON\.stringify\(publicContacts\)/);
  assert.doesNotMatch(contacts, /JSON\.stringify\(contacts\)/);
});

test('anonymous point projection drops scene-scoped and personal rows before serialization', () => {
  const base = {
    id: '10000000-0000-0000-0000-000000000001',
    scene_id: null,
    label: 'Visitor gate',
    type: 'drop-off',
    scope: 'shared',
  };
  const projected = [
    base,
    { ...base, id: '10000000-0000-0000-0000-000000000002', scene_id: '40000000-0000-0000-0000-000000000001' },
    { ...base, id: '10000000-0000-0000-0000-000000000003', scope: 'personal' },
    { ...base, id: '10000000-0000-0000-0000-000000000004', sceneId: '40000000-0000-0000-0000-000000000002' },
  ].map(publicBasePoint).filter(Boolean);

  assert.deepEqual(projected.map((point) => point.id), [base.id]);
});

test('HTTP-boundary projectors strip staff and unknown columns from representative raw rows', () => {
  const point = publicBasePoint({
    id: '10000000-0000-0000-0000-000000000001',
    scene_id: null,
    label: 'Visitor gate',
    type: 'drop-off',
    scope: 'shared',
    latlng: [-32.0, 115.9],
    position3d: { x: 1, y: 0, z: 2 },
    notes: 'Use gate A',
    contact_ids: ['20000000-0000-0000-0000-000000000001'],
    route_waypoints: [],
    route_waypoints3d: [],
    camera_preset3d: null,
    building_ref: 'gate-a',
    created_by: '30000000-0000-0000-0000-000000000001',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    internal_note: 'must-not-leak',
  });
  assert.deepEqual(Object.keys(point).sort(), [
    'buildingRef', 'cameraPreset3d', 'contactIds', 'id', 'label', 'latlng',
    'notes', 'position3d', 'routeWaypoints', 'routeWaypoints3d', 'scope', 'type',
  ].sort());
  assert.equal(JSON.stringify(point).includes('must-not-leak'), false);

  const contact = publicContact({
    id: '20000000-0000-0000-0000-000000000001',
    name: 'Synthetic Contact',
    role: 'Gate coordinator',
    phone: '(00) 0000 0000',
    email: 'private@example.invalid',
    active: true,
    created_by: '30000000-0000-0000-0000-000000000001',
    created_at: '2026-01-01T00:00:00Z',
    private_extension: 'must-not-leak',
  });
  assert.deepEqual(Object.keys(contact).sort(), ['active', 'id', 'name', 'phone', 'role']);
  const serialized = JSON.stringify(contact);
  assert.equal(serialized.includes('private@example.invalid'), false);
  assert.equal(serialized.includes('must-not-leak'), false);
});
