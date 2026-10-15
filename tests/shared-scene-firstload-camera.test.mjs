import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {singleSharedSceneLabelPosition} from '../shared-scene-startup-focus.js';

const source=readFileSync(new URL('../viewer3d.js',import.meta.url),'utf8');
const label=(id,x,y,z)=>({kind:'label',id,transform:{position:[x,y,z]}});
const sample=[label('roller-door',-9.4,0,-6.4)];

test('only one valid scene label is a safe automatic first-visit camera target',()=>{
  assert.deepEqual(singleSharedSceneLabelPosition(sample),{id:'roller-door',x:-9.4,y:0,z:-6.4});
  assert.deepEqual(singleSharedSceneLabelPosition([{kind:'button',id:'B'},...sample]),{id:'roller-door',x:-9.4,y:0,z:-6.4});
  assert.equal(singleSharedSceneLabelPosition([...sample,label('other',1,0,2)]),null);
  assert.equal(singleSharedSceneLabelPosition([label('bad',NaN,0,0)]),null);
  assert.equal(singleSharedSceneLabelPosition([label('far',201,0,0)]),null);
  assert.equal(singleSharedSceneLabelPosition([{...sample[0],id:''}]),null);
  assert.equal(singleSharedSceneLabelPosition(null),null);
});

function harness({hidden=false,scene='ic48ij45q9',editor=false,deepId=false,interacted=false}={}) {
  const start=source.indexOf('function _focusFirstSharedSceneLabel(');
  const end=source.indexOf('// ── Scene status bar',start);
  const code=source.slice(start,end);
  assert.ok(start>=0&&end>start);
  const flights=[];
  const handlers=new Map();
  const document={hidden,
    getElementById:id=>editor&&id==='add-label-btn'?{}:null,
    addEventListener:(event,handler)=>handlers.set(event,handler),
    removeEventListener:(event,handler)=>{if(handlers.get(event)===handler)handlers.delete(event)}
  };
  const params=new URLSearchParams(scene?'scene='+scene+(deepId?'&id=1':''):'');
  const context=vm.createContext({
    document,_params:params,_publicMyPinMode:false,
    _sceneWidgets:new Map([['roller-door',{}]]),
    singleSharedSceneLabelPosition,_suppressLateSplatIntro:interacted,
    THREE:{Vector3:class {constructor(x,y,z){Object.assign(this,{x,y,z});}}},
    _focusPinCamera:(position,opts)=>{flights.push({position,opts});return true;}
  });
  vm.runInContext(code,context);
  return {context,document,handlers,flights,run:()=>vm.runInContext('_focusFirstSharedSceneLabel('+JSON.stringify(sample)+')',context)};
}

test('valid shared scene focuses the sole label without automatically orbiting',()=>{
  const h=harness();
  assert.equal(h.run(),true);
  assert.equal(h.flights.length,1);
  assert.equal(h.flights[0].position.x,-9.4);
  assert.equal(h.flights[0].position.z,-6.4);
  assert.equal(h.flights[0].opts.orbitAfterArrival,false);
  assert.equal(h.flights[0].opts.source,'shared-scene-startup');
});

test('manual navigation, non-scene route, editor and explicit point deep link block auto focus',()=>{
  for(const options of [{interacted:true},{scene:null},{editor:true},{deepId:true}]){
    const h=harness(options);
    assert.equal(h.run(),false,JSON.stringify(options));
    assert.equal(h.flights.length,0);
  }
});

test('background tab defers focus until visible and does not override intervening interaction',()=>{
  const h=harness({hidden:true});
  assert.equal(h.run(),true);
  assert.equal(h.flights.length,0);
  assert.ok(h.handlers.has('visibilitychange'));
  h.document.hidden=false;
  h.handlers.get('visibilitychange')();
  assert.equal(h.flights.length,1);
  assert.equal(h.handlers.has('visibilitychange'),false);
  const other=harness({hidden:true});
  other.run();
  other.document.hidden=false;
  other.context._suppressLateSplatIntro=true;
  other.handlers.get('visibilitychange')();
  assert.equal(other.flights.length,0);
});

test('scene pin frames once after authorized bundle render, not on vanilla base',()=>{
  const boot=source.slice(source.indexOf('async function boot()'));
  const resolved=boot.indexOf('if (_sceneBundle?.objects)');
  const focus=boot.indexOf('_focusFirstSharedSceneLabel(_sceneBundle.objects)');
  assert.ok(resolved>=0&&focus>resolved);
  assert.ok(boot.indexOf("const _sceneCode = _params.get('scene')")<focus);
  assert.match(source,/function _focusFirstSharedSceneLabel\(objects\)/);
  assert.match(source,/_suppressLateSplatIntro/);
});
