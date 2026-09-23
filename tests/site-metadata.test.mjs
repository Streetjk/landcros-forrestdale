import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readPublicSiteMetadata } = require('../site-metadata.js');

function fixture(configText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitenav-site-meta-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  if (configText !== undefined) fs.writeFileSync(path.join(root, 'data', 'config.json'), configText);
  return root;
}

test('public site metadata is an exact allowlist', t => {
  const root = fixture(JSON.stringify({ site: {
    name: ' LANDCROS ', title: 'Site Navigator', address: '107 Allen Rd', logo: '/logo.png',
    mainPhone: ' 08 0000 0000 ', visitorInfo: 'Visitors report to reception.', buildingPhoto: '/building.webp',
    speedLimitSign: '/speed.png', privateNotes: 'never expose me', secret: 'nope',
  }, database: { password: 'never' } }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readPublicSiteMetadata(root, 'landcros'), {
    slug: 'landcros', name: 'LANDCROS', title: 'Site Navigator', address: '107 Allen Rd', logo: '/logo.png',
    mainPhone: '08 0000 0000', visitorInfo: 'Visitors report to reception.', buildingPhoto: '/building.webp',
  });
});

test('empty and wrong-type public fields are omitted without widening the contract', t => {
  const root = fixture(JSON.stringify({ site: {
    name: 'Valid', title: '', address: 107, logo: null,
    mainPhone: '   ', visitorInfo: ['no'], buildingPhoto: { url: '/no.jpg' }, unknown: 'hidden',
  } }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readPublicSiteMetadata(root, 'alpha'), { slug: 'alpha', name: 'Valid' });
});

test('missing and malformed configs safely fall back to slug only', t => {
  const missing = fixture(undefined);
  const malformed = fixture('{not json');
  const missingSite = fixture(JSON.stringify({ site: null, other: 'ignored' }));
  t.after(() => {
    for (const dir of [missing, malformed, missingSite]) fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(readPublicSiteMetadata(missing, 'missing'), { slug: 'missing' });
  assert.deepEqual(readPublicSiteMetadata(malformed, 'broken'), { slug: 'broken' });
  assert.deepEqual(readPublicSiteMetadata(missingSite, 'none'), { slug: 'none' });
});

test('server GET /api/site is wired to the allowlisted file helper, not the database', () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /require\(['"]\.\/site-metadata['"]\)/);
  const start = source.indexOf("if (req.method === 'GET' && pathname === '/api/site')");
  const end = source.indexOf("if (req.method === 'GET' && pathname === '/api/auth/me')", start);
  assert.ok(start >= 0 && end > start, 'expected bounded /api/site route');
  const route = source.slice(start, end);
  assert.match(route, /readPublicSiteMetadata\(SITE_DIR, SITE\)/);
  assert.doesNotMatch(route, /sdb\.|pool\(|getSiteId/);
});


async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntilReady(origin, child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
    try {
      const response = await fetch(`${origin}/api/site`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready');
}

test('GET /api/site serves the stable public metadata contract with short caching and browser hardening', async (t) => {
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), SITE: 'landcros', PUBLIC_BASE_URL: origin };
  delete env.SUPABASE_DB_URL;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });

  await waitUntilReady(origin, child);
  const response = await fetch(`${origin}/api/site`, { signal: AbortSignal.timeout(3000) });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60, stale-while-revalidate=300');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(body.slug, 'landcros');
  assert.equal(Object.hasOwn(body, 'secret'), false);
  assert.equal(Object.hasOwn(body, 'privateNotes'), false);
});
