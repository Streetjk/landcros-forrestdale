// Read-only deployment smoke test. Never prints response data, contacts or tokens.
import { createHash } from 'node:crypto';
import diagnostics from './deployment-diagnostics.cjs';
const { summarizeDeploymentChecks } = diagnostics;
const target = new URL(process.argv[2] || 'https://landcros-forrestdale.onrender.com');
if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))) {
  throw new Error('Use HTTPS or loopback HTTP');
}
const specs = [
  ['/', 200, 'source'], ['/viewer3d.js', 200, 'source'],
  ['/api/site', 200, 'site'],
  ['/api/points', 200, 'array'], ['/api/contacts', 200, 'array'],
  ['/api/visits', 200, 'visits'],
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
    } else if (item.ok && kind === 'site') {
      const data = await response.json();
      item.ok = Boolean(data) && typeof data === 'object' && !Array.isArray(data) && typeof data.slug === 'string' && data.slug.length > 0;
    } else if (item.ok && kind === 'visits') {
      const data = await response.json();
      item.ok = Boolean(data) && typeof data === 'object' && !Array.isArray(data)
        && Number.isFinite(data.total) && data.total >= 0
        && Boolean(data.points) && typeof data.points === 'object' && !Array.isArray(data.points);
    } else {
      await response.body?.cancel();
    }
  } catch (error) {
    item.ok = false;
    item.errorType = error.name; // do not expose URLs, response bodies or credentials
  }
  checks.push(item);
}
const findings = summarizeDeploymentChecks(checks);
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), origin: target.origin, checks, findings }, null, 2));
process.exitCode = checks.every(check => check.ok) ? 0 : 1;
