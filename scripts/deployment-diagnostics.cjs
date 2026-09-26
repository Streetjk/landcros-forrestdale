'use strict';

function classifyDbError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  if (message === 'db_url_required') {
    return { category: 'configuration', message: 'SUPABASE_DB_URL is required; no connection attempted.' };
  }
  if (['28P01', '28000'].includes(code) || /password authentication failed|authentication failed|scram|sasl/.test(message)) {
    return { category: 'authentication', message: 'Database authentication failed; refresh the deployment SUPABASE_DB_URL credential.' };
  }
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return { category: 'dns', message: 'Database hostname resolution failed; verify the deployment connection host.' };
  }
  if (code.startsWith('ERR_TLS_') || ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code) || /certificate|tls|ssl/.test(message)) {
    return { category: 'tls', message: 'Database TLS validation failed; verify the supported provider connection string and TLS settings.' };
  }
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET'].includes(code) || /connection terminated unexpectedly|connection refused|connect etimedout|connection timed out/.test(message)) {
    return { category: 'connectivity', message: 'Database connection failed; verify provider reachability and the deployment connection string.' };
  }
  return { category: 'database', message: 'Database preflight failed; inspect authorized provider logs.' };
}

function summarizeDeploymentChecks(checks) {
  const byPath = new Map(checks.map(check => [check.path, check]));
  const findings = [];
  if (byPath.get('/api/site')?.status === 404) {
    findings.push({ category: 'stale-deployment', message: 'Deployment does not expose /api/site and is older than the current SiteNav metadata checkpoint.' });
  }
  const dbPaths = ['/api/points', '/api/contacts', '/api/visits'];
  const dbChecks = dbPaths.map(path => byPath.get(path)).filter(Boolean);
  if (dbChecks.length === dbPaths.length && dbChecks.every(check => check.status === 500)) {
    findings.push({ category: 'database-routes-failing', message: 'All public database-backed routes returned HTTP 500. This is a shared-failure heuristic only; confirm provider logs before changing DB credentials, schema, or queries.' });
  }
  return findings;
}

function evaluateRolloutReadiness(state) {
  const blockers = [];
  const warnings = [];
  const migrationList = Array.isArray(state?.appliedMigrations) ? state.appliedMigrations : [];
  const targetSha = typeof state?.targetSha === 'string' ? state.targetSha.trim() : '';
  const nodeSha = typeof state?.nodeSha === 'string' ? state.nodeSha.trim() : '';
  const staticSha = typeof state?.staticSha === 'string' ? state.staticSha.trim() : '';
  const targetValid = /^[0-9a-f]{40}$/.test(targetSha);
  const i19 = migrationList.indexOf('0019');
  const i20 = migrationList.indexOf('0020');

  if (!targetValid) blockers.push('TARGET_SHA_INVALID');
  if (state?.ciPassed !== true) blockers.push('CI_NOT_GREEN');
  if (state?.securityReviewPassed !== true) blockers.push('SECURITY_REVIEW_NOT_PASS');
  if (state?.databaseEnvironment !== 'production') blockers.push('DATABASE_NOT_PRODUCTION_VERIFIED');
  if (typeof state?.databaseProjectId !== 'string' || !state.databaseProjectId.trim()) blockers.push('DATABASE_PROJECT_ID_MISSING');
  if (state?.migrationVerificationPassed !== true) blockers.push('MIGRATION_VERIFICATION_NOT_PASS');
  if (i19 < 0) blockers.push('MIGRATION_0019_NOT_APPLIED');
  if (i20 < 0) blockers.push('MIGRATION_0020_NOT_APPLIED');
  if (i19 >= 0 && i20 >= 0 && i19 > i20) blockers.push('MIGRATION_ORDER_INVALID');

  if (state?.nodeSha != null && !/^[0-9a-f]{40}$/.test(nodeSha)) warnings.push('NODE_SHA_INVALID');
  else if (nodeSha && nodeSha !== targetSha) warnings.push('NODE_BACKEND_NOT_ON_TARGET');
  if (state?.staticSha != null && !/^[0-9a-f]{40}$/.test(staticSha)) warnings.push('STATIC_SHA_INVALID');
  else if (staticSha && staticSha !== targetSha) warnings.push('STATIC_FRONTEND_NOT_ON_TARGET');
  if (state?.published === true) warnings.push('PUBLICATION_ALREADY_ENABLED');

  const migrationsReady = i19 >= 0 && i20 >= 0 && i19 < i20
    && state?.databaseEnvironment === 'production'
    && typeof state?.databaseProjectId === 'string' && Boolean(state.databaseProjectId.trim())
    && state?.migrationVerificationPassed === true;
  const codeQualified = state?.ciPassed === true && state?.securityReviewPassed === true && targetValid;
  return {
    readyForNodeDeploy: codeQualified && migrationsReady,
    codeQualified,
    migrationsReady,
    blockers,
    warnings,
    normalized: {
      targetSha: targetValid ? targetSha : null,
      nodeSha: /^[0-9a-f]{40}$/.test(nodeSha) ? nodeSha : null,
      staticSha: /^[0-9a-f]{40}$/.test(staticSha) ? staticSha : null,
      databaseProjectId: typeof state?.databaseProjectId === 'string' ? state.databaseProjectId.trim() || null : null,
    },
    requiredOrder: ['0019', '0020', 'node-backend-deploy', 'production-verification', 'publication-separate'],
  };
}

module.exports = { classifyDbError, summarizeDeploymentChecks, evaluateRolloutReadiness };
