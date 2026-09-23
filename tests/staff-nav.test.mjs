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
    { id: 'editor', label: 'Editor', href: '/editor.html?site=landcros' },
    { id: 'reports', label: 'Reports', href: '/editor.html?site=landcros&mode=hazard' },
    { id: 'more', label: 'More', href: '/portal.html' },
  ]);
  for (const item of nav.buildItems({ siteSlug: 'landcros' })) assert.match(item.href, /^\//);
});

test('site-scoped editor and reports links are omitted for invalid or hostile site slugs', () => {
  for (const slug of ['', ' ../x ', 'https://evil.invalid', 'landcros?next=https://evil.invalid', 'A']) {
    const ids = nav.buildItems({ siteSlug: slug }).map((item) => item.id);
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
  mounted = nav.mount({ currentPage: 'editor', siteSlug: 'landcros', document: doc });
  assert.equal(mounted.children.filter((el) => el.getAttribute('aria-current') === 'page').length, 1);
  assert.equal(mounted.children.find((el) => el.getAttribute('aria-current') === 'page').dataset.staffNav, 'editor');
});

test('staff pages load and mount the shared nav only in authenticated entry paths', () => {
  const admin = read('admin3d.html');
  const editor = read('editor.html');
  const portal = read('portal.html');
  for (const html of [admin, editor, portal]) assert.match(html, /<script src="staff-nav\.js"><\/script>/);
  assert.match(admin, /SiteNavStaffNav\.mount\(\{ currentPage: 'pins' \}\);/);
  assert.match(editor, /if \(info && info\.email\) \{\s*const navParams = new URLSearchParams\(location\.search\);\s*SiteNavStaffNav\.mount\(\{\s*currentPage: navParams\.get\('mode'\) === 'hazard' \? 'reports' : 'editor',\s*siteSlug: navParams\.get\('site'\),\s*\}\);\s*\}/s);
  assert.match(portal, /SiteNavStaffNav\.mount\(\{ currentPage: 'more' \}\);/);
  assert.ok(admin.indexOf("SiteNavStaffNav.mount({ currentPage: 'pins' })") > admin.indexOf('function showAuthBar(info)'));
  assert.ok(editor.indexOf("currentPage: navParams.get('mode') === 'hazard' ? 'reports' : 'editor'") > editor.indexOf('function showAuthBar(info)'));
  assert.ok(portal.indexOf("SiteNavStaffNav.mount({ currentPage: 'more' })") > portal.indexOf('async function checkPlatformAdminAndEnter(email)'));
});
