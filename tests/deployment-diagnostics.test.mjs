import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyDbError, summarizeDeploymentChecks, evaluateRolloutReadiness } = require('../scripts/deployment-diagnostics.cjs');

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
  assert.match(source, /profiles: \['id', 'session_version'\]/);
  assert.match(source, /points: \['id', 'site_id', 'scene_id', 'phone_override'\]/);
  assert.match(source, /my_pin_capabilities: \['id', 'site_id', 'scene_id', 'point_id', 'token_hash', 'revoked_at'\]/);
  assert.match(source, /name: 'contact_is_base_visible', args: 'cid uuid, sid uuid', result: 'boolean'/);
  assert.match(source, /pg_get_function_identity_arguments/);
  assert.match(source, /pg_get_function_result/);
});

test('rollout preflight blocks Node deployment until 0019 then 0020 are applied', () => {
  const target = '91dc6e9837415fbeac7ac4790bf9da689efe27d9';
  const state = evaluateRolloutReadiness({
    targetSha: target,
    staticSha: target,
    nodeSha: '197d015370956409965de307eba93448a569d6c6',
    ciPassed: true,
    securityReviewPassed: true,
    databaseEnvironment: 'production',
    databaseProjectId: 'gxrtshgrnfzvkbkfjeug',
    migrationVerificationPassed: true,
    appliedMigrations: ['0013','0014','0016','0017','0018'],
    published: false,
  });
  assert.equal(state.codeQualified, true);
  assert.equal(state.migrationsReady, false);
  assert.equal(state.readyForNodeDeploy, false);
  assert.deepEqual(state.blockers, ['MIGRATION_0019_NOT_APPLIED','MIGRATION_0020_NOT_APPLIED']);
  assert.deepEqual(state.warnings, ['NODE_BACKEND_NOT_ON_TARGET']);
  assert.deepEqual(state.requiredOrder.slice(0, 3), ['0019','0020','node-backend-deploy']);
});

test('rollout preflight permits Node deploy only after both migrations and keeps publication separate', () => {
  const target = '91dc6e9837415fbeac7ac4790bf9da689efe27d9';
  const state = evaluateRolloutReadiness({
    targetSha: target,
    staticSha: target,
    nodeSha: '197d015370956409965de307eba93448a569d6c6',
    ciPassed: true,
    securityReviewPassed: true,
    databaseEnvironment: 'production',
    databaseProjectId: 'gxrtshgrnfzvkbkfjeug',
    migrationVerificationPassed: true,
    appliedMigrations: ['0013','0014','0016','0017','0018','0019','0020'],
    published: false,
  });
  assert.equal(state.readyForNodeDeploy, true);
  assert.deepEqual(state.blockers, []);
  assert.equal(state.requiredOrder.at(-1), 'publication-separate');
});

test('rollout preflight rejects wrong migration order and non-production verification', () => {
  const target = '91dc6e9837415fbeac7ac4790bf9da689efe27d9';
  const reversed = evaluateRolloutReadiness({
    targetSha: target,
    ciPassed: true,
    securityReviewPassed: true,
    databaseEnvironment: 'production',
    databaseProjectId: 'gxrtshgrnfzvkbkfjeug',
    migrationVerificationPassed: true,
    appliedMigrations: ['0020','0019'],
  });
  assert.equal(reversed.readyForNodeDeploy, false);
  assert.match(reversed.blockers.join(','), /MIGRATION_ORDER_INVALID/);

  const staging = evaluateRolloutReadiness({
    targetSha: target,
    ciPassed: true,
    securityReviewPassed: true,
    databaseEnvironment: 'staging',
    databaseProjectId: 'staging-project',
    migrationVerificationPassed: true,
    appliedMigrations: ['0019','0020'],
  });
  assert.equal(staging.readyForNodeDeploy, false);
  assert.match(staging.blockers.join(','), /DATABASE_NOT_PRODUCTION_VERIFIED/);
});

test('rollout preflight rejects non-string target SHA instead of coercing it', () => {
  const target = '91dc6e9837415fbeac7ac4790bf9da689efe27d9';
  const state = evaluateRolloutReadiness({
    targetSha: [target],
    ciPassed: true,
    securityReviewPassed: true,
    databaseEnvironment: 'production',
    databaseProjectId: 'gxrtshgrnfzvkbkfjeug',
    migrationVerificationPassed: true,
    appliedMigrations: ['0019','0020'],
  });
  assert.equal(state.readyForNodeDeploy, false);
  assert.match(state.blockers.join(','), /TARGET_SHA_INVALID/);
});
