import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../'+name,import.meta.url),'utf8');
const editor = read('scene-editor.js');
const gallery = read('scene-photo-gallery-view.js');
const storage = read('scene-photo-storage.js');

test('authorised editor scene warms at most two private photos before rendering pins',()=>{
  assert.match(editor,/preloadSceneLabelPhotos\(list,\s*\{\s*maxPhotos: 2, saveData: !!navigator\.connection\?\.saveData/);
  assert.match(editor,/_editorPhotoWarmImages\.clear\(\)/);
  const start=editor.indexOf('async function loadObjects()');
  const next=editor.indexOf('function objectDisplayText(',start);
  const body=editor.slice(start,next);
  const checked=body.indexOf('if (_currentSceneId !== requestedSceneId) return;');
  const warmed=body.indexOf('preloadSceneLabelPhotos(list',checked);
  const rendered=body.indexOf('.forEach(renderObject)',warmed);
  assert.ok(checked>=0 && warmed>checked && rendered>warmed,
    'only the authorised current scene starts preloading before pin rendering');
});

test('main photo receives priority; secondary thumbnails are delayed and low priority',()=>{
  assert.match(gallery,/main\.fetchPriority='high'/);
  assert.match(gallery,/img\.fetchPriority='low'/);
  assert.match(gallery,/main\.addEventListener\('load',startThumbnails/);
  assert.match(gallery,/main\.addEventListener\('error',startThumbnails/);
  assert.match(gallery,/thumbnailAbort\.signal\.aborted/);
  const start=gallery.indexOf('const thumbnailQueue=[]');
  const end=gallery.indexOf('show(0);',start);
  const section=gallery.slice(start,end);
  assert.doesNotMatch(section,/img\.src=item\.url/);
  assert.match(section,/for\(const \{img,url\} of thumbnailQueue\) img\.src=url/);
});

test('photo signing uses bounded batch API without changing private URL lifetime',()=>{
  assert.match(storage,/createSignedUrls\(batch, 3600\)/);
  assert.match(storage,/const BATCH = 50/);
  assert.match(storage,/const signed = await signPaths\(prepared\.flatMap/);
});
