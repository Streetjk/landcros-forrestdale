// Test-only actual server bootstrap. Never load deployment credentials or .env.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
if (fs.existsSync(path.join(__dirname, '../../.env'))) throw new Error('Test requires a clean checkout without .env');
const url = new URL(process.env.SITENAV_TEST_DATABASE_URL || 'about:blank');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/sitenav_test' || url.username !== 'sitenav_test') throw new Error('Refusing non-fixture database');
for (const key of Object.keys(process.env)) {
  if (/^(SUPABASE_|SESSION_|PLATFORM_ADMIN_|SMTP_|RESEND_|GITHUB_PAT)/.test(key)) delete process.env[key];
}
process.env.SUPABASE_DB_URL = url.href;
process.env.SESSION_SECRET = process.env.SITENAV_TEST_SESSION_KEY;
process.env.PLATFORM_ADMIN_EMAILS = 'platform@example.test';
process.env.NODE_ENV = 'test';
process.env.SITE = 'alpha';
process.env.PORT = '0';
// Prevent unrelated background delivery while exercising real HTTP + SQL.
require('../../webhook-delivery').runDeliveryTick = async () => {};
const mailer = require('../../mailer');
for (const key of Object.keys(mailer)) if (typeof mailer[key] === 'function') mailer[key] = async () => { throw new Error('External mail disabled in fixture'); };
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function(_port, _host, callback) {
  return listen.call(this, 0, '127.0.0.1', () => {
    callback?.();
    process.send?.({ port: this.address().port });
  });
};
require('../../server');
