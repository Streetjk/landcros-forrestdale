const crypto = require('crypto');

function createRequestId() {
  return crypto.randomUUID();
}

function safeToken(value, fallback, maxLength = 64) {
  if (typeof value !== 'string' || !value) return fallback;
  const token = value.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, maxLength);
  return token || fallback;
}

function classifyError(error) {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  if (code === '28P01') return 'database-authentication';
  if (code.startsWith('42')) return 'database-schema';
  if (code.startsWith('08') || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(code)) {
    return 'database-connection';
  }
  return 'database-query';
}

function writePublicDataUnavailable(res, { requestId, route, site, error, logger = console }) {
  const id = safeToken(requestId, 'unavailable', 64);
  const diagnostic = {
    route: safeToken(route, 'public-data', 48),
    site: safeToken(site, 'unknown', 64),
    requestId: id,
    errorKind: classifyError(error),
  };

  logger.error('[public-data]', JSON.stringify(diagnostic));
  res.writeHead(500, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'X-Request-Id': id,
  });
  res.end(JSON.stringify({ error: 'PUBLIC_DATA_UNAVAILABLE', requestId: id }));
}

module.exports = {
  createRequestId,
  writePublicDataUnavailable,
};
