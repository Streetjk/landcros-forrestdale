import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fileUrl = new URL('../public-data.js', import.meta.url);
const code = await readFile(fileUrl, 'utf8');
const dataUri = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const {
  loadPublicArray, renderPublicDataNotice, isRenderablePoint, isRenderableContact,
  projectPublicPoint, projectPublicContact,
} = await import(dataUri);

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

test('public base projectors strip private/unknown fields and clone structured values', async () => {
  const validPoint = {
    id: 'point-1', label: 'Gate 1', type: 'drop-off', scope: 'shared',
    latlng: [-32.1, 115.9], position3d: { x: 1, y: 2, z: 3 }, notes: 'Use gate',
    contactIds: ['contact-1'], routeWaypoints: [[1, 2]], routeWaypoints3d: [{ x: 1, y: 2, z: 3 }],
    cameraPreset3d: { position: { x: 4, y: 5, z: 6 } }, buildingRef: 'B1',
    sceneId: 'scene-private', createdBy: 'profile-private', secret: 'never',
  };
  const projectedPoint = projectPublicPoint(validPoint);
  assert.deepEqual(Object.keys(projectedPoint).sort(), [
    'buildingRef', 'cameraPreset3d', 'contactIds', 'id', 'label', 'latlng', 'notes',
    'position3d', 'routeWaypoints', 'routeWaypoints3d', 'scope', 'type',
  ]);
  assert.equal('sceneId' in projectedPoint, false);
  assert.equal('createdBy' in projectedPoint, false);
  assert.equal('secret' in projectedPoint, false);
  assert.deepEqual(projectedPoint.position3d, validPoint.position3d);
  assert.notEqual(projectedPoint.position3d, validPoint.position3d);
  assert.deepEqual(projectedPoint.contactIds, validPoint.contactIds);
  assert.notEqual(projectedPoint.contactIds, validPoint.contactIds);

  const validContact = {
    id: 'contact-1', name: 'Reception', role: 'Reception', phone: '0000', active: true,
    email: 'private@example.invalid', createdBy: 'profile-private', createdAt: 'never', secret: 'never',
  };
  const projectedContact = projectPublicContact(validContact);
  assert.deepEqual(Object.keys(projectedContact).sort(), ['active', 'id', 'name', 'phone', 'role']);
  assert.equal('email' in projectedContact, false);
  assert.equal('createdBy' in projectedContact, false);
  assert.equal('createdAt' in projectedContact, false);
  assert.equal('secret' in projectedContact, false);

  const pointPayload = [validPoint, null, { ...validPoint, id: '   ' }];
  const pointResult = await loadPublicArray('/api/points', async () => ({ ok: true, json: async () => pointPayload }), isRenderablePoint, projectPublicPoint);
  assert.equal(pointResult.unavailable, true);
  assert.deepEqual(pointResult.data, [projectedPoint]);

  const contactPayload = [validContact, [], { id: 'c2', name: '   ' }];
  const contactResult = await loadPublicArray('/api/contacts', async () => ({ ok: true, json: async () => contactPayload }), isRenderableContact, projectPublicContact);
  assert.equal(contactResult.unavailable, true);
  assert.deepEqual(contactResult.data, [projectedContact]);
});

test('render validators accept the minimum required contracts', () => {
  assert.equal(isRenderablePoint({ id: 'p', label: 'Pin', type: '', position3d: { x: 0, y: -1, z: 2.5 } }), true);
  assert.equal(isRenderableContact({ id: 'c', name: 'Contact' }), true);
});

test('viewer wires Supabase-first public transport into public arrays and scene pin merge', async () => {
  const viewer = await readFile(new URL('../viewer3d.js', import.meta.url), 'utf8');
  assert.match(viewer, /loadPublicTransport\(_runtime, globalThis\.fetch\)/);
  assert.match(viewer, /const pointResult = _publicTransport\.pointResult;/);
  assert.match(viewer, /const contactResult = _publicTransport\.contactResult;/);
  assert.doesNotMatch(viewer, /loadPublicArray\('\.\/data\/(points|contacts)\.json/);
  assert.doesNotMatch(viewer, /fetch\('\.\/data\/contacts\.json/);
  assert.match(viewer, /rawScenePins\.filter\(isRenderablePoint\)/);
  assert.match(viewer, /rawSceneContacts\.filter\(isRenderableContact\)/);
  assert.match(viewer, /sceneDataUnavailable/);
  assert.match(viewer, /_publicMyPinMode[\s\S]*?scenePins\.find\(p => p\.id === _deepId\)/);
  assert.doesNotMatch(viewer, /_sceneBundle\?\.pins\?\.find\(p => p\.id === _deepId\)/);
});

test('renderPublicDataNotice accepts a generic scoped-guide message without duplicating notices', () => {
  class FakeElement {
    constructor(tagName, ownerDocument) {
      this.tagName = tagName;
      this.ownerDocument = ownerDocument;
      this.attributes = new Map();
      this.children = [];
      this.className = '';
      this.textContent = '';
    }
    setAttribute(name, val) { this.attributes.set(name, String(val)); }
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
    querySelector(selector) {
      if (selector === '[data-public-data-notice]') {
        return this.children.find(c => c.attributes.has('data-public-data-notice')) || null;
      }
      return null;
    }
    remove() {
      if (!this.parentElement) return;
      const i = this.parentElement.children.indexOf(this);
      if (i !== -1) this.parentElement.children.splice(i, 1);
    }
  }
  const fakeDoc = { createElement: tag => new FakeElement(tag, fakeDoc) };
  const container = new FakeElement('div', fakeDoc);
  const message = 'This shared guide is temporarily unavailable. The site map is still available.';

  renderPublicDataNotice(container, true, message);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].textContent, message);

  renderPublicDataNotice(container, true, message);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].textContent, message);
});
