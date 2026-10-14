import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planPinCameraFlight,samplePinCameraFlight,pinCameraEase,
  PIN_VIEW_ANGLE_DEG,PIN_ORBIT_SPEED,
} from '../pin-camera-flight.js';

const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const cases=[
  {name:'overhead',camera:{x:0,y:65,z:0},target:{x:0,y:0,z:0}},
  {name:'nearly vertical',camera:{x:0.00001,y:35,z:0.00001},target:{x:0,y:0,z:0}},
  {name:'far north',camera:{x:0,y:8,z:-70},target:{x:0,y:0,z:0}},
  {name:'far south',camera:{x:0,y:8,z:72},target:{x:0,y:0,z:0}},
  {name:'far east',camera:{x:75,y:1,z:0},target:{x:0,y:0,z:0}},
  {name:'far west',camera:{x:-75,y:2,z:0},target:{x:0,y:0,z:0}},
  {name:'very close',camera:{x:1,y:0.6,z:-1},target:{x:1,y:0,z:-1}},
  {name:'diagonal',camera:{x:38,y:17,z:-22},target:{x:22,y:1,z:-18}},
  {name:'outside model',camera:{x:280,y:200,z:450},target:{x:80,y:5,z:90}},
  {name:'behind site',camera:{x:-200,y:15,z:-180},target:{x:10,y:0,z:10}},
  {name:'rotated local',camera:{x:30,y:25,z:5},target:{x:25,y:0,z:19}},
];

test('all starting positions and bearings yield finite, continuous, smooth flights',()=>{
  const pin={x:9,y:0,z:-12};
  assert.equal(PIN_VIEW_ANGLE_DEG,45);
  assert.ok(PIN_ORBIT_SPEED<0.5);
  for(const c of cases){
    const plan=planPinCameraFlight({...c,pin,viewRadius:11});
    assert.ok(plan,c.name);
    assert.ok(plan.duration>=1.45&&plan.duration<=2.85);
    const first=samplePinCameraFlight(plan,0), last=samplePinCameraFlight(plan,1);
    assert.deepEqual(first,{camera:c.camera,target:c.target},c.name+' exact starting pose');
    assert.ok(dist(last.target,pin)<1e-9,c.name+' target final');
    assert.ok(Math.abs(dist(last.camera,pin)-11)<1e-7,c.name+' radius');
    const elevation=Math.atan2(last.camera.y-pin.y,Math.hypot(last.camera.x-pin.x,last.camera.z-pin.z))*180/Math.PI;
    assert.ok(Math.abs(elevation-45)<1e-7,c.name+' fixed angle');
    let previous=first,previousTargetDistance=dist(first.target,pin);
    for(let i=1;i<=100;i++){
      const next=samplePinCameraFlight(plan,i/100);
      for(const axis of ['x','y','z']) {
        assert.ok(Number.isFinite(next.camera[axis])&&Number.isFinite(next.target[axis]),c.name+' '+i+' '+axis);
      }
      const td=dist(next.target,pin);
      assert.ok(td<=previousTargetDistance+1e-7,c.name+' target cannot drift away');
      assert.ok(dist(next.camera,previous.camera)<15,c.name+' no teleportation');
      previousTargetDistance=td;
      previous=next;
    }
    assert.ok(dist(previous.camera,last.camera)<1e-8);
  }
});

test('ease has zero endpoint velocity and accelerations, no overshoot',()=>{
  assert.equal(pinCameraEase(-1),0);
  assert.equal(pinCameraEase(0),0);
  assert.equal(pinCameraEase(1),1);
  assert.equal(pinCameraEase(5),1);
  assert.equal(pinCameraEase(0.5),0.5);
  const epsilon=0.001;
  assert.ok(pinCameraEase(epsilon)<1e-7);
  assert.ok(1-pinCameraEase(1-epsilon)<1e-7);
  let last=0;
  for(let i=1;i<=100;i++){const t=pinCameraEase(i/100);assert.ok(t>=last&&t<=1);last=t;}
});

test('preserves the original horizontal bearing and never forces a fixed compass direction',()=>{
  const pin={x:40,y:0,z:-30};
  for(const c of cases.filter(x=>Math.hypot(x.camera.x-x.target.x,x.camera.z-x.target.z)>.001)){
    const p=planPinCameraFlight({...c,pin});
    const end=samplePinCameraFlight(p,1);
    const startAz=Math.atan2(c.camera.x-c.target.x,c.camera.z-c.target.z);
    const finishAz=Math.atan2(end.camera.x-pin.x,end.camera.z-pin.z);
    assert.ok(Math.abs(Math.atan2(Math.sin(finishAz-startAz),Math.cos(finishAz-startAz)))<1e-6,c.name);
  }
});

test('fails closed on degenerate/nonfinite camera parameters',()=>{
  const point={x:0,y:0,z:0};
  assert.equal(planPinCameraFlight({camera:point,target:point,pin:point}),null);
  assert.equal(planPinCameraFlight({camera:{x:NaN,y:4,z:0},target:point,pin:point}),null);
  assert.equal(planPinCameraFlight({camera:point,target:{x:4,y:2,z:0},pin:{x:0,y:Infinity,z:0}}),null);
  assert.equal(samplePinCameraFlight(null,0.5),null);
});

test('zero-horizontal starting camera uses fallback bearing instead of NaN',()=>{
 const plan=planPinCameraFlight({
   camera:{x:0,y:40,z:0},target:{x:0,y:0,z:0},
   pin:{x:30,y:0,z:-30},orbitAzimuth:Math.PI/3});
 assert.ok(plan);
 assert.ok(Math.abs(plan.from.theta-Math.PI/3)<1e-10);
 const last=samplePinCameraFlight(plan,1);
 assert.ok(Number.isFinite(last.camera.x));
});
