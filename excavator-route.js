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

// Travel from the Module/Workshop lane, around the Mining workshop's south
// and eastern sides, ending at the marked eastern yellow-line termination.
const WAYPOINTS = [
  [-7.44,  0.72], [-7.40, -0.10], [-7.36, -2.55],
  [-7.16, -3.18], [-6.58, -3.87], [-5.00, -3.93],
  [-3.52, -3.99], [-2.74, -4.24], [-2.19, -5.18],
  [-1.81, -7.84], [-1.95, -9.93], [-2.47, -11.48],
  [-3.45, -11.94], [-5.30, -12.00], [-5.73, -11.79],
  [-5.77, -11.16],
];

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
      <button id="ex-focus" type="button">Focus</button>
      <button id="ex-work" type="button" aria-pressed="false">Dig cycle</button>
      <label for="ex-speed" style="font-size:11px">Speed</label>
      <select id="ex-speed" aria-label="Animation speed">
        <option value="1">1×</option><option value="5">5×</option>
        <option value="10" selected>10×</option>
      </select>
    </div>
    <div style="font-size:10px;color:#8fa3b5;margin-top:8px">
      Illustrative back-and-forth movement · not an approved vehicle route
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
  scene.add(routeMesh);

  const state={rig:null,mechanics:null,progress:0,dir:1,playing:true,
    speed:10,lastMs:0,lastYaw:0,elapsed:0,work:false,follow:false};
  const focus=()=>{
    state.follow=!state.follow;
    ui.focus.textContent=state.follow?'Unfollow':'Focus';
    ui.focus.setAttribute('aria-pressed',String(state.follow));
    if(state.follow){
      const p=state.rig?.position ?? new THREE.Vector3(-4.7,0,-6.4);
      controls.autoRotate=false;
      controls.target.set(p.x,p.y+0.23,p.z);
      camera.position.set(p.x+1.8,p.y+1.65,p.z+2.2);
      controls.update();
    }
    invalidate();
  };
  ui.focus.addEventListener('click',focus);
  ui.play.addEventListener('click',()=>{
    state.playing=!state.playing;
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
    ui.status.textContent=state.work?'Digging · cylinders articulated':'Model loaded · route animation running';
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
    ui.status.textContent='Model loaded · route animation running';
  } catch (error) {
    ui.status.textContent='Model unavailable — animation not started';
    console.error('[excavator-route] GLB could not load:',error);
    return {update(){return false;},dispose(){routeMesh.removeFromParent();ui.wrap.remove();}};
  }

  const vec=new THREE.Vector3();
  const tan=new THREE.Vector3();
  const update=ms=>{
    const dt=state.lastMs ? Math.min((ms-state.lastMs)/1000,0.08) : 0;
    state.lastMs=ms;
    if (!state.playing || !state.rig) return false;
    const travelMetres=state.work?0:dt*0.5833*state.speed; // 2.1 km/h nominal travel, user-selectable demo speed
    const distanceFraction=travelMetres/(pathLength*SCENE_METRES);
    state.progress+=state.dir*distanceFraction;
    if (state.progress>=1){state.progress=2-state.progress;state.dir=-1;}
    if (state.progress<=0){state.progress=-state.progress;state.dir=1;}
    const t=Math.max(0,Math.min(1,state.progress));
    route.getPointAt(t,vec);
    route.getTangentAt(t,tan).normalize();
    state.rig.position.copy(vec);
    if(state.follow){
      controls.target.set(vec.x,vec.y+0.23,vec.z);
      camera.position.set(vec.x+1.8,vec.y+1.65,vec.z+2.2);
      controls.update();
    }
    const yaw=-Math.atan2(tan.z,tan.x);
    state.rig.rotation.set(0,yaw,0);
    // Opposite shoe phase during reverse travel; both tracks visibly travel
    // rather than merely spinning their rollers.
    // Bottom shoe run moves opposite the machine's ground travel.
    const travelSigned=-state.dir*travelMetres;
    const yawDelta=Math.atan2(Math.sin(yaw-state.lastYaw),Math.cos(yaw-state.lastYaw));
    const turnDiff=Math.max(-0.18,Math.min(0.18,yawDelta*2.41));
    state.mechanics.drive(-(travelSigned-turnDiff),-(travelSigned+turnDiff));
    state.lastYaw=yaw;
    state.elapsed+=dt;
    const phase=state.elapsed*(state.work?0.75:0.26);
    state.mechanics.setPose({
      slew:(state.work?35:14)*Math.sin(phase),
      boom:state.work?26+10*Math.sin(phase):22,
      stick:state.work?-120+17*Math.sin(phase-0.8):-122,
      bucket:state.work?5+19*Math.sin(phase-1.6):0,
    });
    return true;
  };
  update(performance.now());
  return {update,dispose(){routeMesh.removeFromParent();state.rig?.removeFromParent();ui.wrap.remove();}};
}
