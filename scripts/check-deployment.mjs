// Read-only deployment smoke test. Never prints response data, contacts or tokens.
import { createHash } from 'node:crypto';
const target = new URL(process.argv[2] || 'https://landcros-forrestdale.onrender.com');
if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))) {
  throw new Error('Use HTTPS or loopback HTTP');
}
const specs = [
  ['/', 200, 'source'], ['/viewer3d.js', 200, 'source'],
  ['/api/points', 200, 'array'], ['/api/contacts', 200, 'array'],
  ['/api/auth/me', 401, 'anonymous-auth'],
];
const checks = [];
for (const [path, expectedStatus, kind] of specs) {
  const item = { path, expectedStatus };
  try {
    const response = await fetch(new URL(path, target), { redirect: 'error', signal: AbortSignal.timeout(15000), credentials: 'omit' });
    item.status = response.status;
    item.ok = response.status === expectedStatus;
    if (item.ok && kind === 'source') {
      item.sha256 = createHash('sha256').update(await response.text()).digest('hex');
    } else if (item.ok && kind === 'array') {
      const data = await response.json();
      item.ok = Array.isArray(data);
      item.records = item.ok ? data.length : null;
    } else {
      await response.body?.cancel();
    }
  } catch (error) {
    item.ok = false;
    item.errorType = error.name; // do not expose URLs, response bodies or credentials
  }
  checks.push(item);
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), origin: target.origin, checks }, null, 2));
process.exitCode = checks.every(check => check.ok) ? 0 : 1;
