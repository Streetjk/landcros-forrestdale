import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const projections = require('../data-projections.js');
const {
  staffSite,
  staffScene,
  publicSharedScene,
  publicMyPinScene,
  staffPoint,
  publicBasePoint,
  publicSharedPoint,
  staffContact,
  publicContact,
  publicPointPhoto
} = projections;

describe('Data Projections Unit Tests', () => {
  const sampleSiteRow = {
    id: 'site-1',
    slug: 'landcros',
    name: 'LANDCROS Forrestdale',
    title: 'Visitor guide',
    published: true,
    created_at: '2026-09-20T01:02:03Z',
    address: 'private staff context',
    logo: 'internal-logo.png',
    config: { internal: true },
    created_by: 'profile-1',
  };

  const sampleSceneRow = {
    id: 's-1',
    name: 'Visitor guide',
    share_code: 'abcde23456',
    camera: { purpose: 'guide', nested: { zoom: 2 } },
    kind: 'admin',
    status: 'escalated',
    status_changed_at: '2026-01-03T00:00:00Z',
    status_changed_by_email: 'operator@internal.corp',
    created_by: 'profile-1',
    created_by_email: 'creator@internal.corp',
    is_mine: true,
    subscribed: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    internal_secret: 'do-not-expose'
  };

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


  it('defines an exact authenticated staff site-list contract', () => {
    const site = staffSite(sampleSiteRow);
    assert.deepEqual(Object.keys(site).sort(), [
      'createdAt', 'id', 'name', 'published', 'slug', 'title'
    ].sort());
    assert.deepEqual(site, {
      id: 'site-1', slug: 'landcros', name: 'LANDCROS Forrestdale',
      title: 'Visitor guide', published: true, createdAt: '2026-09-20T01:02:03Z',
    });
    for (const forbidden of ['address', 'logo', 'config', 'created_by']) {
      assert.equal(site[forbidden], undefined);
    }
    assert.deepEqual(staffSite({ ...sampleSiteRow, title: null, published: false, createdAt: 'camel-date' }), {
      id: 'site-1', slug: 'landcros', name: 'LANDCROS Forrestdale',
      title: null, published: false, createdAt: 'camel-date',
    });
  });

  it('defines exact staff and public scene contracts without widening public data', () => {
    const staff = staffScene(sampleSceneRow);
    assert.deepEqual(Object.keys(staff).sort(), [
      'camera','createdAt','createdBy','createdByEmail','id','isMine','kind','name',
      'shareCode','status','statusChangedAt','statusChangedByEmail','subscribed','updatedAt'
    ].sort());
    assert.equal(staff.shareCode, 'abcde23456');
    assert.equal(staff.createdByEmail, 'creator@internal.corp');
    assert.equal(staff.internal_secret, undefined);

    const anon = publicSharedScene(sampleSceneRow);
    assert.deepEqual(Object.keys(anon).sort(), [
      'camera','createdByEmail','id','kind','name','status','statusChangedAt','statusChangedByEmail'
    ].sort());
    assert.equal(anon.createdByEmail, null);
    assert.equal(anon.statusChangedByEmail, null);
    for (const forbidden of ['shareCode','createdBy','createdAt','updatedAt','isMine','subscribed','internal_secret']) {
      assert.equal(anon[forbidden], undefined);
    }

    const signedIn = publicSharedScene(sampleSceneRow, { includeAuditEmails: true });
    assert.equal(signedIn.createdByEmail, 'creator@internal.corp');
    assert.equal(signedIn.statusChangedByEmail, 'operator@internal.corp');

    const sparse = publicSharedScene({ id: 's-2', name: 'Sparse', kind: 'admin' }, { includeAuditEmails: true });
    assert.equal(sparse.statusChangedAt, undefined);
    assert.equal(sparse.statusChangedByEmail, undefined);
    assert.equal(sparse.createdByEmail, undefined);

    assert.deepEqual(publicMyPinScene(sampleSceneRow), { name: 'Visitor guide', kind: 'admin' });
  });

  it('deeply detaches scene camera JSON across staff and public projections', () => {
    const source = structuredClone(sampleSceneRow);
    for (const project of [staffScene, publicSharedScene]) {
      const projected = project(source);
      projected.camera.nested.zoom = 99;
      assert.equal(source.camera.nested.zoom, 2);
    }
  });

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

  it('deeply detaches nested point JSON for public and staff projections', () => {
    const source = {
      ...samplePointRow,
      position3d: { x: 1, nested: { floor: 2 } },
      route_waypoints: [[1, 2], [3, 4]],
      route_waypoints3d: [{ x: 1, meta: { speed: 2 } }],
      camera_preset3d: { target: [1, 2, 3], lens: { fov: 55 } }
    };
    const original = structuredClone(source);

    for (const project of [publicBasePoint, staffPoint]) {
      const point = project(source);
      point.position3d.nested.floor = 99;
      point.routeWaypoints[0][0] = 99;
      point.routeWaypoints3d[0].meta.speed = 99;
      point.cameraPreset3d.target[0] = 99;
      point.cameraPreset3d.lens.fov = 99;
      assert.deepEqual(source, original);
    }
  });

  it('deep clone preserves JSON __proto__ keys without prototype mutation', () => {
    const source = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"nested":1}}');
    const point = publicBasePoint({ ...samplePointRow, position3d: source });

    assert.equal(Object.prototype.hasOwnProperty.call(point.position3d, '__proto__'), true);
    assert.deepEqual(point.position3d.__proto__, { polluted: true });
    assert.deepEqual(point.position3d.constructor, { nested: 1 });
    assert.equal(Object.getPrototypeOf(point.position3d), Object.prototype);
    assert.equal({}.polluted, undefined);
  });

  it('static source assertions on supabase-db.js and scenes-db.js', () => {
    const supabaseSrc = fs.readFileSync(path.resolve('supabase-db.js'), 'utf8');
    const scenesSrc = fs.readFileSync(path.resolve('scenes-db.js'), 'utf8');

    assert.match(supabaseSrc, /publicBasePoint/);
    assert.match(scenesSrc, /publicSharedScene/);
    assert.match(scenesSrc, /publicMyPinScene/);
    assert.match(scenesSrc, /publicSharedPoint/);
    assert.doesNotMatch(scenesSrc, /function\s+sceneToJson/);
    assert.match(scenesSrc, /publicContact/);
    assert.doesNotMatch(scenesSrc, /delete\s+\w+\.created/);
  });
});
