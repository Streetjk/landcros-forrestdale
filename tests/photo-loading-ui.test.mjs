import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../photo-zoom.js', import.meta.url), 'utf8');
const { createPhotoZoom } = await import('data:text/javascript;base64,' +
  Buffer.from(source).toString('base64'));

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.listeners = new Map();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attrs = new Map();
    this.classes = new Set();
    this.complete = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.clientWidth = 300;
    this.clientHeight = 200;
    this.classList = {
      add: (...names) => names.forEach(n => this.classes.add(n)),
      toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
    };
  }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  getAttribute(key) { return this.attrs.get(key) || null; }
  removeAttribute(key) { this.attrs.delete(key); }
  get src() { return this.getAttribute('src') || ''; }
  set src(value) {
    this.setAttribute('src',value);
    this.complete = false;
    this.naturalWidth = 0;
  }
  getBoundingClientRect() { return { left:0, top:0, width:300, height:200 }; }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name,new Set());
    this.listeners.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  dispatch(name, props={}) {
    if (name === 'load') {
      this.complete = true;
      this.naturalWidth = 600;
      this.naturalHeight = 400;
    }
    if (name === 'error') {
      this.complete = true;
      this.naturalWidth = 0;
    }
    const e={
      pointerType:'mouse',pointerId:1,button:0,clientX:150,clientY:100,
      deltaY:0,deltaMode:0,...props,
      preventDefault(){},stopPropagation(){},
    };
    for (const fn of this.listeners.get(name) || []) fn(e);
  }
}
globalThis.document = { createElement: tag => new Element(tag) };
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));

test('no plus, minus, or 1:1 controls appear, but gestures are retained', () => {
  const image = new Element('img');
  const z = createPhotoZoom(image);
  assert.equal(z.container.children.length, 1);
  assert.equal(z.viewport.children.length, 2, 'image plus loading overlay only');
  assert.equal(z.viewport.children.some(node=>node.tagName==='BUTTON'),false);
  z.viewport.dispatch('wheel',{deltaY:-350});
  assert.ok(z.zoom > 1);
  z.viewport.dispatch('keydown',{key:'0'});
  assert.equal(z.zoom,1);
  z.viewport.dispatch('dblclick',{clientX:150,clientY:100});
  assert.equal(z.zoom,2);
  z.destroy();
});

test('slow images expose an accessible loading state after a brief delay', async () => {
  const image = new Element('img');
  const z = createPhotoZoom(image);
  assert.equal(z.photoState,'empty');
  z.setSource('https://photo.example.test/signed/one.jpg');
  assert.equal(z.photoState,'pending');
  assert.equal(z.viewport.getAttribute('aria-busy'),'true');
  await sleep(220);
  assert.equal(z.photoState,'loading');
  assert.ok(z.viewport.classes.has('sn-photo-loading'));
  const overlay = z.viewport.children[1];
  assert.equal(overlay.getAttribute('role'),'status');
  assert.equal(overlay.children[1].textContent,'Loading photo');
  image.dispatch('load');
  assert.equal(z.photoState,'ready');
  assert.equal(z.viewport.getAttribute('aria-busy'),'false');
  assert.ok(!z.viewport.classes.has('sn-photo-loading'));
  z.destroy();
});

test('cached fast photos never flash the delayed spinner', async () => {
  const image = new Element('img');
  const z = createPhotoZoom(image);
  z.setSource('https://photo.example.test/signed/cached.jpg');
  image.dispatch('load');
  z.setSource('https://photo.example.test/signed/cached.jpg');
  await sleep(215);
  assert.equal(z.photoState,'ready');
  assert.ok(!z.viewport.classes.has('sn-photo-loading'));
  z.destroy();
});

test('photo switching cancels stale timers; failures show a helpful error', async () => {
  const image = new Element('img');
  const z = createPhotoZoom(image);
  z.setSource('https://photo.example.test/signed/old.jpg');
  z.setSource('https://photo.example.test/signed/new.jpg');
  assert.equal(image.src,'https://photo.example.test/signed/new.jpg');
  await sleep(210);
  assert.equal(z.photoState,'loading');
  image.dispatch('error');
  assert.equal(z.photoState,'error');
  assert.equal(z.viewport.children[1].children[1].textContent,'Photo unavailable');
  assert.equal(z.viewport.getAttribute('aria-busy'),'false');
  z.clearSource();
  assert.equal(z.photoState,'empty');
  assert.equal(image.getAttribute('src'),null);
  z.destroy();
  assert.equal(z.viewport.listeners.get('wheel')?.size,0);
});

test('both viewers call tracked image loading and have reduced-motion styling', () => {
  const gallery=readFileSync(new URL('../scene-photo-gallery-view.js',import.meta.url),'utf8');
  const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
  assert.match(gallery,/photoZoom\.setSource\(photos\[0\]\.url\)/);
  assert.match(gallery,/photoZoom\.setSource\(photos\[selected\]\.url\)/);
  assert.match(css,/\.sn-photo-zoom\.sn-photo-loading/);
  assert.match(css,/\.sn-photo-zoom\.sn-photo-error/);
  assert.match(css,/prefers-reduced-motion:reduce/);
  assert.doesNotMatch(css,/\.sn-photo-zoom-controls/);
});
