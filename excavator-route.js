// EX2000-7 movement demonstration — only imported on /excavator-route.html.
// Route digitised from the owner's yellow markup (1189×885 screenshot).
// Coordinates are the EXISTING SiteNav scene's X/Z system, cross-checked
// against three independently authored traffic routes in data/traffic.json.
// This is a visual, non-operational demonstration. It is not a traffic plan.

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ExcavatorRig } from './excavator-rig.js';

const SCENE_METRES = 12.449; // provisional GPS calibration; scene units are NOT metres
const MODEL_URL = './assets/excavator/EX2000_7_SiteNav_v2.glb';
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

const OVERLAY_ORDER = 50; // splat=1; traffic arrows=3; keep the excavator in front
const ZOOM_SECONDS = 18;
const ORBIT_RADIANS_PER_SECOND = 0.058;

function createToolbar() {
  const wrap = document.createElement('section');
  wrap.id = 'excavator-route-controls';
  wrap.setAttribute('aria-label', 'Excavator route controls');
  wrap.style.cssText = [
    'position:fixed;z-index:940;right:16px;top:88px',
    'width:min(248px,calc(100vw - 32px));box-sizing:border-box',
    'padding:13px 15px;border-radius:12px',
    'border:1px solid rgba(255,199,40,.36)',
    'background:rgba(9,13,19,.91);backdrop-filter:blur(14px)',
    'box-shadow:0 12px 30px rgba(0,0,0,.32)',
    'font:12px/1.4 Inter,system-ui,sans-serif;color:#e5e7eb',
  ].join(';');
  wrap.innerHTML = `
    <div style="font-weight:700;font-size:13px;color:#ffd25c">EX2000-7 · Route demo</div>
    <div id="excavator-demo-status" role="status" style="font-size:11px;margin:6px 0 10px;color:#cbd5e1">Loading rig…</div>
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      <button id="ex-play" type="button" aria-pressed="false">Pause</button>
      <button id="ex-focus" type="button" aria-pressed="true">Unfollow</button>
      <button id="ex-work" type="button" aria-pressed="false">Dig cycle</button>
      <label for="ex-speed" style="font-size:11px">Speed</label>
      <select id="ex-speed" aria-label="Animation speed">
        <option value="1" selected>1×</option><option value="2">2×</option>
        <option value="5">5×</option>
      </select>
    </div>
    <div style="font-size:10px;color:#8fa3b5;margin-top:8px">
      One-way journey · automatic camera orbit · not an approved vehicle route
    </div>`;
  const style = document.createElement('style');
  style.textContent = `
    #excavator-route-controls button,#excavator-route-controls select {
      border:1px solid rgba(255,255,255,.23);color:#e5e7eb;
      background:#25303d;border-radius:6px;padding:5px 8px;
      font:600 11px Inter,system-ui,sans-serif;cursor:pointer
    }
    #excavator-route-controls button:focus-visible,#excavator-route-controls select:focus-visible {
      outline:2px solid #fbbf24;outline-offset:2px
    }
    @media(max-width:760px){#excavator-route-controls {top:70px;right:10px;width:210px}}
  `;
  document.head.appendChild(style);
  document.body.appendChild(wrap);
  return { wrap, status:wrap.querySelector('#excavator-demo-status'),
    play:wrap.querySelector('#ex-play'),
    focus:wrap.querySelector('#ex-focus'),
    work:wrap.querySelector('#ex-work'),
    speed:wrap.querySelector('#ex-speed') };
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
    speed:1,lastMs:0,lastYaw:0,resetYaw:true,elapsed:0,work:false,
    follow:true,cameraElapsed:0};
  const focus=()=>{
    state.follow=!state.follow;
    ui.focus.textContent=state.follow?'Unfollow':'Focus';
    ui.focus.setAttribute('aria-pressed',String(state.follow));
    if(state.follow){
      state.cameraElapsed=0;
      controls.autoRotate=false;
    }
    invalidate();
  };
  ui.focus.addEventListener('click',focus);
  ui.play.addEventListener('click',()=>{
    if(state.completed){
      state.progress=0;
      state.completed=false;
      state.resetYaw=true;
      state.work=false;
      ui.work.textContent='Dig cycle';
      ui.work.setAttribute('aria-pressed','false');
      ui.status.textContent='Model loaded · one-way route running';
      state.playing=true;
    }else{
      state.playing=!state.playing;
    }
    ui.play.textContent=state.playing?'Pause':'Play';
    ui.play.setAttribute('aria-pressed',String(!state.playing));
    state.lastMs=performance.now();
    invalidate();
  });
  ui.speed.addEventListener('change',()=>{state.speed=Number(ui.speed.value);});
  ui.work.addEventListener('click',()=>{
    state.work=!state.work;
    ui.work.textContent=state.work?'Resume travel':'Dig cycle';
    ui.work.setAttribute('aria-pressed',String(state.work));
    ui.status.textContent=state.work?'Digging · cylinders articulated':state.completed?'Route complete · parked':'Model loaded · one-way route running';
    invalidate();
  });

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
    // Three.js draws opaque GLB meshes before transparent Gaussian splats,
    // irrespective of renderOrder. Move the model to the transparent queue
    // (full opacity preserved), after splats and traffic overlays. Retain
    // depth testing/writes for realistic self-occlusion and ground contact.
    rig.traverse(object=>{
      if(!object.isMesh)return;
      object.renderOrder=OVERLAY_ORDER;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      for(const material of materials){
        if(!material)continue;
        material.transparent=true;
        material.depthTest=true;
        if(material.opacity===1)material.depthWrite=true;
        material.needsUpdate=true;
      }
    });
    controls.autoRotate=false;
    ui.status.textContent='Model loaded · one-way route running';
  } catch (error) {
    ui.status.textContent='Model unavailable — animation not started';
    console.error('[excavator-route] GLB could not load:',error);
    return {update(){return false;},dispose(){routeMesh.removeFromParent();ui.wrap.remove();}};
  }

  const vec=new THREE.Vector3();
  const tan=new THREE.Vector3();
  const orbitPosition=new THREE.Vector3();
  const orbitTarget=new THREE.Vector3();
  const update=ms=>{
    const dt=state.lastMs ? Math.min((ms-state.lastMs)/1000,0.08) : 0;
    state.lastMs=ms;
    if(!state.rig)return false;
    const driving=state.playing&&!state.work&&!state.completed;
    const requestedMetres=driving?dt*1.1667*state.speed:0; // 4.2 km/h at 1× (demo rate)
    const remainingMetres=(1-state.progress)*pathLength*SCENE_METRES;
    const travelMetres=Math.min(requestedMetres,remainingMetres);
    state.progress=Math.min(1,state.progress+travelMetres/(pathLength*SCENE_METRES));
    if(driving&&state.progress>=1){
      state.completed=true;
      state.playing=false;
      ui.play.textContent='Replay';
      ui.play.setAttribute('aria-pressed','false');
      ui.status.textContent='Route complete · parked';
    }
    const t=state.progress;
    route.getPointAt(t,vec);
    route.getTangentAt(t,tan).normalize();
    state.rig.position.copy(vec);
    if(state.follow){
      state.cameraElapsed+=dt;
      const u=Math.min(1,state.cameraElapsed/ZOOM_SECONDS);
      const eased=u*u*(3-2*u);
      const radius=THREE.MathUtils.lerp(5.6,1.95,eased);
      const azimuth=0.65+state.cameraElapsed*ORBIT_RADIANS_PER_SECOND;
      orbitTarget.set(vec.x,vec.y+0.30,vec.z);
      orbitPosition.set(
        vec.x+Math.sin(azimuth)*radius,
        vec.y+0.92+radius*0.29,
        vec.z+Math.cos(azimuth)*radius,
      );
      const smoothing=1-Math.exp(-dt*1.7);
      controls.target.lerp(orbitTarget,smoothing);
      camera.position.lerp(orbitPosition,smoothing);
      controls.update();
    }
    const yaw=-Math.atan2(tan.z,tan.x);
    state.rig.rotation.set(0,yaw,0);
    if(state.resetYaw){state.lastYaw=yaw;state.resetYaw=false;}
    const yawDelta=Math.atan2(Math.sin(yaw-state.lastYaw),Math.cos(yaw-state.lastYaw));
    const turnDiff=driving?Math.max(-0.18,Math.min(0.18,yawDelta*2.41)):0;
    if(travelMetres>0)state.mechanics.drive(travelMetres+turnDiff,travelMetres-turnDiff);
    state.lastYaw=yaw;
    if(state.playing||state.work)state.elapsed+=dt;
    const phase=state.elapsed*(state.work?0.75:0.26);
    state.mechanics.setPose({
      slew:(state.work?35:14)*Math.sin(phase),
      boom:state.work?26+10*Math.sin(phase):22,
      stick:state.work?-120+17*Math.sin(phase-0.8):-122,
      bucket:state.work?5+19*Math.sin(phase-1.6):0,
    });
    return state.playing||state.work||state.follow;
  };
  update(performance.now());
  return {update,dispose(){routeMesh.removeFromParent();state.rig?.removeFromParent();ui.wrap.remove();}};
}
