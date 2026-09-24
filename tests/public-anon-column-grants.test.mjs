import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('supabase/migrations/0016_public_column_grants.sql', 'utf8');
const normalized = source.replace(/--.*$/gm, '').replace(/\s+/g, ' ');

function anonGrant(table) {
  const match = normalized.match(new RegExp(`grant select \\(([^)]*)\\) on table ${table} to anon;`, 'i'));
  assert.ok(match, `expected explicit anon column grant for ${table}`);
  return match[1].split(',').map(value => value.trim()).filter(Boolean);
}

test('anon table SELECT is removed and authenticated privileges are untouched', () => {
  assert.match(normalized, /revoke select on table sites, points, contacts from anon;/i);
  assert.doesNotMatch(normalized, /(?:grant|revoke)[^;]*\bauthenticated\b[^;]*;/i);
});

test('known staff and audit columns are explicitly revoked from anon', () => {
  assert.match(normalized, /revoke select \(config, created_by, created_at, updated_at\) on table sites from anon;/i);
  assert.match(normalized, /revoke select \(scene_id, phone_override, created_by, created_at, updated_at\) on table points from anon;/i);
  assert.match(normalized, /revoke select \(email, created_by, created_at\) on table contacts from anon;/i);
});

test('direct anon site reads are limited to public navigation metadata', () => {
  assert.deepEqual(anonGrant('sites'), ['id', 'slug', 'name', 'title', 'address', 'logo', 'published']);
});

test('direct anon point reads match the public base-point field set', () => {
  assert.deepEqual(anonGrant('points'), [
    'id', 'site_id', 'label', 'type', 'scope', 'latlng', 'position3d', 'notes',
    'contact_ids', 'route_waypoints', 'route_waypoints3d', 'camera_preset3d', 'building_ref',
  ]);
});

test('direct anon contact reads omit email and audit metadata', () => {
  assert.deepEqual(anonGrant('contacts'), ['id', 'site_id', 'name', 'role', 'phone', 'active']);
});

test('sensitive columns are absent from every anonymous grant', () => {
  const granted = new Set([...anonGrant('sites'), ...anonGrant('points'), ...anonGrant('contacts')]);
  for (const denied of ['config', 'created_by', 'created_at', 'updated_at', 'email', 'scene_id', 'phone_override']) {
    assert.equal(granted.has(denied), false, `${denied} must remain unavailable to anon`);
  }
});
