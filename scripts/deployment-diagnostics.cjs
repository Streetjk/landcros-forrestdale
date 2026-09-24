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

module.exports = { classifyDbError, summarizeDeploymentChecks };
