import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preloadSceneLabelPhotos } from '../scene-label-pin.js';

const urls = [
  'https://example.test/signed/one.jpg?token=private-one',
  'https://example.test/signed/two.jpg?token=private-two',
  'https://example.test/signed/three.jpg?token=private-three',
];
const scene = [
  { kind: 'button', props: { photoUrl: urls[0] } },
  { kind: 'label', props: { photoUrl: urls[0] } },
  { kind: 'label', props: { photoUrl: urls[0] } },
  { kind: 'label', props: { photoUrl: urls[1] } },
  { kind: 'label', props: { photoUrl: urls[2] } },
  { kind: 'label', props: { photoUrl: 'data:image/png;base64,ABC' } },
];

function fakeImages() {
  const created = [];
  const factory = () => {
    const events = new Map();
    const img = {
      decodeCalls: 0,
      addEventListener: (type, handler) => events.set(type, handler),
      decode() { this.decodeCalls += 1; return Promise.resolve(); },
      dispatch(type) { events.get(type)?.(); },
    };
    created.push(img);
    return img;
  };
  return { factory, created };
}

test('preload current-scene photos only; limit network work to two signed URLs', async () => {
  const { factory, created } = fakeImages();
  const warmed = preloadSceneLabelPhotos(scene, { createImage: factory });
  assert.deepEqual([...warmed.keys()], urls.slice(0, 2));
  assert.equal(created.length, 2);
  assert.equal(created[0].src, urls[0]);
  assert.equal(created[1].src, urls[1]);
  assert.ok(created.every(x => x.crossOrigin === 'anonymous'
    && x.referrerPolicy === 'no-referrer'
    && x.loading === 'eager' && x.decoding === 'async' && x.decodeCalls === 1));
  assert.equal(created[0].fetchPriority, 'high');
  assert.equal(created[1].fetchPriority, 'low');
  created[0].dispatch('error');
  assert.equal(warmed.has(urls[0]), false);
  assert.equal(warmed.has(urls[1]), true);
});

test('opt-out honours data-saving mode and skips invalid/non-HTTPS images', () => {
  const { factory, created } = fakeImages();
  assert.equal(preloadSceneLabelPhotos(scene, { saveData: true, createImage: factory }).size, 0);
  assert.equal(preloadSceneLabelPhotos(null, { createImage: factory }).size, 0);
  assert.equal(preloadSceneLabelPhotos(scene, { maxPhotos: 0, createImage: factory }).size, 0);
  assert.equal(created.length, 0);
});

test('viewer initiates preload during scene resolution and makes selected photo eager', () => {
  const src = readFileSync(new URL('../viewer3d.js', import.meta.url), 'utf8');
  assert.match(src, /preloadSceneLabelPhotos\(_sceneBundle\.objects/);
  assert.match(src, /saveData: !!navigator\.connection\?\.saveData/);
  assert.match(src, /img\.loading = 'eager'/);
  assert.match(src, /img\.fetchPriority = 'high'/);
  const start = src.indexOf('preloadSceneLabelPhotos(_sceneBundle.objects');
  const render = src.indexOf('renderSceneWidgets(_sceneBundle.objects)', start);
  assert.ok(start >= 0 && render > start, 'preload must start before scene widgets render');
});
