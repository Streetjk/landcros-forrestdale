import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {scenePhotoItems} from '../scene-label-pin.js';

const viewer = readFileSync(new URL('../viewer3d.js',import.meta.url),'utf8');

test('intro stops rotating after its flight; explicit rotation controls still work',()=>{
  const intro = viewer.slice(viewer.indexOf('function _doIntroAnimation()'),
    viewer.indexOf('async function _fetchWithTimeout',viewer.indexOf('function _doIntroAnimation()')));
  assert.match(intro,/controls\.autoRotate\s*=\s*false/);
  assert.doesNotMatch(intro,/controls\.autoRotate\s*=\s*true/);
  const manual = viewer.slice(viewer.indexOf('function startAutoOrbit('), viewer.indexOf('function stopAutoOrbit()'));
  assert.match(manual,/controls\.autoRotate\s*=\s*true/);
  assert.match(viewer,/rotBtn\.onclick = \(\) => \{/);
  assert.match(viewer,/if \(_idleFrames > IDLE_AFTER && now - _lastRenderMs < IDLE_INTERVAL/);
});

test('scene warm-up adopts only authorized head images, without repeating it on hydration',()=>{
  const start=viewer.indexOf('function _warmSceneLabelMedia(objects) {');
  const end=viewer.indexOf('\nfunction _removeSceneWidget(',start);
  assert.ok(start>0 && end>start);
  const allowedFull='https://images.example.test/signed/a.webp';
  const allowedThumb='https://images.example.test/signed/a-thumb.webp';
  const unauthorized='https://images.example.test/signed/another-scene.webp';
  const scene=[{kind:'label',props:{photoItems:[{path:'a',url:allowedFull,thumbUrl:allowedThumb}]}}];
  const calls=[];
  const ctx={
    scenePhotoItems,window:{__siteNavEarlyScene:{code:'abc123def4',warmed:[
      {src:allowedThumb},{src:allowedFull},{src:unauthorized},
    ]}},_params:new URLSearchParams('?scene=abc123def4'),
    navigator:{connection:{saveData:false}},
    preloadSceneLabelThumbnails(_objects,opts){calls.push(['thumb',opts]);return opts.existing;},
    preloadSceneLabelPhotos(_objects,opts){calls.push(['full',opts]);return opts.existing;},
  };
  vm.createContext(ctx);
  vm.runInContext(`let _scenePhotoWarmImages=new Map(); let _scenePhotoWarmThumbs=new Map();
    ${viewer.slice(start,end)}
    _warmSceneLabelMedia(sceneObjects);
    _warmSceneLabelMedia(sceneObjects);
    globalThis.results={full:_scenePhotoWarmImages,thumbs:_scenePhotoWarmThumbs};`,
    Object.assign(ctx,{sceneObjects:scene}));
  assert.deepEqual([...ctx.results.full.keys()],[allowedFull]);
  assert.deepEqual([...ctx.results.thumbs.keys()],[allowedThumb]);
  assert.equal(ctx.results.full.get(allowedFull),ctx.window.__siteNavEarlyScene.warmed[1]);
  assert.equal(ctx.results.thumbs.get(allowedThumb),ctx.window.__siteNavEarlyScene.warmed[0]);
  assert.ok(calls.every(([,opts])=>typeof opts.existing?.get==='function'));
  assert.ok(calls.every(([,opts])=>opts.saveData===false));
  assert.ok(calls.filter(([kind])=>kind==='thumb').every(([,opts])=>opts.maxThumbnails===4));
});
