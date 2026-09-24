import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyDbError, summarizeDeploymentChecks } = require('../scripts/deployment-diagnostics.cjs');

test('database errors are classified without echoing sensitive provider text', () => {
  assert.deepEqual(classifyDbError({ code: '28P01', message: 'password authentication failed for user postgres' }), {
    category: 'authentication', message: 'Database authentication failed; refresh the deployment SUPABASE_DB_URL credential.'
  });
  assert.equal(classifyDbError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT 10.0.0.1' }).category, 'connectivity');
  assert.equal(classifyDbError({ code: 'ECONNRESET', message: 'socket reset' }).category, 'connectivity');
  assert.equal(classifyDbError({ code: '57014', message: 'canceling statement due to statement timeout' }).category, 'database');
  assert.equal(classifyDbError({ code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' }).category, 'tls');
  assert.equal(classifyDbError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND secret.example' }).category, 'dns');
  assert.equal(classifyDbError(new Error('DB_URL_REQUIRED')).category, 'configuration');
});

test('deployment findings identify stale build and broad DB outage only from status metadata', () => {
  const findings = summarizeDeploymentChecks([
    { path: '/api/site', status: 404 },
    { path: '/api/points', status: 500 },
    { path: '/api/contacts', status: 500 },
    { path: '/api/visits', status: 500 },
  ]);
  assert.deepEqual(findings.map(x => x.category), ['stale-deployment', 'database-routes-failing']);
  assert.match(findings[1].message, /heuristic only/i);
  assert.deepEqual(summarizeDeploymentChecks([
    { path: '/api/site', status: 200 }, { path: '/api/points', status: 200 },
    { path: '/api/contacts', status: 200 }, { path: '/api/visits', status: 200 },
  ]), []);
});


test('schema preflight covers current production-required migration surfaces', () => {
  const source = fs.readFileSync('scripts/check-schema.cjs', 'utf8');
  assert.match(source, /points: \['id', 'site_id', 'scene_id', 'phone_override'\]/);
  assert.match(source, /my_pin_capabilities: \['id', 'site_id', 'scene_id', 'point_id', 'token_hash', 'revoked_at'\]/);
  assert.match(source, /name: 'contact_is_base_visible', args: 'cid uuid, sid uuid', result: 'boolean'/);
  assert.match(source, /pg_get_function_identity_arguments/);
  assert.match(source, /pg_get_function_result/);
});
