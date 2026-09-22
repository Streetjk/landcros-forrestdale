import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fileUrl = new URL('../public-data.js', import.meta.url);
const code = await readFile(fileUrl, 'utf8');
const dataUri = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const { loadPublicArray, renderPublicDataNotice, isRenderablePoint, isRenderableContact } = await import(dataUri);

test('loadPublicArray - 200 array success', async () => {
  const payload = [{ id: 1, name: 'Main Lobby' }, { id: 2, name: 'North Exit' }];
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => payload
  });
  const result = await loadPublicArray('/api/locations', fakeFetch);
  assert.deepEqual(result, { data: payload, unavailable: false });
});

test('loadPublicArray - 500 error object response', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: 'Internal Server Error', code: 500 })
  });
  const result = await loadPublicArray('/api/locations', fakeFetch);
  assert.deepEqual(result, { data: [], unavailable: true });
});

test('loadPublicArray - 200 malformed non-array shape', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: 1 }] })
  });
  const result = await loadPublicArray('/api/locations', fakeFetch);
  assert.deepEqual(result, { data: [], unavailable: true });
});

test('loadPublicArray - thrown network error', async () => {
  const fakeFetch = async () => {
    throw new Error('Network failure');
  };
  const result = await loadPublicArray('/api/locations', fakeFetch);
  assert.deepEqual(result, { data: [], unavailable: true });
});

test('loadPublicArray - invalid JSON body', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    }
  });
  const result = await loadPublicArray('/api/locations', fakeFetch);
  assert.deepEqual(result, { data: [], unavailable: true });
});

test('loadPublicArray - legitimate empty array', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => []
  });
  const result = await loadPublicArray('/api/locations', fakeFetch);
  assert.deepEqual(result, { data: [], unavailable: false });
});

test('renderPublicDataNotice - DOM behaviors', () => {
  class FakeElement {
    constructor(tagName, ownerDocument) {
      this.tagName = tagName;
      this.ownerDocument = ownerDocument;
      this.attributes = new Map();
      this.children = [];
      this.className = '';
      this.textContent = '';
    }
    setAttribute(name, val) {
      this.attributes.set(name, String(val));
    }
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    }
    querySelector(selector) {
      if (selector === '[data-public-data-notice]') {
        return this.children.find(c => c.attributes.has('data-public-data-notice')) || null;
      }
      return null;
    }
    remove() {
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this);
        if (idx !== -1) {
          this.parentElement.children.splice(idx, 1);
        }
      }
    }
  }

  const fakeDoc = {
    createElement(tag) {
      return new FakeElement(tag, fakeDoc);
    }
  };

  const container = new FakeElement('div', fakeDoc);

  renderPublicDataNotice(null, true);

  renderPublicDataNotice(container, true);
  assert.equal(container.children.length, 1);
  const notice = container.children[0];
  assert.equal(notice.className, 'public-data-notice');
  assert.equal(notice.getAttribute('role'), 'status');
  assert.equal(notice.getAttribute('data-public-data-notice'), '');
  assert.equal(notice.textContent, 'Some shared locations or contacts are temporarily unavailable. The site map is still available.');

  renderPublicDataNotice(container, true);
  assert.equal(container.children.length, 1);

  renderPublicDataNotice(container, false);
  assert.equal(container.children.length, 0);
});

test('render validators filter malformed rows and preserve accepted objects unchanged', async () => {
  const validPoint = {
    id: 'point-1', label: 'Gate 1', type: 'drop-off',
    position3d: { x: 1, y: 2, z: 3 }, sceneId: 'scene-1', createdBy: 'profile-1', contactIds: ['contact-1']
  };
  const invalidPoints = [
    null, [], {},
    { ...validPoint, id: '   ' },
    { ...validPoint, label: '' },
    { ...validPoint, type: null },
    { ...validPoint, position3d: null },
    { ...validPoint, position3d: { x: 1, y: 2, z: Number.NaN } },
  ];
  const pointPayload = [validPoint, ...invalidPoints];
  const pointResult = await loadPublicArray('/points', async () => ({ ok: true, json: async () => pointPayload }), isRenderablePoint);
  assert.deepEqual(pointResult, { data: [validPoint], unavailable: true });
  assert.equal(pointResult.data[0], validPoint);
  assert.equal(pointResult.data[0].sceneId, 'scene-1');
  assert.equal(pointResult.data[0].createdBy, 'profile-1');
  assert.deepEqual(pointResult.data[0].contactIds, ['contact-1']);

  const validContact = { id: 'contact-1', name: 'Reception', phone: '0000', createdBy: 'profile-1' };
  const contactPayload = [validContact, null, [], {}, { id: '', name: 'Bad' }, { id: 'c2', name: '   ' }];
  const contactResult = await loadPublicArray('/contacts', async () => ({ ok: true, json: async () => contactPayload }), isRenderableContact);
  assert.deepEqual(contactResult, { data: [validContact], unavailable: true });
  assert.equal(contactResult.data[0], validContact);
  assert.equal(contactResult.data[0].createdBy, 'profile-1');
});

test('render validators accept the minimum required contracts', () => {
  assert.equal(isRenderablePoint({ id: 'p', label: 'Pin', type: '', position3d: { x: 0, y: -1, z: 2.5 } }), true);
  assert.equal(isRenderableContact({ id: 'c', name: 'Contact' }), true);
});

test('viewer wires render validators into public arrays and scene pin merge', async () => {
  const viewer = await readFile(new URL('../viewer3d.js', import.meta.url), 'utf8');
  assert.match(viewer, /loadPublicArray\('\.\/data\/points\.json', globalThis\.fetch, isRenderablePoint\)/);
  assert.match(viewer, /loadPublicArray\('\.\/data\/contacts\.json', globalThis\.fetch, isRenderableContact\)/);
  assert.match(viewer, /rawScenePins\.filter\(isRenderablePoint\)/);
  assert.match(viewer, /rawSceneContacts\.filter\(isRenderableContact\)/);
  assert.match(viewer, /sceneDataUnavailable/);
  assert.match(viewer, /_publicMyPinMode[\s\S]*?scenePins\.find\(p => p\.id === _deepId\)/);
  assert.doesNotMatch(viewer, /_sceneBundle\?\.pins\?\.find\(p => p\.id === _deepId\)/);
});
