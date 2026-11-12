// EX2000-7 movement demonstration — only imported on /excavator-route.html.
// Route digitised from the owner's yellow markup (1189×885 screenshot).
// Coordinates are the EXISTING SiteNav scene's X/Z system, cross-checked
// against three independently authored traffic routes in data/traffic.json.
// This is a visual, non-operational demonstration. It is not a traffic plan.

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ExcavatorRig } from './excavator-rig.js';

const SCENE_METRES = 12.449; // provisional GPS calibration; scene units are NOT metres
const MODEL_URL = './assets/excavator/EX2000_7_SiteNav_v5.glb';
const RIG_PARAMS_URL = './assets/excavator/params.json';

// Travel in the opposite direction to the first demo: start at the eastern
// yellow-line termination, follow the south of Mining, and finish at Module.
// Reversing the curve also rotates the machine's travel heading by 180°.
const WAYPOINTS = [
  [-7.44,  0.72], [-7.40, -0.10], [-7.36, -2.55],
  [-7.16, -3.18], [-6.58, -3.87], [-5.00, -3.93],
  [-3.52, -3.99], [-2.74, -4.24], [-2.19, -5.18],
  [-1.81, -7.84], [-1.95, -9.93], [-2.47, -11.48],
  [-3.45, -11.94], [-5.30, -12.00], [-5.73, -11.79],
  [-5.77, -11.16],
].reverse();

const OVERLAY_ORDER = 50;
const EXCAVATOR_LAYER = 29; // dedicated final render pass, never in the site's splat pass
const ZOOM_SECONDS = 10; // retain the fast, smooth approach
// Portrait screens need more distance to show the full boom, bucket and tracks
// with breathing room; landscape screens have a much wider horizontal FOV.
const CAMERA_FINAL_RADIUS_PORTRAIT = 4.15;
const CAMERA_FINAL_RADIUS_WIDE = 2.85;
const CAMERA_FOCUS_SECONDS = 5; // glide the target to the travelling chassis
const CAMERA_ORBIT_DELAY_SECONDS = 4; // do not turn the map during initial dolly
const CAMERA_ORBIT_RAMP_SECONDS = 4;
const CAMERA_PITCH_DELAY_SECONDS = 3;
const CAMERA_PITCH_SECONDS = 6;
const CAMERA_FINAL_ELEVATION = 0.62;
const PARK_SLEW_SECONDS = 8;
const ORBIT_RADIANS_PER_SECOND = 0.058;
const smootherstep = value => {
  const t = Math.max(0,Math.min(1,value));
  return t*t*t*(t*(t*6-15)+10);
};

// Portrait phones (320–430 CSS px) get a compact two-row overlay below the
// SiteNav brand/address; wider viewports keep the original desktop panel.
const MOBILE_TOOLBAR_QUERY = '(max-width:600px)';

