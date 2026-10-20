import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const viewer=readFileSync(new URL('../viewer3d.js',import.meta.url),'utf8');
const editor=readFileSync(new URL('../scene-editor.js',import.meta.url),'utf8');

const expr=/const moved = (camera\.position\.distanceToSquared\([\s\S]*?_CAMERA_QUATERNION_EPS);/.exec(viewer);
assert.ok(expr,'Expected epsilon-based camera movement check');

function movement(x,angle=0) {
  const prev={x:0},qprev={angle:0};
  const camera={
    position:{distanceToSquared(a){return (x-a.x)**2;}},
    quaternion:{dot(){return Math.cos(angle/2);}}
  };
  return new Function('camera','_prevCamPos','_prevCamQuat',
    '_CAMERA_POSITION_EPS_SQ','_CAMERA_QUATERNION_EPS','return '+expr[1])
    (camera,prev,qprev,1e-8,1e-9);
}

test('imperceptible OrbitControls damping no longer forces full-speed splat sorting',()=>{
  assert.equal(movement(0),false);
  assert.equal(movement(0.000001),false);
  assert.equal(movement(0.001),true);
  assert.equal(movement(0,0.000001),false);
  assert.equal(movement(0,0.01),true);
});

test('editor scene invalidation restarts full-rate rendering for pin changes',()=>{
  const start=viewer.indexOf('function _invalidateViewerFrame()');
  const end=viewer.indexOf('function _setViewerPageVisibility(',start);
  assert.ok(start>=0 && end>start);
  let frames=0;
  const state={_idleFrames:45,_lastRenderMs:99,_queueViewerFrame:()=>{frames++;}};
  vm.runInNewContext(viewer.slice(start,end),state);
  state._invalidateViewerFrame();
  assert.equal(state._idleFrames,0);
  assert.equal(state._lastRenderMs,0);
  assert.equal(frames,1);
  assert.match(viewer,/invalidateRender: _invalidateViewerFrame/);
});

test('pin dragging, selection and scene-object edits invalidate the camera-idle throttle',()=>{
  assert.match(editor, /function onTransformChange\(\) \{[\s\S]*?_v3d\.invalidateRender\?\.\(\);\s*scheduleSave\(_selectedId\)/);
  assert.match(editor, /_scene\.add\(anchor\);\s*_v3d\.invalidateRender\?\.\(\)/);
  assert.match(editor, /_transformControls\.attach\(entry\.anchor\);\s*_v3d\.invalidateRender\?\.\(\)/);
  assert.match(editor, /_transformControls\.detach\(\);\s*_v3d\.invalidateRender\?\.\(\)/);
  assert.match(editor, /_objects\.delete\(id\);\s*_v3d\.invalidateRender\?\.\(\)/);
});

test('editor camera settles quickly, while public viewer damping is unchanged',()=>{
  const match=/controls\.dampingFactor = document\.getElementById\('add-label-btn'\) \? 0\.14 : 0\.06;/.exec(viewer);
  assert.ok(match,'Editor must use its own quicker settling inertia');
  for(const [isEditor,expected] of [[true,0.14],[false,0.06]]){
    const context={controls:{},document:{getElementById(){return isEditor?{}:null;}}};
    vm.runInNewContext(match[0],context);
    assert.equal(context.controls.dampingFactor,expected);
  }
});
