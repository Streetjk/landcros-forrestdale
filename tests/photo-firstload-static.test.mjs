import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../'+name,import.meta.url),'utf8');
const gallery = read('scene-photo-gallery-view.js');
const manifest = read('static-public-files.js');

test('static gallery prioritises visible signed image ahead of deferred thumbnails',()=>{
  assert.match(gallery,/main\.fetchPriority='high'/);
  assert.match(gallery,/img\.fetchPriority='low'/);
  assert.match(gallery,/main\.addEventListener\('load',startThumbnails/);
  assert.match(gallery,/main\.addEventListener\('error',startThumbnails/);
  assert.match(gallery,/thumbnailAbort\.signal\.aborted/);
  assert.match(gallery,/for\(const \{img,url\} of thumbnailQueue\) img\.src=url/);
  assert.match(gallery,/frame\._thumbAbort\?\.abort\(\)/);
});

test('photo loader remains restricted to authorised photoUrls, not a new static endpoint',()=>{
  assert.match(gallery,/const photos=scenePhotoItems\(props\)/);
  assert.doesNotMatch(gallery,/localStorage|sessionStorage|indexedDB|new Request\(/);
  assert.match(manifest,/'scene-photo-gallery-view\.js'/);
  assert.match(manifest,/'photo-zoom\.js'/);
});