// All presentation lives in this stylesheet, never in inline style
// attributes, so the mobile media query can override the desktop rules.
const TOOLBAR_CSS = `
  #excavator-route-controls {
    position:fixed;z-index:940;right:16px;top:88px;
    width:min(248px,calc(100vw - 32px));box-sizing:border-box;
    padding:13px 15px;border-radius:12px;
    border:1px solid rgba(255,199,40,.36);
    background:rgba(9,13,19,.91);backdrop-filter:blur(14px);
    -webkit-backdrop-filter:blur(14px);
    box-shadow:0 12px 30px rgba(0,0,0,.32);
    font:12px/1.4 Inter,system-ui,sans-serif;color:#e5e7eb
  }
  #excavator-route-controls .exr-head {display:block}
  #excavator-route-controls .exr-title {font-weight:700;font-size:13px;color:#ffd25c}
  #excavator-route-controls .exr-state {display:none}
  #excavator-route-controls .exr-detail {font-size:11px;margin:6px 0 10px;color:#cbd5e1}
  #excavator-route-controls .exr-row {display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  #excavator-route-controls .exr-speed {display:contents}
  #excavator-route-controls .exr-speed label {font-size:11px}
  #excavator-route-controls .exr-note {font-size:10px;color:#8fa3b5;margin-top:8px}
  #excavator-route-controls button,#excavator-route-controls select {
    border:1px solid rgba(255,255,255,.23);color:#e5e7eb;
    background:#25303d;border-radius:6px;padding:5px 8px;
    font:600 11px Inter,system-ui,sans-serif;cursor:pointer
  }
  #excavator-route-controls button:focus-visible,#excavator-route-controls select:focus-visible {
    outline:2px solid #fbbf24;outline-offset:2px
  }
  @media ${MOBILE_TOOLBAR_QUERY} {
    #excavator-route-controls {
      top:calc(70px + env(safe-area-inset-top, 0px));
      left:calc(10px + env(safe-area-inset-left, 0px));right:auto;
      width:min(320px,calc(100vw - 20px));max-width:calc(100vw - 20px);
      padding:7px 8px 8px;border-radius:12px;
      box-shadow:0 6px 18px rgba(0,0,0,.30)
    }
    #excavator-route-controls .exr-head {
      display:flex;align-items:center;justify-content:space-between;gap:8px;
      min-height:22px;margin:0 2px 6px
    }
    #excavator-route-controls .exr-title {
      font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis
    }
    #excavator-route-controls .exr-state {
      display:inline-flex;align-items:center;gap:5px;flex:none;
      padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.08);
      font:600 11px/16px Inter,system-ui,sans-serif;color:#e5e7eb;white-space:nowrap
    }
    #excavator-route-controls .exr-state::before {
      content:"";width:7px;height:7px;border-radius:50%;background:#94a3b8
    }
    #excavator-route-controls .exr-state[data-state="moving"]::before {background:#4ade80}
    #excavator-route-controls .exr-state[data-state="paused"]::before {background:#fbbf24}
    #excavator-route-controls .exr-state[data-state="parking"]::before {background:#fb923c}
    #excavator-route-controls .exr-state[data-state="parked"]::before {background:#60a5fa}
    #excavator-route-controls .exr-state[data-state="unavailable"]::before {background:#f87171}
    #excavator-route-controls .exr-detail,
    #excavator-route-controls .exr-note {display:none}
    #excavator-route-controls .exr-row {
      display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr) auto;
      gap:6px;flex-wrap:nowrap
    }
    #excavator-route-controls button,#excavator-route-controls select {
      min-height:40px;padding:0 8px;font-size:12px;border-radius:8px;
      white-space:nowrap;touch-action:manipulation
    }
    #excavator-route-controls .exr-speed {
      display:flex;align-items:center;gap:5px;white-space:nowrap
    }
    #excavator-route-controls .exr-speed label {font-size:11px;color:#cbd5e1}
    #excavator-route-controls select {min-width:58px;padding:0 6px}
  }
`;

const ROUTE_STATES = {
  loading:'Loading', moving:'Moving', paused:'Paused',
  parking:'Parking', parked:'Parked', unavailable:'Unavailable',
};

function createToolbar() {
  const wrap = document.createElement('section');
  wrap.id = 'excavator-route-controls';
  wrap.setAttribute('aria-label', 'EX2000-7 excavator route controls');
  // Desktop announces the long status line; mobile hides it (display:none
  // drops it from the accessibility tree) and announces the short state.
  wrap.innerHTML = `
    <div class="exr-head">
      <span class="exr-title">EX2000-7 · Route demo</span>
      <span id="ex-state" class="exr-state" role="status" data-state="loading">Loading</span>
    </div>
    <div id="excavator-demo-status" class="exr-detail" role="status">Loading rig…</div>
    <div class="exr-row" role="group" aria-label="Playback and camera">
      <button id="ex-play" type="button" aria-pressed="false">Pause</button>
      <button id="ex-focus" type="button" aria-pressed="true">Unfollow</button>
      <span class="exr-speed">
        <label for="ex-speed">Speed</label>
        <select id="ex-speed" aria-label="Animation speed">
          <option value="1">1×</option><option value="2" selected>2×</option>
          <option value="5">5×</option>
        </select>
      </span>
    </div>
    <div class="exr-note">
      One-way journey · automatic camera orbit · not an approved vehicle route
    </div>`;
  const style = document.createElement('style');
  style.id = 'excavator-route-controls-style';
  style.textContent = TOOLBAR_CSS;
  document.head.appendChild(style);
  document.body.appendChild(wrap);
  return { wrap, style, status:wrap.querySelector('#excavator-demo-status'),
    state:wrap.querySelector('#ex-state'),
    play:wrap.querySelector('#ex-play'),
    focus:wrap.querySelector('#ex-focus'),
    speed:wrap.querySelector('#ex-speed') };
}

function showRouteState(ui, key, detail) {
  ui.state.textContent = ROUTE_STATES[key];
  ui.state.setAttribute('data-state', key);
  if (detail !== undefined) ui.status.textContent = detail;
}

