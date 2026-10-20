import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = file => readFileSync(new URL('../'+file,import.meta.url),'utf8');
const editor=read('scene-editor.js');
const viewer=read('viewer3d.js');

function createBootHarness(viewerReady) {
  const listeners=new Map();
  const win={
    _v3d:viewerReady ? {_pickGround:{parent:{}}} : null,
    addEventListener(name,fn){listeners.set(name,fn);},
    dispatch(name){listeners.get(name)?.();}
  };
  let inits=0;
  const errors=[];
  const boot=editor.slice(editor.indexOf('let _editorInitPromise = null;'),
    editor.indexOf('// ── Init (viewer available;'));
  assert.ok(boot.includes('if (window._v3d) startEditorOnce();'));
  const context={
    window:win,document:{getElementById:()=>({style:{}})},
    SLUG:'landcros',_scenesLoadFailed:false,
    location:{reload(){errors.push('reload');}},
    console:{error(...args){errors.push(args.map(String).join(' '));}},
    showSceneReloadError(...args){errors.push(args[0]);},
    init(){inits++;return Promise.resolve();},
    loadSceneGroups:async()=>{},loadScenes:async()=>{},
  };
  vm.runInNewContext(boot,context);
  return {win,errors,get inits(){return inits;}};
}

test('editor initializes if viewer event fired before editor module was imported',async()=>{
  const h=createBootHarness(true);
  await Promise.resolve();await Promise.resolve();
  assert.equal(h.inits,1);
  h.win.dispatch('viewer3d:ready');
  await Promise.resolve();await Promise.resolve();
  assert.equal(h.inits,1,'repeated ready events must not add duplicate handlers');
  assert.deepEqual(h.errors,[]);
});

test('editor initializes when viewer becomes ready later',async()=>{
  const h=createBootHarness(false);
  await Promise.resolve();
  assert.equal(h.inits,0);
  h.win._v3d={_pickGround:{parent:{}}};
  h.win.dispatch('viewer3d:ready');
  await Promise.resolve();await Promise.resolve();
  assert.equal(h.inits,1);
});

test('photo zoom mounting retains its original parent before moving the photo',()=>{
  const snippetStart=editor.indexOf("const photoPreview = document.getElementById('prop-photo-preview');");
  const snippetEnd=editor.indexOf("document.getElementById('prop-photo-remove-btn').addEventListener",snippetStart);
  assert.ok(snippetStart>=0 && snippetEnd>snippetStart);
  const snippet=editor.slice(snippetStart,snippetEnd);
  class Element {
    constructor(name){this.name=name;this.children=[];this.parentElement=null;}
    appendChild(child){child.parentElement=this;this.children.push(child);}
    insertBefore(child,sibling){
      for(let ancestor=this;ancestor;ancestor=ancestor.parentElement)
        if(ancestor===child)throw Error('Invalid circular DOM insertion');
      const idx=this.children.indexOf(sibling);
      if(idx<0)throw Error('Sibling not in original parent');
      child.parentElement=this;
      this.children.splice(idx,0,child);
    }
  }
  const field=new Element('photo field');
  const img=new Element('photo preview');
  const gallery=new Element('gallery');
  field.appendChild(img);field.appendChild(gallery);
  const zoomContainer=new Element('zoom container');
  const viewport=new Element('zoom viewport');
  zoomContainer.appendChild(viewport);
  const document={
    getElementById(name){return name==='prop-photo-preview'?img:gallery;}
  };
  const createPhotoZoom=(source)=>{
    assert.equal(source,img);
    viewport.appendChild(source); // exactly what production createPhotoZoom does
    return {container:zoomContainer};
  };
  const state={};
  new Function('document','createPhotoZoom', '_state',
    'let _photoZoom=null;'+snippet+' _state.zoom=_photoZoom;'
  )(document,createPhotoZoom,state);
  assert.equal(img.parentElement,viewport);
  assert.equal(zoomContainer.parentElement,field);
  assert.deepEqual(field.children.map(x=>x.name),['photo preview','zoom container','gallery']);
  assert.equal(state.zoom.container.hidden,true);
});

test('editor distinguishes sign-in, permission and network failures without clearing records',()=>{
  assert.match(editor,/status === 401 \? 'Sign in again/);
  assert.match(editor,/status === 403 \? 'This account does not have access/);
  assert.match(editor,/window\._snShowLoginGate\?\.\(\)/);
  assert.match(editor,/window\.addEventListener\('sn-auth:signed-in'/);
  assert.match(editor,/This loading error did not delete any records/);
});

function introHarness(editorMode) {
  const source=viewer.slice(viewer.indexOf('function _doIntroAnimation()'),
   viewer.indexOf('async function loadSplatBackground(',viewer.indexOf('function _doIntroAnimation()')));
  assert.ok(source.length>1000);
  let tweens=0,updates=0;
  const camera={
    position:{
      current:null,
      setFromSpherical(v){this.current=v;},
    },
    lookAt(){},
  };
  const controls={
    autoRotate:true, enabled:true,
    target:{copy(){}},
    update(){updates++;}
  };
  class Vector3 { constructor(x,y,z){this.x=x;this.y=y;this.z=z;} }
  class Spherical {
    constructor(radius=1,phi=0,theta=0){Object.assign(this,{radius,phi,theta});}
    setFromVector3(){this.radius=27;this.phi=1;this.theta=2;return this;}
  }
  const state={camera,controls,gsap:{to(){tweens++;return {kill(){}};}},
   document:{getElementById(){return editorMode ? {} : null;}},
   window:{_syncRotateBtn(){}},
   THREE:{Vector3,Spherical,MathUtils:{degToRad:v=>v*Math.PI/180,lerp:(a,b,t)=>a+(b-a)*t}},
   _cfg:{camera:{introAnimation:{phi:80.9,theta:-25.9}}},
   _splatViewer:{},_introPlayed:false,_camAnimating:false,_camTween:null
  };
  vm.runInNewContext(source,state);
  state._doIntroAnimation();
  return {state,camera,controls,get tweens(){return tweens;},get updates(){return updates;}};
}

test('editor goes directly to the accepted 3D angle and does not start continuous rotation',()=>{
  const r=introHarness(true);
  assert.equal(r.tweens,0,'editor should not start an expensive 3-second camera tween');
  assert.equal(r.controls.autoRotate,false);
  assert.equal(r.controls.enabled,true);
  assert.equal(r.state._camAnimating,false);
  assert.equal(r.state._introPlayed,true);
  assert.ok(r.camera.position.current && Math.abs(r.camera.position.current.radius-27)<0.001);
  assert.equal(r.updates,1);
});

test('public viewer retains its original introductory camera motion',()=>{
  const r=introHarness(false);
  assert.equal(r.tweens,1);
  assert.equal(r.controls.enabled,false);
  assert.equal(r.state._camAnimating,true);
});
