import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const STATIC_ORIGIN = 'https://static.example.test';
const runtime = JSON.parse(fs.readFileSync('sites/landcros/data/public-runtime.json', 'utf8'));
const start = fs.readFileSync('start.html', 'utf8');

function absolute(path, origin) {
  return new URL(path, origin).href;
}

test('dual-origin contract fixture keeps public and staff/auth authorities distinct', () => {
  assert.match(runtime.apiOrigin, /^https:\/\//);
  assert.notEqual(new URL(runtime.apiOrigin).origin, STATIC_ORIGIN);
  assert.equal(new URL('/api/auth/me', runtime.apiOrigin).origin, new URL(runtime.apiOrigin).origin);
  assert.equal(absolute('/api/auth/me', STATIC_ORIGIN), `${STATIC_ORIGIN}/api/auth/me`);
});

test('start chooser derives staff links from validated runtime apiOrigin', () => {
  assert.match(start, /fetch\('\.\/data\/public-runtime\.json', \{ cache: 'no-store' \}\)/);
  assert.match(start, /url\.protocol !== 'https:'/);
  assert.match(start, /url\.username \|\| url\.password \|\| url\.search \|\| url\.hash/);
  assert.match(start, /const staffOrigin = runtime\?\.apiOrigin \|\| location\.origin/);
  assert.match(start, /link-admin'\)\.href = _staffHref\(staffOrigin, '\/editor\.html', slug\)/);
  assert.match(start, /link-hazard'\)\.href = _staffHref\(staffOrigin, '\/editor\.html', slug, \{ mode: 'hazard' \}\)/);
  assert.match(start, /link-pin-admin'\)\.href = _staffHref\(staffOrigin, '\/admin3d\.html', slug\)/);
  assert.match(start, /link-platform'\)\.href = _staffHref\(staffOrigin, '\/portal\.html', slug\)/);

  const admin = new URL('/editor.html', runtime.apiOrigin);
  admin.searchParams.set('site', runtime.siteSlug);
  assert.equal(admin.origin, new URL(runtime.apiOrigin).origin);
  assert.equal(admin.searchParams.get('site'), runtime.siteSlug);
});

test('executable chooser preserves backend-valid trailing-hyphen slug on the Node origin', async () => {
  const match = start.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'start.html inline router script must exist');
  const anchors = new Map([
    ['link-admin', { href: 'editor.html?site=landcros' }],
    ['link-hazard', { href: 'editor.html?site=landcros&mode=hazard' }],
    ['link-pin-admin', { href: 'admin3d.html' }],
    ['link-platform', { href: 'portal.html' }],
  ]);
  const context = {
    URL,
    URLSearchParams,
    location: {
      href: `${STATIC_ORIGIN}/start.html?site=alpha-`,
      origin: STATIC_ORIGIN,
      search: '?site=alpha-',
    },
    document: { getElementById: id => anchors.get(id) || null },
    fetch: async input => {
      assert.equal(input, './data/public-runtime.json');
      return { ok: true, json: async () => runtime };
    },
  };
  await vm.runInNewContext(match[1], context);
  const staffOrigin = new URL(runtime.apiOrigin).origin;
  assert.equal(new URL(anchors.get('link-admin').href).origin, staffOrigin);
  assert.equal(new URL(anchors.get('link-admin').href).searchParams.get('site'), 'alpha-');
  assert.equal(new URL(anchors.get('link-hazard').href).searchParams.get('site'), 'alpha-');
  assert.equal(new URL(anchors.get('link-hazard').href).searchParams.get('mode'), 'hazard');
});
