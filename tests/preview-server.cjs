// Test-only launcher: preserve product source, force loopback binding.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
if (fs.existsSync(path.join(__dirname, '../.env'))) throw new Error('Refusing fixture server in a checkout with .env');
for (const key of Object.keys(process.env)) {
  if (/^(SUPABASE_|SESSION_|PLATFORM_ADMIN_|SMTP_|RESEND_|GITHUB_PAT)/.test(key)) delete process.env[key];
}
process.env.NODE_ENV = 'test';
process.env.SITE = 'landcros';
process.env.PORT = process.env.PORT || '50128';
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function(port, host, callback) {
  return listen.call(this, port, '127.0.0.1', callback);
};
require('../server.js');