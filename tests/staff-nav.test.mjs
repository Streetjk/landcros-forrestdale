import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nav = require('../staff-nav.js');
const source = fs.readFileSync(new URL('../staff-nav.js', import.meta.url), 'utf8');

function read(name) {
  return fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
}

test('staff nav exposes only same-origin existing staff destinations', () => {
  assert.deepEqual(nav.buildItems({}), [
    { id: 'map', label: 'Map', href: '/index.html' },
    { id: 'pins', label: 'My Pins', href: '/admin3d.html' },
    { id: 'more', label: 'More', href: '/portal.html' },
  ]);
  assert.deepEqual(nav.buildItems({ siteSlug: 'landcros' }), [
    { id: 'map', label: 'Map', href: '/index.html' },
    { id: 'pins', label: 'My Pins', href: '/admin3d.html' },
    { id: 'reports', label: 'Reports', href: '/editor.html?site=landcros&mode=hazard' },
    { id: 'more', label: 'More', href: '/portal.html' },
  ]);
  assert.deepEqual(
    nav.buildItems({ siteSlug: 'landcros' }).map((item) => item.label),
    ['Map', 'My Pins', 'Reports', 'More'],
  );
  assert.equal(nav.buildItems({ siteSlug: 'landcros' }).some((item) => item.id === 'editor'), false);
  for (const item of nav.buildItems({ siteSlug: 'landcros' })) assert.match(item.href, /^\//);
});

test('site-scoped reports link is omitted and safe destinations preserved for invalid or hostile site slugs', () => {
  for (const slug of ['', ' ../x ', 'https://evil.invalid', 'landcros?next=https://evil.invalid', 'A']) {
    const items = nav.buildItems({ siteSlug: slug });
    assert.deepEqual(items, [
      { id: 'map', label: 'Map', href: '/index.html' },
      { id: 'pins', label: 'My Pins', href: '/admin3d.html' },
      { id: 'more', label: 'More', href: '/portal.html' },
    ], slug);
    const ids = items.map((item) => item.id);
    assert.equal(ids.includes('editor'), false, slug);
    assert.equal(ids.includes('reports'), false, slug);
  }
  assert.equal(nav.normalizeSiteSlug(' LANDCROS '), 'landcros');
});

test('staff nav is local, accessible and mobile-touch-safe by contract', () => {
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|\/api\//);
  assert.match(source, /aria-label", "Staff navigation"/);
  assert.match(source, /aria-current", "page"/);
  assert.match(source, /min-height:44px/);
  assert.match(source, /min-width:44px/);
  assert.match(source, /flex:1 1 0/);
  assert.match(source, /env\(safe-area-inset-bottom\)/);
  assert.match(source, /var\(--sn-landcros-orange,#e6500a\)/);
  assert.doesNotMatch(source, /innerHTML\s*=/);
});


test('mount marks exactly the requested staff destination current', () => {
  function makeElement(tag) {
    const attrs = new Map();
    return {
      tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, firstChild: null,
      setAttribute(name, value) { attrs.set(name, value); },
      getAttribute(name) { return attrs.get(name) ?? null; },
      appendChild(child) { this.children.push(child); this.firstChild = this.children[0] || null; return child; },
      removeChild(child) { this.children = this.children.filter((x) => x !== child); this.firstChild = this.children[0] || null; },
    };
  }
  const body = makeElement('body');
  const doc = {
    body,
    createElement: makeElement,
    getElementById(id) { return body.children.find((el) => el.id === id) || null; },
  };
  let mounted = nav.mount({ currentPage: 'reports', siteSlug: 'landcros', document: doc });
  assert.equal(mounted.children.filter((el) => el.getAttribute('aria-current') === 'page').length, 1);
  assert.equal(mounted.children.find((el) => el.getAttribute('aria-current') === 'page').dataset.staffNav, 'reports');

  mounted = nav.mount({ currentPage: 'more', siteSlug: 'landcros', document: doc });
  assert.equal(mounted.children.filter((el) => el.getAttribute('aria-current') === 'page').length, 1);
  assert.equal(mounted.children.find((el) => el.getAttribute('aria-current') === 'page').dataset.staffNav, 'more');

  mounted = nav.mount({ currentPage: 'more', document: doc });
  assert.equal(mounted.children.filter((el) => el.getAttribute('aria-current') === 'page').length, 1);
  assert.equal(mounted.children.find((el) => el.getAttribute('aria-current') === 'page').dataset.staffNav, 'more');

  mounted = nav.mount({ currentPage: 'editor', siteSlug: 'landcros', document: doc });
  assert.equal(mounted.children.filter((el) => el.getAttribute('aria-current') === 'page').length, 0);
});

test('My Pins nav gains Reports only after a validated site slug is available', () => {
  function makeElement(tag) {
    const attrs = new Map();
    return {
      tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, firstChild: null,
      setAttribute(name, value) { attrs.set(name, value); },
      getAttribute(name) { return attrs.get(name) ?? null; },
      appendChild(child) { this.children.push(child); this.firstChild = this.children[0] || null; return child; },
      removeChild(child) { this.children = this.children.filter((x) => x !== child); this.firstChild = this.children[0] || null; },
    };
  }
  const body = makeElement('body');
  const doc = {
    body,
    createElement: makeElement,
    getElementById(id) { return body.children.find((el) => el.id === id) || null; },
  };

  let mounted = nav.mount({ currentPage: 'pins', document: doc });
  assert.deepEqual(mounted.children.map((el) => el.dataset.staffNav), ['map', 'pins', 'more']);

  mounted = nav.mount({ currentPage: 'pins', siteSlug: 'landcros', document: doc });
  assert.deepEqual(mounted.children.map((el) => el.dataset.staffNav), ['map', 'pins', 'reports', 'more']);
  assert.equal(mounted.children.find((el) => el.dataset.staffNav === 'pins').getAttribute('aria-current'), 'page');
});

test('staff pages load and mount the shared nav only in authenticated entry paths', () => {
  const index = read('index.html');
  const admin = read('admin3d.html');
  const adminModule = read('admin3d.js');
  const editor = read('editor.html');
  const portal = read('portal.html');
  for (const html of [index, admin, editor, portal]) assert.match(html, /<script src="staff-nav\.js"><\/script>/);
  assert.match(index, /<script src="staff-map-shell\.js"><\/script>/);
  assert.match(index, /SiteNavStaffMapShell\?\.mountAuthenticatedMapNav\?\.\(\);/);
  assert.match(index, /body\[data-staff-nav-mounted="true"\][\s\S]*--sn-map-staff-nav-lift[\s\S]*#side-panel[\s\S]*#cam-presets[\s\S]*#nav-progress/);
  assert.match(admin, /SiteNavStaffNav\.mount\(\{ currentPage: 'pins' \}\);/);
  assert.match(editor, /if \(info && info\.email\) \{\s*const navParams = new URLSearchParams\(location\.search\);\s*SiteNavStaffNav\.mount\(\{\s*currentPage: navParams\.get\('mode'\) === 'hazard' \? 'reports' : 'more',\s*siteSlug: navParams\.get\('site'\),\s*\}\);\s*\}/s);
  assert.match(portal, /SiteNavStaffNav\.mount\(\{ currentPage: 'more' \}\);/);
  assert.ok(admin.indexOf("SiteNavStaffNav.mount({ currentPage: 'pins' })") > admin.indexOf('function showAuthBar(info)'));
  assert.match(adminModule, /if \(epoch !== _initEpoch \|\| window\._snAdminIdentity\?\.email !== email\) return;[\s\S]*_slug = site\.slug;[\s\S]*SiteNavStaffNav\?\.mount\?\.\(\{ currentPage: 'pins', siteSlug: _slug \}\);/);
  assert.match(adminModule, /sitenav:auth-cleared'[\s\S]*SiteNavStaffNav\?\.mount\?\.\(\{ currentPage: 'pins' \}\);/);
  assert.ok(editor.indexOf("currentPage: navParams.get('mode') === 'hazard' ? 'reports' : 'more'") > editor.indexOf('function showAuthBar(info)'));
  assert.ok(portal.indexOf("SiteNavStaffNav.mount({ currentPage: 'more' })") > portal.indexOf('async function checkPlatformAdminAndEnter(email)'));
});

test('unmount removes only the shared staff nav and is idempotent', () => {
  const other = { id: 'keep-me' };
  const staff = { id: 'sn-staff-nav', parentNode: null };
  const body = {
    children: [other, staff],
    removeChild(child) {
      this.children = this.children.filter(item => item !== child);
      child.parentNode = null;
    },
  };
  staff.parentNode = body;
  const doc = { getElementById(id) { return body.children.find(el => el.id === id) || null; } };
  assert.equal(nav.unmount({ document: doc }), true);
  assert.deepEqual(body.children, [other]);
  assert.equal(nav.unmount({ document: doc }), false);
});
