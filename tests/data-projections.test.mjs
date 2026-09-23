import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projections = require('../data-projections.js');
const {
  staffPoint,
  publicBasePoint,
  publicSharedPoint,
  staffContact,
  publicContact,
  publicPointPhoto
} = projections;

describe('Data Projections Unit Tests', () => {
  const samplePointRow = {
    id: 'p-1',
    scene_id: 's-100',
    label: 'Main Entrance',
    type: 'entrance',
    scope: 'public',
    latlng: [1.23, 4.56],
    position3d: { x: 1, y: 2, z: 3 },
    notes: 'Ground floor',
    contact_ids: ['c-1', 'c-2'],
    route_waypoints: [[1, 2], [3, 4]],
    route_waypoints3d: [{ x: 0, y: 0, z: 0 }],
    camera_preset3d: { pitch: 10 },
    building_ref: 'B1',
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    unknown_internal_key: 'confidential'
  };

  const sampleContactRow = {
    id: 'c-1',
    name: 'Alice',
    role: 'Security',
    phone: '123-4567',
    email: 'alice@internal.corp',
    active: true,
    created_by: 'admin',
    created_at: '2026-01-01T00:00:00Z',
    internal_secret: 'secret'
  };

  const samplePhotoRow = {
    id: 'ph-1',
    point_id: 'p-1',
    bytes: 1024,
    width: 800,
    height: 600,
    expires_at: '2026-03-01T00:00:00Z',
    source_bucket: 'private-bucket'
  };

  it('verifies exact sorted Object.keys for staffPoint', () => {
    const res = staffPoint(samplePointRow);
    const expectedKeys = [
      'buildingRef',
      'cameraPreset3d',
      'contactIds',
      'createdAt',
      'createdBy',
      'id',
      'label',
      'latlng',
      'notes',
      'position3d',
      'routeWaypoints',
      'routeWaypoints3d',
      'sceneId',
      'scope',
      'type',
      'updatedAt'
    ].sort();
    assert.deepEqual(Object.keys(res).sort(), expectedKeys);
    assert.equal(res.unknown_internal_key, undefined);
  });

  it('verifies exact sorted Object.keys for publicBasePoint and publicSharedPoint (no override)', () => {
    const expectedKeys = [
      'buildingRef',
      'cameraPreset3d',
      'contactIds',
      'id',
      'label',
      'latlng',
      'notes',
      'position3d',
      'routeWaypoints',
      'routeWaypoints3d',
      'scope',
      'type'
    ].sort();

    const baseRes = publicBasePoint(samplePointRow);
    const sharedRes = publicSharedPoint(samplePointRow);

    assert.deepEqual(Object.keys(baseRes).sort(), expectedKeys);
    assert.deepEqual(Object.keys(sharedRes).sort(), expectedKeys);

    for (const forbidden of ['sceneId', 'createdBy', 'createdAt', 'updatedAt', 'scene_id', 'created_by', 'created_at', 'updated_at']) {
      assert.equal(baseRes[forbidden], undefined);
      assert.equal(sharedRes[forbidden], undefined);
    }
  });

  it('keeps base points free of phone overrides while shared points expose only a trimmed override', () => {
    const baseWithOverride = publicBasePoint({ ...samplePointRow, phone_override: '555-0199' });
    assert.equal(baseWithOverride.phoneOverride, undefined);

    const withEmpty = publicSharedPoint({ ...samplePointRow, phone_override: '' });
    assert.equal(withEmpty.phoneOverride, undefined);
    assert.equal(Object.keys(withEmpty).includes('phoneOverride'), false);

    const withOverride = publicSharedPoint({ ...samplePointRow, phoneOverride: ' 555-0199 ' });
    assert.equal(withOverride.phoneOverride, '555-0199');
    assert.deepEqual(Object.keys(withOverride).sort(), [
      'buildingRef',
      'cameraPreset3d',
      'contactIds',
      'id',
      'label',
      'latlng',
      'notes',
      'phoneOverride',
      'position3d',
      'routeWaypoints',
      'routeWaypoints3d',
      'scope',
      'type'
    ].sort());
  });

  it('verifies exact sorted Object.keys for staffContact', () => {
    const res = staffContact(sampleContactRow);
    const expectedKeys = [
      'active',
      'createdAt',
      'createdBy',
      'email',
      'id',
      'name',
      'phone',
      'role'
    ].sort();
    assert.deepEqual(Object.keys(res).sort(), expectedKeys);
    assert.equal(res.internal_secret, undefined);
  });

  it('verifies exact sorted Object.keys for publicContact and phone override behavior', () => {
    const res = publicContact(sampleContactRow);
    const expectedKeys = ['active', 'id', 'name', 'phone', 'role'].sort();
    assert.deepEqual(Object.keys(res).sort(), expectedKeys);
    assert.equal(res.email, undefined);
    assert.equal(res.phone, '123-4567');

    const resOverridden = publicContact(sampleContactRow, { phoneOverride: '999-0000' });
    assert.equal(resOverridden.phone, '999-0000');

    const resEmptyOverride = publicContact(sampleContactRow, { phoneOverride: '' });
    assert.equal(resEmptyOverride.phone, '123-4567');
  });

  it('verifies exact sorted Object.keys for publicPointPhoto', () => {
    const res = publicPointPhoto(samplePhotoRow);
    const expectedKeys = [
      'bytes',
      'contentType',
      'expiresAt',
      'height',
      'id',
      'pointId',
      'width'
    ].sort();
    assert.deepEqual(Object.keys(res).sort(), expectedKeys);
    assert.equal(res.contentType, 'image/jpeg');
    assert.equal(res.source_bucket, undefined);
  });

  it('ensures input arrays are not mutated through returned objects', () => {
    const rawIds = ['c-1', 'c-2'];
    const point = publicBasePoint({ ...samplePointRow, contact_ids: rawIds });
    point.contactIds.push('c-new');
    assert.equal(rawIds.length, 2);
  });

  it('static source assertions on supabase-db.js and scenes-db.js', () => {
    const supabaseSrc = fs.readFileSync(path.resolve('supabase-db.js'), 'utf8');
    const scenesSrc = fs.readFileSync(path.resolve('scenes-db.js'), 'utf8');

    assert.match(supabaseSrc, /publicBasePoint/);
    assert.match(scenesSrc, /publicSharedPoint/);
    assert.match(scenesSrc, /publicContact/);
    assert.doesNotMatch(scenesSrc, /delete\s+\w+\.created/);
  });
});