export async function createExcavatorRoute({THREE,scene,camera,controls,invalidate}) {
  const ui = createToolbar();
  const route = new THREE.CatmullRomCurve3(
    WAYPOINTS.map(([x,z]) => new THREE.Vector3(x,0.075,z)),
    false,'centripetal',
  );
  const pathLength = route.getLength();
  const routeMesh = new THREE.Mesh(
    new THREE.TubeGeometry(route,180,0.028,5,false),
    new THREE.MeshBasicMaterial({
      color:0xffdf4d,transparent:true,opacity:0.86,
      depthTest:true,depthWrite:false,
    }),
  );
  routeMesh.name='OWNER_YELLOW_EXCAVATOR_ROUTE';
  routeMesh.renderOrder=4;
  scene.add(routeMesh);

  const state={rig:null,mechanics:null,progress:0,playing:true,completed:false,
    parking:false,parkSlewElapsed:0,parkSlewStart:0,
    speed:2,lastMs:0,lastYaw:0,resetYaw:true,elapsed:0,
    follow:true,manualCamera:false,cameraElapsed:0,cameraIntroPending:true,
    cameraStartRadius:1,cameraStartAzimuth:0,cameraStartElevation:0};
  const onControlStart=()=>{
    if(!state.follow)return;
    // Keep following the excavator's position while the owner controls the
    // view angle, pan and zoom. Do not reassert the scripted camera pose.
    state.manualCamera=true;
    ui.focus.textContent='Recenter';
  };
  controls.addEventListener('start',onControlStart);
  const focus=()=>{
    if(state.follow&&state.manualCamera){
      state.manualCamera=false;
      state.cameraElapsed=0;
      state.cameraIntroPending=true;
      ui.focus.textContent='Unfollow';
      invalidate();
      return;
    }
    state.follow=!state.follow;
    ui.focus.textContent=state.follow?'Unfollow':'Focus';
    ui.focus.setAttribute('aria-pressed',String(state.follow));
    if(state.follow){
      state.manualCamera=false;
      state.cameraElapsed=0;
      state.cameraIntroPending=true;
      controls.autoRotate=false;
    }
    invalidate();
  };
  ui.focus.addEventListener('click',focus);
  ui.play.addEventListener('click',()=>{
    if(state.completed){
      // Replay relocates the follow camera with the restarted chassis,
      // preserving its relative framing before the gentle zoom begins.
      const replayShift=route.getPointAt(0,new THREE.Vector3()).sub(state.rig.position);
      if(state.follow){
        camera.position.add(replayShift);
        controls.target.add(replayShift);
      }
      state.rig.position.add(replayShift);
      state.progress=0;
      state.completed=false;
      state.parking=false;
      state.parkSlewElapsed=0;
      state.parkSlewStart=0;
      state.elapsed=0;
      state.resetYaw=true;
      state.cameraElapsed=0;
      state.cameraIntroPending=true;
      state.playing=true;
    }else{
      state.playing=!state.playing;
    }
    if(state.rig)showRouteState(
      ui,state.playing?(state.parking?'parking':'moving'):'paused',
      state.parking
        ? (state.playing?'At destination · rotating upperstructure clockwise 180°':'Parking slew paused')
        : (state.playing?'Model loaded · one-way route running':'Playback paused'),
    );
    ui.play.textContent=state.playing?'Pause':'Play';
    ui.play.setAttribute('aria-pressed',String(!state.playing));
    state.lastMs=performance.now();
    invalidate();
  });
  ui.speed.addEventListener('change',()=>{state.speed=Number(ui.speed.value);});

  try {
    const [gltf,paramRes]=await Promise.all([
      new GLTFLoader().loadAsync(MODEL_URL),fetch(RIG_PARAMS_URL),
    ]);
    if(!paramRes.ok)throw new Error(`Rig params HTTP ${paramRes.status}`);
    const params=await paramRes.json();
    const rig=gltf.scene;
    rig.name='EX2000_7_ROUTE_ANIMATED';
    rig.scale.setScalar(1/SCENE_METRES);
    scene.add(rig);
    state.rig=rig;
    // Opus's mechanical adapter solves all four cylinder/linkage positions,
    // and instances the 92 Blender-modelled shoes as two draw calls.
    state.mechanics=new ExcavatorRig(rig,params,{instanceShoes:true});
    // Rendering the model in the same pass as Gaussian splats and transparent
    // traffic arrows produces sorting conflicts even with high renderOrder.
    // Assign the entire rig, including dynamically instanced track shoes, to
    // a dedicated camera layer. It will be drawn in a second, final pass.
    // This preserves the v5 cab glass's genuine 85% transparency and internal depth.
    rig.traverse(object=>{
      object.layers.set(EXCAVATOR_LAYER);
      if(!object.isMesh)return;
      object.renderOrder=OVERLAY_ORDER;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      for(const material of materials){
        if(!material)continue;
        material.depthTest=true;
      }
    });
    // Standard site lighting must illuminate the model in its own layer.
    // Enabling an extra layer does not affect ordinary SiteNav rendering.
    scene.traverse(object=>{if(object.isLight)object.layers.enable(EXCAVATOR_LAYER);});
    controls.autoRotate=false;
    showRouteState(ui,state.playing?'moving':'paused','Model loaded · one-way route running');
  } catch (error) {
    showRouteState(ui,'unavailable','Model unavailable — animation not started');
    console.error('[excavator-route] GLB could not load:',error);
    return {update(){return false;},dispose(){controls.removeEventListener('start',onControlStart);routeMesh.removeFromParent();ui.wrap.remove();ui.style.remove();}};
  }

  const vec=new THREE.Vector3();
  const tan=new THREE.Vector3();
  const travelShift=new THREE.Vector3();
  const orbitPosition=new THREE.Vector3();
  const orbitTarget=new THREE.Vector3();
  const introCameraStart=new THREE.Vector3();
  const introTargetStart=new THREE.Vector3();
  const introRigStart=new THREE.Vector3();
  const introCameraOffset=new THREE.Vector3();
  const introTravel=new THREE.Vector3();
  const blendedTarget=new THREE.Vector3();
  const update=ms=>{
    const dt=state.lastMs ? Math.min((ms-state.lastMs)/1000,0.08) : 0;
    state.lastMs=ms;
    if(!state.rig)return false;
    const driving=state.playing&&!state.completed&&!state.parking;
    const requestedMetres=driving?dt*1.1667*state.speed:0; // 4.2 km/h at 1× (demo rate)
    const remainingMetres=(1-state.progress)*pathLength*SCENE_METRES;
    const travelMetres=Math.min(requestedMetres,remainingMetres);
    state.progress=Math.min(1,state.progress+travelMetres/(pathLength*SCENE_METRES));
    if(driving&&state.progress>=1){
      // Keep the chassis/track heading fixed while slewing only the house.
      // It travels at 0° relative to the tracks, so a clockwise -180° finish
      // is both an exact half-turn and precisely aligned with the tracks.
      state.parking=true;
      state.parkSlewElapsed=0;
      state.parkSlewStart=0;
      showRouteState(ui,'parking','At destination · rotating upperstructure clockwise 180°');
    }
    const t=state.progress;
    route.getPointAt(t,vec);
    route.getTangentAt(t,tan).normalize();
    travelShift.copy(vec).sub(state.rig.position);
    state.rig.position.copy(vec);
    const yaw=-Math.atan2(tan.z,tan.x);
    state.rig.rotation.set(0,yaw,0);
    if(state.follow){
      if(state.manualCamera){
        // An interactive orbit must remain entirely under OrbitControls.
        // Only translate the user's chosen pose along with the chassis.
        camera.position.add(travelShift);
        controls.target.add(travelShift);
      }else{
        if(state.cameraIntroPending){
          // Capture the real SiteNav viewing direction. Changing azimuth to
          // chassis yaw here rotated the *entire* splat map on mobile.
          introCameraStart.copy(camera.position);
          introTargetStart.copy(controls.target);
          introRigStart.copy(vec);
          introCameraOffset.copy(introCameraStart).sub(introTargetStart);
          const horizontal=Math.hypot(introCameraOffset.x,introCameraOffset.z);
          state.cameraStartRadius=Math.max(0.1,Math.hypot(
            horizontal,introCameraOffset.y,
          ));
          state.cameraStartAzimuth=horizontal>0.001
            ? Math.atan2(introCameraOffset.x,introCameraOffset.z)
            : yaw+0.45;
          state.cameraStartElevation=Math.atan2(introCameraOffset.y,horizontal);
          state.cameraIntroPending=false;
        }
        state.cameraElapsed+=dt;
        const zoom=smootherstep(state.cameraElapsed/ZOOM_SECONDS);
        const aspect=Number.isFinite(camera.aspect)?camera.aspect:1.6;
        const portraitWeight=1-smootherstep((aspect-0.55)/0.85);
        const finalRadius=THREE.MathUtils.lerp(
          CAMERA_FINAL_RADIUS_WIDE,CAMERA_FINAL_RADIUS_PORTRAIT,portraitWeight,
        );
        const radius=THREE.MathUtils.lerp(state.cameraStartRadius,finalRadius,zoom);
        const pitch=smootherstep(
          (state.cameraElapsed-CAMERA_PITCH_DELAY_SECONDS)/CAMERA_PITCH_SECONDS,
        );
        const elevation=THREE.MathUtils.lerp(
          state.cameraStartElevation,CAMERA_FINAL_ELEVATION,pitch,
        );
        // Hold the original compass heading through the initial zoom; only
        // begin a slow, accelerated orbit once the excavator is in view.
        const orbitElapsed=Math.max(0,state.cameraElapsed-CAMERA_ORBIT_DELAY_SECONDS);
        const orbitPhase=ORBIT_RADIANS_PER_SECOND*(
          orbitElapsed-CAMERA_ORBIT_RAMP_SECONDS*(
            1-Math.exp(-orbitElapsed/CAMERA_ORBIT_RAMP_SECONDS)
          )
        );
        const azimuth=state.cameraStartAzimuth+orbitPhase;
        orbitTarget.set(vec.x,vec.y+0.30,vec.z);
        // Translate both the focus and camera together. Keeping their relative
        // vector intact eliminates the original hard pan/rotation at startup.
        introTravel.copy(vec).sub(introRigStart);
        blendedTarget.copy(introTargetStart).add(introTravel).lerp(
          orbitTarget,smootherstep(state.cameraElapsed/CAMERA_FOCUS_SECONDS),
        );
        const horizontalRadius=radius*Math.cos(elevation);
        orbitPosition.set(
          blendedTarget.x+Math.sin(azimuth)*horizontalRadius,
          blendedTarget.y+radius*Math.sin(elevation),
          blendedTarget.z+Math.cos(azimuth)*horizontalRadius,
        );
        const smoothing=1-Math.exp(-dt*1.8);
        controls.target.lerp(blendedTarget,smoothing);
        camera.position.lerp(orbitPosition,smoothing);
      }
      controls.update();
    }
    if(state.resetYaw){state.lastYaw=yaw;state.resetYaw=false;}
    const yawDelta=Math.atan2(Math.sin(yaw-state.lastYaw),Math.cos(yaw-state.lastYaw));
    const turnDiff=driving?Math.max(-0.18,Math.min(0.18,yawDelta*2.41)):0;
    if(travelMetres>0)state.mechanics.drive(travelMetres+turnDiff,travelMetres-turnDiff);
    state.lastYaw=yaw;
    if(state.playing)state.elapsed+=dt;
    let slew=0; // house stays aligned with the tracks during travel
    if(state.parking){
      if(state.playing){
        state.parkSlewElapsed=Math.min(PARK_SLEW_SECONDS,state.parkSlewElapsed+dt);
      }
      slew=THREE.MathUtils.lerp(
        state.parkSlewStart,-180,
        smootherstep(state.parkSlewElapsed/PARK_SLEW_SECONDS),
      );
      if(state.parkSlewElapsed>=PARK_SLEW_SECONDS){
        state.parking=false;
        state.completed=true;
        state.playing=false;
        ui.play.textContent='Replay';
        ui.play.setAttribute('aria-pressed','false');
        showRouteState(ui,'parked','Route complete · parked');
      }
    }else if(state.completed){
      // Exact track-parallel, rearward house alignment, held indefinitely.
      slew=-180;
    }
    state.mechanics.setPose({
      slew,
      boom:22,
      stick:-122,
      bucket:0,
    });
    return state.playing||state.follow;
  };
  const renderOverlay=renderer=>{
    if(!state.rig)return;
    const originalMask=camera.layers.mask;
    const originalAutoClear=renderer.autoClear;
    try{
      renderer.autoClear=false;
      renderer.clearDepth();
      camera.layers.set(EXCAVATOR_LAYER);
      renderer.render(scene,camera);
    }finally{
      camera.layers.mask=originalMask;
      renderer.autoClear=originalAutoClear;
    }
  };
  update(performance.now());
  return {update,renderOverlay,dispose(){controls.removeEventListener('start',onControlStart);routeMesh.removeFromParent();state.rig?.removeFromParent();ui.wrap.remove();ui.style.remove();}};
}
