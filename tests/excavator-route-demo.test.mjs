// Dependency-free behavioural smoke test for the isolated SiteNav route module.
// Stubs the browser/three.js renderer, but runs the actual route controller.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const path = new URL('../excavator-route.js', import.meta.url);
const source = readFileSync(path, 'utf8');
const moduleBody = source
  .replace(/^import .*;\s*$/gm, '')
  .replace('export async function createExcavatorRoute', 'async function createExcavatorRoute');
assert.equal(moduleBody.includes('import {'), false);

class Vec {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { Object.assign(this, { x, y, z }); return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  add(v) { return this.set(this.x+v.x,this.y+v.y,this.z+v.z); }
  sub(v) { return this.set(this.x-v.x,this.y-v.y,this.z-v.z); }
  lerp(v, t) { return this.set(this.x+(v.x-this.x)*t,this.y+(v.y-this.y)*t,this.z+(v.z-this.z)*t); }
  normalize() { const len = Math.hypot(this.x,this.y,this.z)||1; return this.set(this.x/len,this.y/len,this.z/len); }
}
class Curve {
  constructor(points) {
    this.points = points;
    this.lengths = points.slice(1).map((p, i) => Math.hypot(p.x-points[i].x,p.z-points[i].z));
    this.length = this.lengths.reduce((a, b) => a+b, 0);
  }
  getLength() { return this.length; }
  _position(t) {
    let metres = Math.min(1, Math.max(0, t)) * this.length;
    for (let i=0; i<this.lengths.length; i++) {
      if (metres <= this.lengths[i] || i===this.lengths.length-1) {
        return { index:i, ratio:Math.min(1, metres/this.lengths[i]) };
      }
      metres -= this.lengths[i];
    }
  }
  getPointAt(t, out = new Vec()) {
    const { index, ratio } = this._position(t);
    const a=this.points[index], b=this.points[index+1];
    return out.set(a.x+(b.x-a.x)*ratio,a.y+(b.y-a.y)*ratio,a.z+(b.z-a.z)*ratio);
  }
  getTangentAt(t,out = new Vec()) {
    const { index } = this._position(t);
    const a=this.points[index], b=this.points[index+1];
    return out.set(b.x-a.x,b.y-a.y,b.z-a.z).normalize();
  }
}
class FakeElement {
  constructor() {
    this.style={}; this.handlers={}; this.attributes={}; this.textContent='';
    this.children={};
  }
  setAttribute(name,value) { this.attributes[name]=value; }
  addEventListener(name,fn) { this.handlers[name]=fn; }
  querySelector(sel) {
    if(!this.children[sel]) this.children[sel] = new FakeElement();
    return this.children[sel];
  }
  click() { this.handlers.click?.(); }
  appendChild() {}
  remove() {}
}
const toolbar = new FakeElement();
for(const [id,label] of Object.entries({
  'ex-play':'Pause','ex-focus':'Unfollow',
  'excavator-demo-status':'Loading rig…','ex-speed':'',
})){
  toolbar.children['#'+id]=new FakeElement();
  toolbar.children['#'+id].textContent=label;
}
const document = {
  createElement(type) { return type==='section'?toolbar:new FakeElement(); },
  head:new FakeElement(),
  body:new FakeElement(),
};
class Layers {
  constructor(){this.mask=1;}
  set(layer){this.mask=1<<layer;}
  enable(layer){this.mask|=1<<layer;}
}
const rawRigMeshes = [
  {isMesh:true,layers:new Layers(), material:{transparent:false,opacity:1,depthWrite:true}},
  {isMesh:true,layers:new Layers(), material:{transparent:true,opacity:0.15,depthWrite:false}},
];
const rig={
  layers:new Layers(),
  scale:{setScalar(){}},
  position:new Vec(),
  rotation:{y:0,set(_x,y){this.y=y;}},
  traverse(fn){fn(this);rawRigMeshes.forEach(fn);},
  removeFromParent(){},
};
class GLTFLoader { async loadAsync() { return {scene:rig}; } }
let mechanics;
class ExcavatorRig {
  constructor(){this.distance=0;this.poses=[];mechanics=this;}
  drive(left,right){this.distance+=Math.max(left,right);}
  setPose(pose){this.poses.push(pose);}
}
let now=0;
const performance={now:()=>now};
const fetch=async()=>({ok:true,json:async()=>({})});
const THREE={
  Vector3:Vec,CatmullRomCurve3:Curve,
  TubeGeometry:class{},
  MeshBasicMaterial:class{constructor(opts){Object.assign(this,opts);}},
  Mesh:class{constructor(_g, material){this.material=material;this.isMesh=true;} removeFromParent(){}},
  MathUtils:{lerp:(a,b,t)=>a+(b-a)*t},
};
const light={isLight:true,layers:new Layers()};
const scene={objects:[light],add(object){this.objects.push(object);},traverse(fn){this.objects.forEach(fn);}};
const camera={position:new Vec(6,9,10),aspect:0.51,fov:60,layers:new Layers()};
const controls={target:new Vec(),autoRotate:true,handlers:{},update(){},
  addEventListener(type,fn){this.handlers[type]=fn;},
  removeEventListener(type,fn){if(this.handlers[type]===fn)delete this.handlers[type];},
  start(){this.handlers.start?.();},
};
const createRoute=new Function('GLTFLoader','ExcavatorRig','document','performance','fetch',
  moduleBody+';return createExcavatorRoute;')(GLTFLoader,ExcavatorRig,document,performance,fetch);
const instance=await createRoute({THREE,scene,camera,controls,invalidate(){}});
const el=id=>toolbar.querySelector('#'+id);
const assertNear=(actual,expected,tolerance=0.025)=>{
  assert.ok(Math.abs(actual-expected)<tolerance, `expected ${actual} ≈ ${expected}`);
};

assertNear(rig.position.x,-5.77);
assertNear(rig.position.z,-11.16);
assert.equal(el('ex-focus').textContent, 'Unfollow');
assert.equal(el('ex-state').textContent, 'Moving');
assert.equal(el('ex-state').attributes['data-state'], 'moving');
assert.equal(el('excavator-demo-status').textContent, 'Model loaded · one-way route running');
assert.ok(source.includes('value="2" selected>2×'));
assert.ok(source.includes('value="5">5×'));
assert.ok(!source.includes('value="10"'));
assert.ok(!source.includes('id="ex-work"'));
assert.equal(rawRigMeshes.every(x=>x.renderOrder===50),true);
assert.equal(rawRigMeshes.every(x=>x.material.depthTest),true);
assert.equal(rawRigMeshes[0].material.transparent,false,'opaque body must stay opaque');
assert.equal(rawRigMeshes[1].material.transparent,true,'glass must stay blended');
assert.equal(rawRigMeshes[1].material.opacity,0.15);
assert.equal(rawRigMeshes[1].material.depthWrite,false);
assert.equal(scene.objects[1].renderOrder,4);
const modelMask=1<<29;
assert.equal(rig.layers.mask,modelMask);
assert.equal(rawRigMeshes.every(x=>x.layers.mask===modelMask),true);
assert.equal(light.layers.mask,1|modelMask,'light must illuminate both render layers');
const passLayers=[];
let clearCount=0;
const renderer={autoClear:true,clearDepth(){clearCount++;},render(_scene,camera){passLayers.push(camera.layers.mask);}};
instance.renderOverlay(renderer);
assert.equal(clearCount,1,'final overlay must clear site depth');
assert.deepEqual(passLayers,[modelMask],'final overlay must draw only rig layer');
assert.equal(camera.layers.mask,1,'camera must restore original site layer');
assert.equal(renderer.autoClear,true,'WebGLRenderer autoClear must restore');

// At the reversed start, +X (model forward) must face the new path tangent.
const initialTangent=new Vec(-5.73+5.77,0,-11.79+11.16).normalize();
const forward=new Vec(Math.cos(rig.rotation.y),0,-Math.sin(rig.rotation.y));
assert.ok(forward.x*initialTangent.x+forward.z*initialTangent.z>0.9);

const d0=Math.hypot(camera.position.x-rig.position.x,camera.position.z-rig.position.z);
// The cinematic must preserve the SiteNav camera on the first frame and
// enter its orbit gradually, rather than jumping straight to a new pose.
const cameraAtStart=new Vec().copy(camera.position);
now+=80;instance.update(now);
now+=80;instance.update(now);
assert.ok(Math.hypot(
  camera.position.x-cameraAtStart.x,camera.position.y-cameraAtStart.y,
  camera.position.z-cameraAtStart.z,
)<0.10,'first 160ms of zoom must be gentle');

// The first two seconds must preserve compass heading and camera pitch.
// Translation towards the excavator is permitted; a map-wide turn is not.
const initialView=new Vec().copy(cameraAtStart).normalize();
for(let i=0;i<23;i++){now+=80;instance.update(now);}
const earlyView=new Vec().copy(camera.position).sub(controls.target).normalize();
const viewDot=initialView.x*earlyView.x+initialView.y*earlyView.y+initialView.z*earlyView.z;
assert.ok(viewDot>0.999, 'initial approach must not rotate the entire site view');

let zoomRadiusAtElevenSeconds=null;
let parkingFrames=0;
let slewAtArrival=null;
let trackDistanceAtArrival=null;
let chassisYawAtArrival=null;
let priorParkingSlew=null;
for(let i=0;i<3500;i++){
  now+=80;
  instance.update(now);
  if(zoomRadiusAtElevenSeconds===null&&now>=11000){
    zoomRadiusAtElevenSeconds=Math.hypot(
      camera.position.x-controls.target.x,
      camera.position.y-controls.target.y,
      camera.position.z-controls.target.z,
    );
  }
  if(el('ex-state').textContent==='Parking'){
    parkingFrames++;
    const slewNow=mechanics.poses.at(-1).slew;
    if(slewAtArrival===null){
      slewAtArrival=slewNow;
      trackDistanceAtArrival=mechanics.distance;
      chassisYawAtArrival=rig.rotation.y;
      assert.equal(el('ex-play').textContent,'Pause',
        'Replay should only appear once the final slew finishes');
    }
    assert.equal(mechanics.distance,trackDistanceAtArrival,
      'tracks must remain stationary throughout the final slew');
    assertNear(rig.rotation.y,chassisYawAtArrival,0.000001);
    if(priorParkingSlew!==null){
      assert.ok(slewNow<=priorParkingSlew+0.000001,
        'the final upperstructure rotation must be clockwise only');
    }
    priorParkingSlew=slewNow;
    if(parkingFrames===30){
      // Pause/resume must freeze the parking animation, not restart it.
      el('ex-play').click();
      assert.equal(el('ex-state').textContent,'Paused');
      for(let j=0;j<8;j++){now+=80;instance.update(now);}
      assertNear(mechanics.poses.at(-1).slew,slewNow,0.000001);
      assert.equal(mechanics.distance,trackDistanceAtArrival);
      el('ex-play').click();
      assert.equal(el('ex-state').textContent,'Parking');
    }
  }
}
assert.ok(parkingFrames>=90,'the final 180° slew should take approximately 8 seconds');
assertNear(zoomRadiusAtElevenSeconds,4.15,0.22); // full-machine portrait framing
assertNear(slewAtArrival,0,0.1); // upperstructure must be aligned before parking
assertNear(mechanics.poses.at(-1).slew,-180,0.001); // exact half-turn
assert.ok(Math.abs(Math.sin(mechanics.poses.at(-1).slew*Math.PI/180))<1e-8,
  'final upperstructure axis must be parallel to the track axis');
assert.equal(el('ex-play').textContent,'Replay');
assert.equal(el('excavator-demo-status').textContent,'Route complete · parked');
assert.equal(el('ex-state').textContent,'Parked');
assertNear(rig.position.x,-7.44);
assertNear(rig.position.z,0.72);
const distanceAfterFinish=mechanics.distance;
for(let i=0;i<150;i++){now+=80;instance.update(now);}
assertNear(rig.position.x,-7.44);
assertNear(rig.position.z,0.72);
assert.equal(mechanics.distance,distanceAfterFinish, 'track animation must not reverse after arrival');
const d1=Math.hypot(camera.position.x-rig.position.x,camera.position.z-rig.position.z);
assert.ok(d1<d0, 'cinematic camera should zoom in');
const c0=camera.position.x;
for(let i=0;i<150;i++){now+=80;instance.update(now);}
assert.ok(Math.abs(camera.position.x-c0)>0.2,'cinematic camera should keep orbiting after arrival');
// A wider viewport should move a little closer, without changing playback.
camera.aspect=1.6;
for(let i=0;i<100;i++){now+=80;instance.update(now);}
assertNear(Math.hypot(
  camera.position.x-controls.target.x,
  camera.position.y-controls.target.y,
  camera.position.z-controls.target.z,
),2.85,0.05);

const cameraRelativeAtPark=new Vec().copy(camera.position).sub(rig.position);
const targetRelativeAtPark=new Vec().copy(controls.target).sub(rig.position);
el('ex-play').click();
assertNear(camera.position.x-rig.position.x,cameraRelativeAtPark.x,0.000001);
assertNear(camera.position.z-rig.position.z,cameraRelativeAtPark.z,0.000001);
assertNear(controls.target.x-rig.position.x,targetRelativeAtPark.x,0.000001);
now+=80;instance.update(now);
assert.equal(el('ex-play').textContent,'Pause');
assert.equal(el('ex-state').textContent,'Moving','replay must report moving');
assertNear(rig.position.x,-5.77,0.1);
assertNear(rig.position.z,-11.16,0.1);
assert.ok(Math.abs(mechanics.poses.at(-1).slew)<20,
  'Replay must restore the upperstructure to its normal travel orientation');
// Dragging the camera must interrupt cinematic orbit without interrupting
// follow; subsequent track travel must translate the dragged camera pose.
controls.start();
assert.equal(el('ex-focus').textContent,'Recenter');
camera.position.x+=1.7;
const camOffsetX=camera.position.x-rig.position.x;
const targetOffsetX=controls.target.x-rig.position.x;
for(let i=0;i<40;i++){now+=80;instance.update(now);}
assertNear(camera.position.x-rig.position.x,camOffsetX,0.01);
assertNear(controls.target.x-rig.position.x,targetOffsetX,0.01);
assert.equal(el('ex-focus').textContent,'Recenter','drag must not disengage focus');
el('ex-focus').click();
assert.equal(el('ex-focus').textContent,'Unfollow','explicit recenter should resume cinematic');
const recenterFrom=new Vec().copy(camera.position);
now+=80;instance.update(now);
assert.ok(Math.hypot(camera.position.x-recenterFrom.x,
  camera.position.y-recenterFrom.y,camera.position.z-recenterFrom.z)<0.10,
  'Recenter must start with the current camera pose');
el('ex-play').click();
const beforePause = mechanics.distance;
for(let i=0;i<50;i++){now+=80;instance.update(now);}
assert.equal(mechanics.distance,beforePause, 'tracks must not move while paused');
assert.equal(el('ex-play').textContent,'Play');
assert.equal(el('ex-state').textContent,'Paused');
assert.equal(el('ex-state').attributes['data-state'],'paused');
assert.ok(mechanics.poses.length>3000);
instance.dispose();
assert.equal(controls.handlers.start,undefined,'disposing must unregister drag listener');
console.log('PASS: one-way route, 180-degree clockwise parked slew, pause/resume and Replay reset, smooth intro/recenter, layer isolation and controls.');
