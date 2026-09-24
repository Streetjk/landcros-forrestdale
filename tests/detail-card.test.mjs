import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDetailPhoneLink,
  createDetailContactCard,
  renderDetailContacts,
  createDetailSiteCard,
} from '../detail-card.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.href = '';
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
}
class FakeText { constructor(value) { this.textContent = String(value); } }
const fakeDocument = {
  createElement: tag => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  createTextNode: value => new FakeText(value),
};

test('shared detail phone link accepts only projected tel links and preserves touch target', () => {
  const link = createDetailPhoneLink(fakeDocument, {
    display: '+61 400 000 001', href: 'tel:+61400000001',
  }, {
    ariaLabel: 'Call main contact +61 400 000 001', touchTarget: true, icon: false,
  });
  assert.equal(link.tagName, 'A');
  assert.equal(link.href, 'tel:+61400000001');
  assert.equal(link.attributes.get('aria-label'), 'Call main contact +61 400 000 001');
  assert.equal(link.style.minHeight, '44px');
  assert.equal(link.children[0].textContent, '+61 400 000 001');
  assert.equal(createDetailPhoneLink(fakeDocument, { display: 'bad', href: 'https://example.test' }), null);
});

test('shared detail contact card writes contact text as text nodes', () => {
  const card = createDetailContactCard(fakeDocument, {
    name: '<img> Bob Builder', role: '<b>Supervisor</b>',
    phone: { display: '08 9000 0001', href: 'tel:0890000001' },
  });
  assert.equal(card.className, 'contact-card-3d');
  assert.equal(card.children[0].textContent, '<B');
  assert.equal(card.children[1].children[0].textContent, '<img> Bob Builder');
  assert.equal(card.children[1].children[1].textContent, '<b>Supervisor</b>');
  assert.equal(card.children[1].children[2].href, 'tel:0890000001');
});

test('shared detail contact renderer handles contacts, phone fallback and empty state', () => {
  const container = new FakeElement('div');
  let result = renderDetailContacts(fakeDocument, container, {
    contacts: [{ name: 'Alice Admin', role: 'Supervisor', phone: null }],
  });
  assert.deepEqual(result, { kind: 'contacts', count: 1 });
  assert.equal(container.children.length, 1);

  result = renderDetailContacts(fakeDocument, container, {
    contacts: [],
    fallbackPhone: { display: '08 9000 0002', href: 'tel:0890000002' },
    emptyText: 'None',
  });
  assert.deepEqual(result, { kind: 'phone', count: 1 });
  const phone = container.children[0].children[0].children[0];
  assert.equal(phone.href, 'tel:0890000002');

  result = renderDetailContacts(fakeDocument, container, {
    contacts: [], fallbackPhone: null, emptyText: 'No contacts assigned.',
  });
  assert.deepEqual(result, { kind: 'empty', count: 0 });
  assert.equal(container.children[0].textContent, 'No contacts assigned.');
});


test('shared site card renders projected metadata as text with neutral fallbacks', () => {
  const hostile = {
    name: '<img src=x onerror=alert(1)>', title: '<b>not markup</b>',
    slug: 'site /?&<script>', published: true, createdAt: 'not-a-date',
  };
  const card = createDetailSiteCard(fakeDocument, hostile);
  const [nameRow, title, slug, meta] = card.children[0].children;
  assert.equal(card.className, 'site-card');
  assert.equal(nameRow.children[0].textContent, hostile.name);
  assert.equal(nameRow.children[1].className, 'badge published');
  assert.equal(nameRow.children[1].textContent, 'Published');
  assert.equal(title.textContent, hostile.title);
  assert.equal(slug.textContent, hostile.slug);
  assert.equal(meta.textContent, 'Created date unavailable');

  const fallback = createDetailSiteCard(fakeDocument, { published: false });
  const [fallbackName, fallbackTitle, fallbackSlug, fallbackMeta] = fallback.children[0].children;
  assert.equal(fallbackName.children[0].textContent, 'Unnamed site');
  assert.equal(fallbackName.children[1].className, 'badge draft');
  assert.equal(fallbackTitle.textContent, 'No site title');
  assert.equal(fallbackSlug.textContent, 'Site slug unavailable');
  assert.equal(fallbackMeta.textContent, 'Created date unavailable');
});

test('public point and location detail paths consume the shared primitive', () => {
  const viewer = fs.readFileSync('viewer3d.js', 'utf8');
  const locations = fs.readFileSync('location-details.js', 'utf8');
  assert.match(viewer, /import \{ renderDetailContacts \} from '\.\/detail-card\.js'/);
  assert.match(viewer, /renderDetailContacts\(document, contactsEl, \{/);
  assert.match(locations, /import \{ createDetailPhoneLink \} from '\.\/detail-card\.js'/);
  assert.match(locations, /createDetailPhoneLink\(document, details\.phone, \{/);
  const selectPoint = viewer.match(/async function selectPoint\([\s\S]*?document\.getElementById\('point-list'\)/)?.[0] || '';
  assert.doesNotMatch(selectPoint, /contact-card-3d|contact-phone-3d/);
});
