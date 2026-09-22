import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const caps = require('../my-pin-capabilities-db');

test('My Pin capability tokens are 32-byte base64url values', () => {
  const first = caps.generateToken();
  const second = caps.generateToken();
  assert.match(first, caps.TOKEN_RE);
  assert.match(second, caps.TOKEN_RE);
  assert.equal(Buffer.from(first, 'base64url').length, 32);
  assert.equal(Buffer.from(second, 'base64url').length, 32);
  assert.notEqual(first, second);
});

test('My Pin capability persistence uses a SHA-256 digest only', () => {
  const token = caps.generateToken();
  const digest = caps.hashToken(token);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(caps.hashToken(token), digest);
  assert.equal(caps.hashToken('not a capability'), null);
  assert.notEqual(digest, token);
});
