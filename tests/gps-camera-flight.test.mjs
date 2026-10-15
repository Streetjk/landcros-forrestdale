import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {planPinCameraFlight, samplePinCameraFlight, PIN_VIEW_ANGLE_DEG, PIN_ORBIT_SPEED} from '../pin-camera-flight.js';

const source = readFileSync(new URL('../viewer3d.js', import.meta.url), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const focus = section('let _pinFocusFlight = null;', 'window._syncRotateBtn =');
const gps = section('function _centreCameraOnGps(', 'function _clearGpsMarker(');
const gpsStop = section('function _stopGpsTracking(', 'function _onGpsFix(');

function makeHarness() {
  const cameraPosition = {x:30,y:20,z:35,set(x,y,z){Object.assign(this,{x,y,z});}};
  const lookTarget = {x:0,y:0,z:0,set(x,y,z){Object.assign(this,{x,y,z});}};
  const camera = {position:cameraPosition,lookAt(){}};
  const controls = {
    target:lookTarget,enabled:true,autoRotate:false,
    getAzimuthalAngle(){return 0;},update(){},
    addEventListener(){},removeEventListener(){},
  };
  const element = {addEventListener(){},removeEventListener(){}};
  const tweens = [];
  const cleared = [];
  const context = vm.createContext({
    camera,controls,renderer:{domElement:element},
    THREE:{Vector3:class {constructor(x,y,z){Object.assign(this,{x,y,z});}}},
    planPinCameraFlight,samplePinCameraFlight,PIN_VIEW_ANGLE_DEG,PIN_ORBIT_SPEED,
    gsap:{to(progress,options){
      const tween={killed:false,kill(){this.killed=true;},
        advance(t){if(this.killed)return; progress.t=t;options.onUpdate();if(t===1)options.onComplete();}};
      tweens.push(tween);return tween;
    }},
    window:{innerWidth:900,matchMedia:()=>({matches:false}),
      addEventListener(){},removeEventListener(){}},
    document:{getElementById:()=>null,addEventListener(){},removeEventListener(){}},
    navigator:{geolocation:{clearWatch:id=>cleared.push(id)}},
    clearTimeout(){},
    stopAutoOrbit(){controls.autoRotate=false;},
    _cancelActiveTour(){},
    _clearGpsMarker(){},_syncGpsLocateButton(){},_showGpsStatus(){},
  });
  vm.runInContext(`let _camTween=null,_camAnimating=false,_idleFrames=0,_lastRenderMs=0;
    let _suppressLateSplatIntro=false,_orbitActive=false;
    const _orbitTarget={copy(){}};
    let _gpsWatchGeneration=0,_gpsWatchStarting=false,_gpsWatchId=3,_gpsErrorTimeout=null;
    let _gpsLastScenePosition=null,_gpsLastRenderedAt=-1,_gpsLastAccuracy=Infinity,
      _gpsAccuracyMetres=null,_gpsFirstCentered=false;`,context);
  vm.runInContext(focus+gps+gpsStop,context);
  return {context,controls,cameraPosition,lookTarget,tweens,cleared};
}

const coords = obj => ({x:obj.x,y:obj.y,z:obj.z});

test('GPS starts a genuine pin-style flight without a sudden camera jump or orbit',()=>{
  const h=makeHarness();
  const start=coords(h.cameraPosition);
  const target=coords(h.lookTarget);
  assert.equal(vm.runInContext('_centreCameraOnGps({x:75,z:-40})',h.context),true);
  assert.deepEqual(coords(h.cameraPosition),start,'activation must not teleport');
  assert.deepEqual(coords(h.lookTarget),target,'target must not teleport');
  assert.equal(h.tweens.length,1);
  assert.equal(h.controls.enabled,false);
  const flight=h.tweens[0];
  flight.advance(0.5);
  assert.notDeepEqual(coords(h.cameraPosition),start,'camera must interpolate');
  assert.ok(h.lookTarget.x>0 && h.lookTarget.x<75);
  flight.advance(1);
  assert.ok(Math.abs(h.lookTarget.x-75)<1e-8);
  assert.ok(Math.abs(h.lookTarget.z+40)<1e-8);
  assert.equal(h.controls.enabled,true);
  assert.equal(h.controls.autoRotate,false,'GPS does not auto-orbit');
});

test('disabling tracking interrupts only its own camera flight',()=>{
  const h=makeHarness();
  vm.runInContext('_centreCameraOnGps({x:75,z:-40})',h.context);
  const flight=h.tweens[0];
  flight.advance(0.3);
  const stoppedPose=coords(h.cameraPosition);
  vm.runInContext('_stopGpsTracking(true)',h.context);
  assert.equal(flight.killed,true);
  assert.equal(h.controls.enabled,true);
  assert.deepEqual(h.cleared,[3]);
  flight.advance(1);
  assert.deepEqual(coords(h.cameraPosition),stoppedPose,'cancelled flight must not resume');
});

test('turning off GPS does not interrupt a newer drop-pin flight',()=>{
  const h=makeHarness();
  vm.runInContext('_centreCameraOnGps({x:75,z:-40})',h.context);
  assert.equal(vm.runInContext('_focusPinCamera(new THREE.Vector3(12,0,8))',h.context),true);
  const pinFlight=h.tweens[1];
  assert.equal(h.tweens[0].killed,true,'pin focus supersedes GPS');
  vm.runInContext('_stopGpsTracking(true)',h.context);
  assert.equal(pinFlight.killed,false,'GPS only owns its own tween');
  pinFlight.advance(1);
  assert.equal(h.controls.autoRotate,true,'drop-pin orbit still completes');
});

test('GPS first fix centres once, subsequent watch fixes update only the marker',()=>{
  const gpsFix = section('function _onGpsFix(', 'function _onGpsError(');
  assert.match(gpsFix,/if \(!_gpsFirstCentered\)\s*\{\s*_gpsFirstCentered = true;\s*_centreCameraOnGps\(position\)/);
  assert.match(gpsFix,/_renderCurrentGpsPosition\(position, safeAccuracy, calibration\)/);
});
