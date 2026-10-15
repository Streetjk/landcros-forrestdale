import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const index = read('index.html');
const viewerHtml = read('viewer3d.html');
const js = read('viewer3d.js');

test('desktop and landscape branding anchors to the left independent of the right drawer', () => {
  for (const [name,html] of [['index',index],['viewer',viewerHtml]]) {
    const desktop = html.slice(html.indexOf('@media (min-width: 1025px)'), html.indexOf('@media (max-width: 1024px)'));
    assert.match(desktop, /#site-brand\s*\{[^}]*left:\s*calc\(16px \+ env\(safe-area-inset-left, 0px\)\) !important;[^}]*right:\s*auto !important;/s, name + ' desktop');
    assert.match(desktop, /#site-address\s*\{\s*text-align:\s*left !important;/);
    assert.doesNotMatch(html, /#app\.scene-pin-selected\.panel-open #site-brand\s*\{/,name + ' scene panel should not reposition brand');
    const landscape = html.slice(html.indexOf('@media (max-width: 1024px) and (orientation: landscape)'));
    assert.match(landscape, /#site-brand[^{}]*\{[^}]*left:\s*calc\(16px \+ env\(safe-area-inset-left, 0px\)\) !important;[^}]*right:\s*auto !important;/s, name + ' landscape');
    assert.match(landscape, /#site-address\s*\{\s*text-align:\s*left !important;/);
    assert.match(html, /site-brand-layout\.css\?v=20261015a/,name + ' portrait uses shared fixed-left branding');
  }
  assert.doesNotMatch(index, /#app\.sheet-open #site-brand\s*\{\s*right:\s*calc/);
});

test('hidden-page renderer cancels frames instead of rescheduling background animation', () => {
  const start = js.indexOf('let _pageHidden = document.hidden === true;');
  const end = js.indexOf('let _selectedId = null;',start);
  assert.ok(start>=0 && end>start);
  const scheduler = js.slice(start,end);
  const animation = js.slice(js.indexOf('function animate()'), js.indexOf('if (!_camAnimating)', js.indexOf('function animate()')));
  assert.match(animation,/if \(_pageHidden\)\s*\{[\s\S]*?return;\s*\}\s*_queueViewerFrame\(\);/);
  assert.doesNotMatch(animation, /requestAnimationFrame\(animate\)/);

  let nextId=1;
  const queued=new Map();
  const cancelled=[];
  const listeners={};
  const doc={hidden:false,addEventListener(name,fn){listeners['document:'+name]=fn;}};
  const win={addEventListener(name,fn){listeners['window:'+name]=fn;}};
  const visibility=[];
  const context=vm.createContext({
    document:doc,window:win,requestAnimationFrame(callback){const id=nextId++;queued.set(id,callback);return id;},
    cancelAnimationFrame(id){cancelled.push(id);queued.delete(id);},
    _perf:{visibility(hidden){visibility.push(hidden);}},
  });
  vm.runInContext('let _idleFrames=25,_lastRenderMs=500; function animate(){};'+scheduler+'\n_queueViewerFrame();',context);
  assert.equal(queued.size,1,'one frame scheduled while visible');
  doc.hidden=true;listeners['document:visibilitychange']();
  assert.equal(queued.size,0,'hidden page has no outstanding animation frame');
  assert.deepEqual(cancelled,[1]);
  vm.runInContext('_queueViewerFrame()',context);
  assert.equal(queued.size,0,'hidden page must not queue more work');
  listeners['document:visibilitychange']();
  assert.equal(queued.size,0,'duplicate hidden event must not do extra work');
  doc.hidden=false;listeners['document:visibilitychange']();
  assert.equal(queued.size,1,'becoming visible schedules exactly one frame');
  listeners['window:pageshow']();
  assert.equal(queued.size,1,'pageshow must not double queue');
  listeners['window:pagehide']();
  assert.equal(queued.size,0,'pagehide cancels outstanding work');
  listeners['window:pageshow']();
  assert.equal(queued.size,1,'bfcache pageshow restores rendering');
  assert.deepEqual(visibility,[true,false,true,false]);
});

test('browser GPS watch stops when tab is hidden or unloaded', () => {
  assert.match(js,/document\.addEventListener\('visibilitychange',[\s\S]*?if \(document\.hidden && \(_gpsWatchId !== null \|\| _gpsWatchStarting\)\) _stopGpsTracking\(true\);/);
  assert.match(js,/window\.addEventListener\('pagehide',[\s\S]*?if \(_gpsWatchId !== null \|\| _gpsWatchStarting\) _stopGpsTracking\(true\);/);
});
