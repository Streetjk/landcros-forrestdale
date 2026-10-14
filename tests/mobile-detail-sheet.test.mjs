import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {nextDetailState, trackMapTaps} from '../mobile-detail-sheet.js';

const idle={stage:'idle',key:null};
test('first selection is a summary; same pin second and subsequent taps remain fully expanded',()=>{
  const first=nextDetailState(idle,{type:'select',key:'scene:A'});
  assert.deepEqual(first,{stage:'summary',key:'scene:A'});
  const second=nextDetailState(first,{type:'select',key:'scene:A'});
  assert.deepEqual(second,{stage:'full',key:'scene:A'});
  assert.deepEqual(nextDetailState(second,{type:'select',key:'scene:A'}),second);
});
test('different pin/label returns a fresh summary, not a dismissal',()=>{
  assert.deepEqual(nextDetailState({stage:'full',key:'scene:A'},{type:'select',key:'building:B'}),
    {stage:'summary',key:'building:B'});
});
test('empty map and close button dismiss selection; explicit full/summary work',()=>{
  const first=nextDetailState(idle,{type:'select',key:'point:A'});
  const full=nextDetailState(first,{type:'expand'});
  assert.equal(full.stage,'full');
  assert.deepEqual(nextDetailState(full,{type:'summary'}),first);
  const closed=nextDetailState(full,{type:'dismiss'});
  assert.deepEqual(closed,{stage:'closed',key:null});
  assert.deepEqual(nextDetailState(closed,{type:'select',key:'point:A'}),first);
  assert.deepEqual(nextDetailState(full,{type:'reset'}),idle);
});

test('tap detection rejects orbit drag, pinch, and pointer cancellation',()=>{
  const oldWindow=globalThis.window;
  const listeners=new Map(), globalListeners=new Map();
  globalThis.window={addEventListener:(type,fn)=>globalListeners.set(type,fn)};
  try {
    const canvas={addEventListener:(type,fn)=>listeners.set(type,fn)};
    const isTap=trackMapTaps(canvas);
    const down=(id,x,y)=>listeners.get('pointerdown')({pointerId:id,clientX:x,clientY:y});
    const move=(id,x,y)=>listeners.get('pointermove')({pointerId:id,clientX:x,clientY:y});
    const up=(id,x,y)=>globalListeners.get('pointerup')({type:'pointerup',pointerId:id,clientX:x,clientY:y});
    down(1,10,10);up(1,12,12);assert.equal(isTap({detail:1}),true);
    down(1,10,10);move(1,70,60);up(1,70,60);assert.equal(isTap({detail:1}),false);
    down(1,10,10);down(2,30,30);up(2,30,30);up(1,10,10);assert.equal(isTap({detail:1}),false);
    down(1,10,10);globalListeners.get('pointercancel')({type:'pointercancel',pointerId:1,clientX:10,clientY:10});
    assert.equal(isTap({detail:1}),false);
  } finally {globalThis.window=oldWindow;}
});

const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
test('compact details do not mutate pins, photos, authentication or browser storage',()=>{
  const src=read('mobile-detail-sheet.js');
  assert.doesNotMatch(src,/\bfetch\s*\(|localStorage|indexedDB|XMLHttpRequest/);
  assert.match(src,/image\.crossOrigin = 'anonymous'/);
  assert.match(src,/image\.referrerPolicy = 'no-referrer'/);
  assert.match(src,/new MutationObserver/);
});
test('selected detail stylesheet provides full scrolling and explicit map dismissal',()=>{
  const css=read('mobile-detail-sheet.css');
  assert.match(css,/data-detail-stage="full"[\s\S]*overflow-y:auto!important/);
  assert.match(css,/data-detail-stage="full"[\s\S]*-webkit-line-clamp:unset!important/);
  assert.match(css,/\.sn-summary-description[\s\S]*-webkit-line-clamp:2/);
  assert.match(css,/\.sn-details-dismissed #side-panel[\s\S]*visibility:hidden!important/);
  assert.match(css,/@media \(max-width:1024px\)/);
});
test('viewer dispatch selects pins first and dismisses only after a genuine empty-map tap',()=>{
  const src=read('viewer3d.js');
  assert.match(src,/_mobileDetails\.repeat\('scene:' \+ obj\.id\)/);
  assert.match(src,/_mobileDetails\.repeat\('point:' \+ pt\.id\)/);
  assert.match(src,/_mobileDetails\.isCompact\(\) && !_isMobileMapTap\(e\)/);
  assert.match(src,/return; \/\/ Selecting a pin\/label\/action must never fall through to dismiss/);
  assert.match(src,/if \(!labelHit\) _mobileDetails\.dismiss\(\)/);
});
test('public pages load the responsive detail stylesheet after old inline CSS',()=>{
  for(const name of ['index.html','viewer3d.html']){
    const html=read(name);
    assert.ok(html.indexOf('href="./mobile-detail-sheet.css?')>html.lastIndexOf('</style>'));
    assert.match(html,/src="\.\/viewer3d\.js\?v=[^"]+/);
  }
});
