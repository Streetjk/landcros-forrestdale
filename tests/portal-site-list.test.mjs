import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDetailSiteCard } from '../detail-card.js';

const portal = fs.readFileSync(new URL('../portal.html', import.meta.url), 'utf8');
const siteAdmin = fs.readFileSync(new URL('../site-admin.js', import.meta.url), 'utf8');

function functionBlock(name, nextName) {
  const start = portal.indexOf(`  function ${name}`);
  const end = portal.indexOf(`\n  ${nextName}`, start);
  assert.notEqual(start, -1, `${name} not found`);
  assert.notEqual(end, -1, `${nextName} boundary not found`);
  return portal.slice(start, end);
}

test('platform site list is projected before leaving site-admin', () => {
  assert.match(siteAdmin, /const \{ staffSite \} = require\('\.\/data-projections'\);/);
  assert.match(siteAdmin, /select id, slug, name, title, published, created_at from sites order by created_at/);
  assert.match(siteAdmin, /return rows\.map\(staffSite\);/);
});

test('portal renders projected site metadata through the shared read-only card primitive', () => {
  const render = functionBlock('renderSites(sites)', 'async function refreshSites');
  assert.match(portal, /<script type="module">\s*import \{ createDetailSiteCard \} from '\.\/detail-card\.js';/);
  assert.ok(portal.indexOf('<script src="auth-gate.js"></script>') < portal.indexOf('<script type="module">'));
  assert.ok(portal.indexOf('<script src="staff-nav.js"></script>') < portal.indexOf('<script type="module">'));
  assert.match(render, /sites\.filter\(site => site && typeof site === 'object' && !Array\.isArray\(site\)\)/);
  assert.match(render, /list\.replaceChildren\(\)/);
  assert.doesNotMatch(render, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(render, /const card = createDetailSiteCard\(document, site\);/);
  assert.match(render, /toggle\.textContent = site\.published \? 'Unpublish' : 'Publish'/);
  assert.match(render, /openLink\.href = `\/editor\.html\?site=\$\{encodeURIComponent\(slug\)\}`/);
  assert.match(render, /fetch\(`\/api\/sites\/\$\{encodeURIComponent\(slug\)\}\/publish`/);
});

test('portal gives missing metadata neutral fallbacks and mobile touch-safe actions', () => {
  const detail = fs.readFileSync(new URL('../detail-card.js', import.meta.url), 'utf8');
  assert.match(detail, /'Unnamed site'/);
  assert.match(detail, /'No site title'/);
  assert.match(detail, /'Created date unavailable'/);
  assert.match(portal, /\.btn-sm \{[\s\S]*?min-height: 44px; min-width: 44px;/);
  assert.match(portal, /\.open-link \{ min-height: 44px; display: inline-flex;/);
  assert.match(portal, /@media \(max-width: 620px\)[\s\S]*?\.site-card \{ align-items: stretch; flex-direction: column; \}/);
});

test('hostile site fields are never interpolated into card HTML', () => {
  const render = functionBlock('renderSites(sites)', 'async function refreshSites');
  for (const field of ['site.name', 'site.title', 'site.slug']) {
    assert.doesNotMatch(render, new RegExp(`innerHTML[^\\n]*${field.replace('.', '\\.')}`));
  }
  assert.match(render, /textContent/);
});


class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.href = '';
    this.type = '';
    this.onclick = null;
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = [...children]; }
}

function runtimePortal() {
  const list = new FakeElement('div');
  const empty = new FakeElement('p');
  const byId = new Map([['sites-list', list], ['empty-msg', empty]]);
  const calls = [];
  const context = {
    createDetailSiteCard,
    document: {
      getElementById(id) { return byId.get(id) || null; },
      createElement(tag) { return new FakeElement(tag); },
    },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return { ok: true, async json() { return []; } };
    },
  };
  const start = portal.indexOf('  function renderSites(sites)');
  const end = portal.indexOf("  document.getElementById('new-site-form').onsubmit", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  vm.runInNewContext(`${portal.slice(start, end)}\nthis.renderSites = renderSites;`, context);
  return { ...context, list, empty, calls };
}

test('portal runtime skips malformed rows and treats hostile projected values as text', async () => {
  const runtime = runtimePortal();
  const hostile = {
    slug: 'site /?&<script>',
    name: '<img src=x onerror=alert(1)>',
    title: '<b>not markup</b>',
    published: true,
    createdAt: 'not-a-date',
  };
  runtime.renderSites([null, 7, 'bad', [], hostile]);

  assert.equal(runtime.list.children.length, 1);
  assert.equal(runtime.empty.style.display, 'none');
  const [info, actions] = runtime.list.children[0].children;
  const [nameRow, title, slug, meta] = info.children;
  assert.equal(nameRow.children[0].textContent, hostile.name);
  assert.equal(nameRow.children[1].textContent, 'Published');
  assert.equal(title.textContent, hostile.title);
  assert.equal(slug.textContent, hostile.slug);
  assert.equal(meta.textContent, 'Created date unavailable');

  const [openLink, toggle] = actions.children;
  assert.equal(openLink.href, '/editor.html?site=site%20%2F%3F%26%3Cscript%3E');
  assert.equal(openLink.textContent, 'Open editor →');
  assert.equal(toggle.textContent, 'Unpublish');
  await toggle.onclick();
  assert.equal(runtime.calls[0].url, '/api/sites/site%20%2F%3F%26%3Cscript%3E/publish');
  assert.equal(runtime.calls[0].options.body, JSON.stringify({ published: false }));
  assert.equal(runtime.calls[1].url, '/api/sites');
});

test('portal runtime shows empty state for malformed-only or non-array responses', () => {
  for (const value of [[null, [], 2], null, {}, 'bad']) {
    const runtime = runtimePortal();
    runtime.renderSites(value);
    assert.equal(runtime.list.children.length, 0);
    assert.equal(runtime.empty.style.display, '');
  }
});
