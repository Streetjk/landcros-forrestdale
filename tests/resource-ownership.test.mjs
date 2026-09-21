import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { canManageScene } = require('../resource-ownership.js');

const owner = { profileId: 'owner-profile' };
const other = { profileId: 'other-profile' };

test('scene owner may manage own scene', () => {
  assert.equal(canManageScene({ createdBy: 'owner-profile' }, owner, false), true);
});

test('non-owner editor may not manage an owned scene', () => {
  assert.equal(canManageScene({ createdBy: 'owner-profile' }, other, false), false);
});

test('scene subscription alone does not confer management', () => {
  assert.equal(canManageScene({ createdBy: 'owner-profile', subscribed: true }, other, false), false);
});

test('legacy ownerless scene remains manageable by signed-in editor', () => {
  assert.equal(canManageScene({ createdBy: null }, other, false), true);
  assert.equal(canManageScene({ created_by: null }, other, false), true);
});

test('platform admin override can manage any existing scene', () => {
  assert.equal(canManageScene({ createdBy: 'owner-profile' }, other, true), true);
});

test('missing scene or unauthenticated caller cannot manage', () => {
  assert.equal(canManageScene(null, owner, true), false);
  assert.equal(canManageScene({ createdBy: null }, null, false), false);
});
