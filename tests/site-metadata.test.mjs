import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  assert.match(source, /pathname === ['"]\/api\/site['"][\s\S]{0,240}readPublicSiteMetadata\(SITE_DIR, SITE\)/);
  assert.doesNotMatch(source.match(/pathname === ['"]\/api\/site['"][\s\S]{0,300}/)?.[0] || '', /sdb\.|pool\(|getSiteId/);
});
