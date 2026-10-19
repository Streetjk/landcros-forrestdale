import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../photo-zoom.js', import.meta.url), 'utf8');
const { createPhotoZoom } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.listeners = new Map();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.captured = new Set();
    this.classes = new Set();
    this.classList = {
      add: (...classes) => classes.forEach(value => this.classes.add(value)),
      toggle: (value, enabled) => enabled ? this.classes.add(value) : this.classes.delete(value),
    };
    this.clientWidth = 300;
    this.clientHeight = 200;
    this.naturalWidth = tag === 'img' ? 600 : undefined;
    this.naturalHeight = tag === 'img' ? 400 : undefined;
  }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  setAttribute(k, v) { this[k] = v; }
  getBoundingClientRect() { return {left:0,top:0,width:300,height:200}; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); }
  dispatch(type, props={}) {
    let prevented=false, stopped=false;
    const event = {
      pointerType:'mouse', button:0, pointerId:1,
      clientX:150, clientY:100, deltaY:0, deltaMode:0,
      ...props,
      preventDefault() { prevented=true; },
      stopPropagation() { stopped=true; },
    };
    for (const callback of this.listeners.get(type) || []) callback(event);
    return {prevented,stopped};
  }
}
globalThis.document = { createElement: tag => new Element(tag) };

test('wheel zoom stays inside photo, anchors to the cursor and clamps to maximum', () => {
  const image=new Element('img');
  const zoomer=createPhotoZoom(image);
  const frame=zoomer.viewport;
  const result=frame.dispatch('wheel',{deltaY:-350,clientX:210,clientY:100});
  assert.equal(result.prevented,true);
  assert.equal(result.stopped,true);
  assert.ok(zoomer.zoom > 1);
  assert.ok(image.style.transform.includes('scale('));
  frame.dispatch('wheel',{deltaY:-90000});
  assert.equal(zoomer.zoom,6);
  zoomer.reset();
  assert.equal(zoomer.zoom,1);
  assert.equal(image.style.transform,'translate3d(0px,0px,0) scale(1)');
});

test('single finger pans only after zoom, two fingers pinch in/out', () => {
  const image=new Element('img');
  const zoomer=createPhotoZoom(image);
  const v=zoomer.viewport;
  v.dispatch('pointerdown',{pointerId:1,clientX:100,clientY:100,pointerType:'touch'});
  v.dispatch('pointerdown',{pointerId:2,clientX:200,clientY:100,pointerType:'touch'});
  v.dispatch('pointermove',{pointerId:2,clientX:250,clientY:100,pointerType:'touch'});
  assert.ok(zoomer.zoom > 1.4 && zoomer.zoom < 1.6);
  v.dispatch('pointerup',{pointerId:2,pointerType:'touch'});
  const before=image.style.transform;
  v.dispatch('pointermove',{pointerId:1,clientX:122,clientY:105,pointerType:'touch'});
  assert.notEqual(image.style.transform,before,'panning changes photo offset');
  v.dispatch('pointerup',{pointerId:1,pointerType:'touch'});
  assert.equal(v.captured.size,0);
});

test('photo controls support double-click, keyboard zoom and safe cleanup', () => {
  const zoomer=createPhotoZoom(new Element('img'));
  const v=zoomer.viewport;
  v.dispatch('dblclick',{clientX:150,clientY:100});
  assert.equal(zoomer.zoom,2);
  v.dispatch('keydown',{key:'+'});
  assert.equal(zoomer.zoom,2.5);
  v.dispatch('keydown',{key:'0'});
  assert.equal(zoomer.zoom,1);
  v.dispatch('dblclick');
  assert.equal(zoomer.zoom,2);
  v.dispatch('dblclick');
  assert.equal(zoomer.zoom,1);
  zoomer.destroy();
  for(const listeners of v.listeners.values()) assert.equal(listeners.size,0);
});

test('scene editor and public photo galleries both wire the shared zoom controller', () => {
  const editor=readFileSync(new URL('../scene-editor.js',import.meta.url),'utf8');
  const gallery=readFileSync(new URL('../scene-photo-gallery-view.js',import.meta.url),'utf8');
  const viewer=readFileSync(new URL('../viewer3d.js',import.meta.url),'utf8');
  assert.match(editor,/createPhotoZoom\(photoPreview/);
  assert.match(editor,/_photoZoom\.container\.hidden = true/);
  assert.match(gallery,/createPhotoZoom\(main/);
  assert.match(gallery,/frame\._photoZoom\?\.destroy\(\)/);
  assert.match(viewer,/if\(galleryItems\.length > 0\)/);
});
