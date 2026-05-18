// 3D Gaussian Splat viewer — Spark.js + Three.js + GSAP
// See Phase 7 of the implementation plan for full feature spec.
// This file scaffolds the renderer and pin system; nav fly-through follows in Phase 7.5.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Sky } from 'three/addons/objects/Sky.js';

// ── Site config (loaded from data/config.json in boot()) ──────────────────
let _cfg = {};

// ── Coord conversion ───────────────────────────────────────────────────────
// Maps lat/lng to Three.js scene coords using site bounds.
// pos3d on buildings/roads overrides this when set manually.
let _sceneBounds = null;
let _planeGroup  = null;
async function _getBounds() {
  if (_sceneBounds) return _sceneBounds;
  const r = await fetch('./assets/site-map-bounds.json');
  _sceneBounds = await r.json();
  return _sceneBounds;
}
async function latlngToScene(lat, lng) {
  const { bounds } = await _getBounds();
  const [sw, ne] = bounds;
  const x = ((lng - sw[1]) / (ne[1] - sw[1]) - 0.5) * 40;
  const z = -((lat - sw[0]) / (ne[0] - sw[0]) - 0.5) * 30;
  return { x, y: 0, z };
}

// ── Scene setup ────────────────────────────────────────────────────────────

const canvas = document.getElementById('three-canvas');
const labelsWrap = document.getElementById('labels-wrap');

// ── Device quality tier ────────────────────────────────────────────────────
// Detected synchronously before renderer creation so antialias/pixelRatio
// are set once and never changed. LOW = save battery/network; HIGH = best quality.
const _Q = (() => {
  const mem   = navigator.deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  const conn  = navigator.connection?.effectiveType ?? '4g';
  const save  = navigator.connection?.saveData ?? false;
  const px    = window.devicePixelRatio ?? 1;
  // Tier is hardware-only — network speed doesn't reduce visual quality.
  // A good phone on 2G stays high-tier; it just skips the heavy splat download.
  let tier = 'high';
  if (mem <= 2 || cores <= 2) tier = 'low';
  else if (mem <= 4 || cores <= 4) tier = 'medium';
  const slowNet = save || conn === 'slow-2g' || conn === '2g';
  return {
    tier,
    skipSplat:    slowNet,
    antialias:    tier === 'high',
    pixelRatio:   tier === 'high' ? Math.min(px, 1.5) : tier === 'medium' ? Math.min(px, 1.2) : 1.0,
    sky:          tier !== 'low' || !slowNet,
    soilPBR:      tier !== 'low',
    scenery:      tier !== 'low',
    idleAfter:    tier === 'low' ? 20 : tier === 'medium' ? 35 : 45,
    idleInterval: tier === 'low' ? 200 : tier === 'medium' ? 120 : 100,
    roadSegs:     tier === 'low' ? 2 : tier === 'medium' ? 3 : 4,
    toneMapping:  tier === 'low' ? THREE.LinearToneMapping : THREE.ACESFilmicToneMapping,
  };
})();

const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: _Q.antialias });
renderer.setPixelRatio(_Q.pixelRatio);
renderer.toneMapping = _Q.toneMapping;
renderer.toneMappingExposure = 0.6;
renderer.setClearColor(0x0f1117, 1); // match app background so pre-sky frames aren't flash-black

// On low-tier devices remove expensive backdrop-filter blurs (GPU compositing cost)
if (_Q.tier === 'low') {
  const s = document.createElement('style');
  s.textContent = '* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }';
  document.head.appendChild(s);
}

const css2d = new CSS2DRenderer();
css2d.domElement.style.position = 'absolute';
css2d.domElement.style.inset = '0';
css2d.domElement.style.pointerEvents = 'none';
labelsWrap.appendChild(css2d.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;   // lower = more momentum / smoother coast
controls.rotateSpeed   = 0.35;
controls.zoomSpeed     = 0.8;
controls.panSpeed      = 0.7;
controls.minDistance = 3;
controls.maxDistance = 80;
controls.maxPolarAngle = THREE.MathUtils.degToRad(85);
// Stop auto-orbit the moment the user grabs the camera
controls.addEventListener('start', stopAutoOrbit);

// Initial camera — overhead
camera.position.set(0.00, 26.60, 0.00);
controls.target.set(0.00, 0.00, 0.00);
controls.update();

const _debugMode = new URLSearchParams(location.search).get('debug') === '1';

// ── Editor state ───────────────────────────────────────────────────────────
const _LS_LABELS  = 'sn_labels';
const _LS_ROUTES  = 'sn_routes';
const _LS_ROUTES_SNAP = 'sn_routes_snap';
const _LS_JSON_OFF = 'sn_json_off';
const _LS_CUSTOM_LABELS = 'sn_custom_labels';
let _customLabelData = JSON.parse(localStorage.getItem(_LS_CUSTOM_LABELS) || '{}');

const _bldRefs = {}; // id → { css2d, name, x, y, z }
const _allScaleEls = []; // inner elements for all CSS2D labels — zoom scaling target
// Label positions are baked into buildings.geojson — localStorage overrides
// are only applied in debug mode so desktop/mobile always share the same source.
let _labelPos     = _debugMode ? JSON.parse(localStorage.getItem(_LS_LABELS) || '{}') : {};
let _customRoutes = JSON.parse(localStorage.getItem(_LS_ROUTES)  || '[]');
let _jsonOff      = localStorage.getItem(_LS_JSON_OFF) === '1';
let _roadWidth    = parseFloat(localStorage.getItem('sn_road_w') || '0.3');
let _allContacts  = [];

const _trafficGrp = new THREE.Group();
scene.add(_trafficGrp);

let _drawing = false;
let _camAnimating = false;
let _camTween = null;

// ── Auto-orbit (slow loop around selected pin) ────────────────────────────
let _orbitActive = false;
let _orbitTarget = new THREE.Vector3();
let _orbitAngle  = 0;    // current azimuth in radians
let _orbitRadius = 10;
let _orbitElev   = Math.PI / 4; // 45° elevation

function startAutoOrbit(target, radius, elevDeg) {
  _orbitTarget.copy(target);
  _orbitRadius = radius;
  _orbitElev   = elevDeg * Math.PI / 180;
  // Preserve current azimuth so camera doesn't jump
  _orbitAngle  = Math.atan2(
    camera.position.z - target.z,
    camera.position.x - target.x
  );
  _orbitActive = true;
}

function stopAutoOrbit() {
  if (!_orbitActive) return;
  _orbitActive = false;
  controls.enabled = true;
  controls.update();
}
let _drawPts = [];
const _drawGrp = new THREE.Group();
scene.add(_drawGrp);

// Invisible ground plane used for route waypoint raycasting
const _pickGround = new THREE.Mesh(
  new THREE.PlaneGeometry(500, 500),
  new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
);
_pickGround.rotation.x = -Math.PI / 2;
scene.add(_pickGround);

// Ambient light (for MeshStandardMaterial pins)
scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const _dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
_dirLight.position.set(10, 30, 10);
scene.add(_dirLight);

function resize() {
  const wrap = canvas.parentElement;
  const w = wrap.offsetWidth;
  const h = wrap.offsetHeight;
  renderer.setSize(w, h, false);
  css2d.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', resize);
resize();

// ── Camera info HUD (debug mode only: ?debug=1) ────────────────────────────

const _camHud = document.createElement('div');
_camHud.style.cssText = `
  position:fixed;bottom:16px;left:16px;z-index:998;
  background:rgba(15,17,23,0.82);backdrop-filter:blur(8px);
  border:1px solid rgba(255,255,255,0.1);border-radius:8px;
  padding:8px 12px;font:11px/1.8 'DM Mono',monospace;color:#9ca3af;
  pointer-events:none;user-select:none;min-width:210px;
`;
if (_debugMode) document.body.appendChild(_camHud);

function _updateCamHud() {
  if (!_debugMode) return;
  const p = camera.position;
  const t = controls.target;
  const sph = new THREE.Spherical().setFromVector3(
    p.clone().sub(t)  // spherical relative to orbit target
  );
  const phi   = THREE.MathUtils.radToDeg(sph.phi).toFixed(1);
  const theta = THREE.MathUtils.radToDeg(sph.theta).toFixed(1);
  _camHud.innerHTML =
    `<span style="color:#60a5fa">pos</span>  ` +
    `x <b style="color:#fff">${p.x.toFixed(2)}</b>  ` +
    `y <b style="color:#fff">${p.y.toFixed(2)}</b>  ` +
    `z <b style="color:#fff">${p.z.toFixed(2)}</b><br>` +
    `<span style="color:#60a5fa">tgt</span>  ` +
    `x <b style="color:#fff">${t.x.toFixed(2)}</b>  ` +
    `y <b style="color:#fff">${t.y.toFixed(2)}</b>  ` +
    `z <b style="color:#fff">${t.z.toFixed(2)}</b><br>` +
    `<span style="color:#60a5fa">ang</span>  ` +
    `φ <b style="color:#fff">${phi}°</b>  ` +
    `θ <b style="color:#fff">${theta}°</b>  ` +
    `r <b style="color:#fff">${sph.radius.toFixed(2)}</b><br>` +
    `<span style="color:#60a5fa">zoom</span> <b style="color:#fff">${sph.radius.toFixed(1)}</b>` +
    `<span style="color:#6b7280"> / 100</span>`;
}

// ── Animation loop ─────────────────────────────────────────────────────────

let _splatViewer = null;

// Idle throttle: render at full rate when active, drop to ~10 fps when still.
const _prevCamPos = new THREE.Vector3();
const _prevCamQuat = new THREE.Quaternion();
let _idleFrames = 0;
const _pinAnimatables = []; // { squareLine, squareMat } — pulsed each frame
let _lastRenderMs = 0;
const IDLE_AFTER = _Q.idleAfter;
const IDLE_INTERVAL = _Q.idleInterval;

function animate() {
  requestAnimationFrame(animate);
  if (_orbitActive) {
    // ~35-second full orbit at 60 fps
    _orbitAngle += 0.001;  // ~105-second full orbit
    const flatR = _orbitRadius * Math.cos(_orbitElev);
    camera.position.set(
      _orbitTarget.x + flatR * Math.cos(_orbitAngle),
      _orbitTarget.y + _orbitRadius * Math.sin(_orbitElev),
      _orbitTarget.z + flatR * Math.sin(_orbitAngle)
    );
    controls.target.copy(_orbitTarget);
    camera.lookAt(_orbitTarget);
  } else if (!_camAnimating) {
    controls.update();
  }
  if (camera.position.y < 0.5) camera.position.y = 0.5;

  const moved = !camera.position.equals(_prevCamPos) ||
                !camera.quaternion.equals(_prevCamQuat);
  if (moved || _camAnimating) {
    _idleFrames = 0;
    _prevCamPos.copy(camera.position);
    _prevCamQuat.copy(camera.quaternion);
  } else {
    _idleFrames++;
  }

  const now = performance.now();
  if (_idleFrames > IDLE_AFTER && now - _lastRenderMs < IDLE_INTERVAL) return;
  _lastRenderMs = now;

  _updateCamHud();

  const _mobileScale = window.innerWidth <= 640 ? 0.5 : (window.innerWidth <= 1199 ? 0.98 : 1.0);
  const _zoom = camera.position.distanceTo(controls.target);
  // Shrink labels proportionally when far (zoom > 20), constant 1.0 when close.
  const _zoomScale = _zoom >= 20 ? Math.max(0.5, 20 / _zoom) : 1.0;
  const _finalScale = (_zoomScale * _mobileScale).toFixed(3);
  // Apply to all label types (buildings, pins, zones) via unified array.
  for (const el of _allScaleEls) el.style.transform = `scale(${_finalScale})`;

  // Pulse ground squares on all pins (smooth sine, no abs bounce)
  if (_pinAnimatables.length) {
    const wave  = (Math.sin(now * 0.002) + 1) * 0.5; // 0→1, ~3 s cycle
    const pulse = 0.88 + 0.12 * wave;
    const alpha = 0.50 + 0.35 * wave;
    for (const a of _pinAnimatables) {
      a.squareGroup.scale.setScalar(pulse);
      a.squareMat.opacity = alpha;
    }
  }

  if (_splatViewer) _splatViewer.update();
  renderer.render(scene, camera);
  css2d.render(scene, camera);
}
animate();

// ── Camera presets ─────────────────────────────────────────────────────────

let PRESETS = {
  overhead: { pos: new THREE.Vector3(0.00, 26.60, 0.00), look: new THREE.Vector3(0.00, 0.00, 0.00) },
  entry:    { pos: new THREE.Vector3(-5.07, 3.97, 16.01), look: new THREE.Vector3(-5.07, -0.03, 8.01) },
  exit:     { pos: new THREE.Vector3(3.90,  4.01, 16.00), look: new THREE.Vector3(3.90,   0.01, 8.00) },
};

function _buildPresets(cfg) {
  if (!cfg.camera?.presets?.length) return; // keep hardcoded defaults if config missing
  PRESETS = {};
  for (const p of cfg.camera?.presets ?? []) {
    const [px, py, pz] = p.position ?? [0, 26.6, 0];
    const [tx, ty, tz] = p.target ?? [0, 0, 0];
    PRESETS[p.id] = { pos: new THREE.Vector3(px, py, pz), look: new THREE.Vector3(tx, ty, tz) };
  }
}

function _buildCamButtons(cfg) {
  const wrap = document.getElementById('cam-presets');
  if (!wrap) return;
  wrap.innerHTML = '';
  (cfg.camera?.presets ?? []).forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className = 'cam-btn' + (i === 0 ? ' active' : '');
    btn.id = `btn-${p.id}`;
    btn.textContent = p.label;
    btn.onclick = () => window.setCameraPreset(p.id);
    wrap.appendChild(btn);
  });
}

function _applyBranding(cfg) {
  const s = cfg.site ?? {};
  if (s.name)    { const el = document.getElementById('panel-site');   if (el) el.textContent = s.name; }
  if (s.title)   { const el = document.getElementById('panel-title');  if (el) el.textContent = s.title; }
  if (s.address) { const el = document.getElementById('site-address'); if (el) el.textContent = s.address; }
  if (s.logo) {
    const img = document.getElementById('site-logo');
    if (img) { img.src = s.logo; img.style.display = ''; }
  }
}

window.setCameraPreset = function setCameraPreset(name, duration = 2500) {
  stopAutoOrbit();
  let preset = PRESETS[name];
  if (!preset) return;

  // On mobile/tablet, overhead zooms out 30% more and shifts left 30% of height.
  if (name === 'overhead' && window.innerWidth <= 1199) {
    const h = preset.pos.y * 1.3;
    const dx = -preset.pos.y * 0.05;
    preset = {
      pos:  new THREE.Vector3(preset.pos.x  + dx, h, preset.pos.z),
      look: new THREE.Vector3(preset.look.x + dx, preset.look.y, preset.look.z),
    };
  }

  if (_camTween) { _camTween.kill(); _camTween = null; }

  controls.enabled = false;
  _camAnimating = true;

  // World-space lerp: starts exactly at current camera position with no
  // spherical-coordinate singularity (overhead phi≈0 caused azimuth snaps).
  const startPos  = camera.position.clone();
  const startLook = controls.target.clone();
  const endLook   = preset.look.clone();

  const prog = { t: 0 };
  _camTween = gsap.to(prog, {
    t: 1,
    duration: duration / 1000,
    ease: 'power2.inOut',
    onUpdate() {
      const { t } = prog;
      camera.position.lerpVectors(startPos, preset.pos, t);
      controls.target.lerpVectors(startLook, endLook, t);
      camera.lookAt(controls.target);
    },
    onComplete() {
      camera.position.copy(preset.pos);
      controls.target.copy(endLook);
      controls.update();
      controls.enabled = true;
      _camAnimating = false;
      _camTween = null;
    },
  });

  document.querySelectorAll('.cam-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`btn-${name}`)?.classList.add('active');
};

// ── Pin rendering ──────────────────────────────────────────────────────────

const PIN_COLORS = { 'drop-off': 0x185FA5, 'collection': 0x1D9E75, 'both': 0x854F0B };
let _pins = {}; // id → { group, pinGroup, sphere, icon, label, squareMat, squareGroup, pt }
let _selectedId = null;

function renderPins(points) {
  points.forEach(pt => {
    const { x, y, z } = pt.position3d;

    const group = new THREE.Group();
    group.position.set(x, y, z);

    // ── Animated ground square — 4 thin boxes, always above ground plane ─
    const sq = 0.455, lineW = 0.12, sqH = 0.01;
    const squareMat = new THREE.MeshBasicMaterial({
      color: 0xffcc00, transparent: true, opacity: 0.85, depthTest: false,
    });
    const squareGroup = new THREE.Group();
    for (const [bx, bz, bw, bd] of [
      [0,   -sq, sq * 2 + lineW, lineW],   // front (full width, covers corners)
      [0,    sq, sq * 2 + lineW, lineW],   // back
      [-sq,   0, lineW, sq * 2 - lineW],   // left (inner only)
      [ sq,   0, lineW, sq * 2 - lineW],   // right
    ]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bw, sqH, bd), squareMat);
      m.position.set(bx, 0.05, bz);
      m.renderOrder = 999;
      squareGroup.add(m);
    }
    group.add(squareGroup);
    _pinAnimatables.push({ squareGroup, squareMat });

    // ── Pin icon + label — single CSS2DObject so they move as one unit ────
    // Anchor at y=1.3 (pin tip). SVG extends 40px up; label floats above SVG.
    const pinGroup = new THREE.Group();
    group.add(pinGroup);

    // Invisible sphere — raycast hit target only
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 8, 6),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    sphere.position.y = 1.3;
    pinGroup.add(sphere);

    // Wrapper: 0×0 anchor div; CSS2DRenderer translates it to screen position
    const iconWrap = document.createElement('div');
    iconWrap.style.cssText = 'width:0;height:0;pointer-events:none;';

    // SVG pin icon — tip aligns with anchor point
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.setAttribute('width', '28');
    svgEl.setAttribute('height', '40');
    svgEl.setAttribute('viewBox', '0 0 28 40');
    svgEl.style.cssText = 'position:absolute;left:-14px;top:-40px;pointer-events:none;z-index:100;overflow:visible;transform-origin:50% 100%;';
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('fill-rule', 'evenodd');
    pathEl.setAttribute('d', 'M14,1 C7.4,1 2,6.4 2,13 C2,23 14,39 14,39 C14,39 26,23 26,13 C26,6.4 20.6,1 14,1 Z M14,8 a5,5 0 1,0 0.001,0 Z');
    pathEl.setAttribute('fill', 'rgba(220,30,30,0.85)');
    svgEl.appendChild(pathEl);
    iconWrap.appendChild(svgEl);

    // Label — fixed pixel offset above the SVG, centered on anchor
    // Outer div handles position only; inner span is the scale target (same
    // pattern as building labels) so _allScaleEls doesn't clobber translateX.
    const labelDiv = document.createElement('div');
    labelDiv.style.cssText = `
      position:absolute;left:50%;transform:translateX(-50%);bottom:44px;
      pointer-events:auto;cursor:pointer;z-index:100;
    `;
    const labelInner = document.createElement('span');
    labelInner.style.cssText = `
      display:inline-block;
      background:rgba(255,204,0,0.88);backdrop-filter:blur(6px);
      color:#1a1400;font-size:18px;font-family:'DM Mono',monospace;
      padding:4px 8px;border-radius:6px;border:1px solid rgba(255,204,0,0.5);
      white-space:nowrap;transform-origin:50% 100%;
    `;
    labelInner.textContent = pt.label;
    labelDiv.appendChild(labelInner);
    labelDiv.addEventListener('pointerup', e => {
      e.preventDefault();
      e.stopPropagation();
      selectPoint(pt);
    });
    iconWrap.appendChild(labelDiv);
    _allScaleEls.push(labelInner);

    const icon = new CSS2DObject(iconWrap);
    icon.position.set(0, 1.3, 0);
    group.add(icon);

    scene.add(group);
    _pins[pt.id] = { group, pinGroup, sphere, icon, svgEl, labelDiv, labelInner, squareMat, squareGroup, pt };
  });
}

function updatePinHighlight(selectedId) {
  _selectedId = selectedId;
  Object.entries(_pins).forEach(([id, pin]) => {
    const selected = id === selectedId;
    pin.squareMat.color.setHex(selected ? 0x3399ff : 0xffcc00);
  });
}

function removePin(id) {
  const pin = _pins[id];
  if (!pin) return;
  scene.remove(pin.group);
  if (pin.icon.element.parentNode) pin.icon.element.parentNode.removeChild(pin.icon.element);
  const animIdx = _pinAnimatables.findIndex(a => a.squareMat === pin.squareMat);
  if (animIdx >= 0) _pinAnimatables.splice(animIdx, 1);
  const scaleIdx = _allScaleEls.indexOf(pin.labelInner);
  if (scaleIdx >= 0) _allScaleEls.splice(scaleIdx, 1);
  delete _pins[id];
}

// ── Raycasting (click-to-select) ───────────────────────────────────────────

const _raycaster = new THREE.Raycaster();
const _pointer   = new THREE.Vector2();

renderer.domElement.addEventListener('click', e => {
  const rect = renderer.domElement.getBoundingClientRect();
  _pointer.x =  (e.clientX - rect.left)  / rect.width  * 2 - 1;
  _pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _raycaster.setFromCamera(_pointer, camera);

  const meshes = Object.values(_pins).map(p => p.sphere);
  const hits = _raycaster.intersectObjects(meshes);
  if (hits.length) {
    const hitSphere = hits[0].object;
    const pin = Object.values(_pins).find(p => p.sphere === hitSphere);
    if (pin) selectPoint(pin.pt);
  }
});

// ── Point selection & panel ────────────────────────────────────────────────

async function selectPoint(pt) {
  // Second click on same pin deselects it
  if (_selectedId === pt.id) {
    showPointList();
    return;
  }
  updatePinHighlight(pt.id);
  history.pushState(null, '', `?id=${pt.id}`);

  const chipClass = { 'drop-off': 'chip-dropoff', 'collection': 'chip-collection', 'both': 'chip-both' };
  const chipLabel = { 'drop-off': 'Drop-off', 'collection': 'Collection', 'both': 'Drop-off & Collection' };

  document.getElementById('detail-chip').className = `chip ${chipClass[pt.type] ?? ''}`;
  document.getElementById('detail-chip').textContent = chipLabel[pt.type] ?? pt.type;
  document.getElementById('detail-label').textContent = pt.label;
  document.getElementById('detail-notes').textContent = pt.notes ?? '';

  const contacts = pt.contactIds.map(id => _allContacts.find(c => c.id === id)).filter(Boolean);
  document.getElementById('detail-contacts').innerHTML = contacts.map(c => {
    const initials = c.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    return `
      <div class="contact-card-3d">
        <div class="avatar">${initials}</div>
        <div>
          <div class="contact-name-3d">${c.name}</div>
          <div class="contact-role-3d">${c.role}</div>
          <a class="contact-phone-3d" href="tel:${c.phone.replace(/\s/g,'')}">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5.5 2.5c.5 1 1 2.5.5 3.5L4.5 7c1 2 2.5 3.5 4.5 4.5l1-1.5c1-.5 2.5 0 3.5.5v2.5C13.5 13.5 12 14 11 14 6 14 2 10 2 5c0-1 .5-2.5 1.5-2.5h2z"/></svg>
            ${c.phone}
          </a>
        </div>
      </div>
    `;
  }).join('') || '<p style="font-size:13px;color:var(--text-secondary)">No contacts assigned.</p>';

  document.getElementById('point-list').style.display = 'none';
  document.getElementById('point-detail').classList.add('visible');

  // On mobile bottom sheet — snap to mid state so detail is visible
  if (window.innerWidth <= 767) {
    document.getElementById('side-panel')?.classList.add('sheet-mid');
    document.getElementById('side-panel')?.classList.remove('sheet-full');
  }

  // On desktop/tablet — open the overlay panel
  if (window.innerWidth > 767) {
    document.getElementById('app')?.classList.add('panel-open');
  }

  // ── Camera: zoom in 10 units at 45° elevation then slow orbit ──────────
  stopAutoOrbit();
  if (_camTween) { _camTween.kill(); _camTween = null; }

  const PIN_RADIUS = 10;
  const PIN_ELEV   = 45; // degrees
  const elevRad    = PIN_ELEV * Math.PI / 180;
  const pinPos     = new THREE.Vector3(pt.position3d.x, pt.position3d.y, pt.position3d.z);

  // Preserve current azimuth so camera moves toward the pin, not sideways
  const fromTarget = new THREE.Vector3(
    camera.position.x - controls.target.x,
    0,
    camera.position.z - controls.target.z
  );
  if (fromTarget.length() < 0.001) fromTarget.set(1, 0, 0);
  fromTarget.normalize();

  const flatR     = PIN_RADIUS * Math.cos(elevRad);
  const targetPos = new THREE.Vector3(
    pinPos.x + fromTarget.x * flatR,
    pinPos.y + PIN_RADIUS * Math.sin(elevRad),
    pinPos.z + fromTarget.z * flatR
  );

  controls.enabled = false;
  _camAnimating = true;

  const startLook = controls.target.clone();
  const endLook   = pinPos.clone();
  const startSph  = new THREE.Spherical().setFromVector3(camera.position.clone().sub(startLook));
  const endSph    = new THREE.Spherical().setFromVector3(targetPos.clone().sub(endLook));
  let dTheta = endSph.theta - startSph.theta;
  if (dTheta >  Math.PI) dTheta -= 2 * Math.PI;
  if (dTheta < -Math.PI) dTheta += 2 * Math.PI;
  const endTheta = startSph.theta + dTheta;

  const prog = { t: 0 };
  _camTween = gsap.to(prog, {
    t: 1,
    duration: 2.5,
    ease: 'power2.inOut',
    onUpdate() {
      const { t } = prog;
      const look = startLook.clone().lerp(endLook, t);
      const sph  = new THREE.Spherical(
        THREE.MathUtils.lerp(startSph.radius, endSph.radius, t),
        THREE.MathUtils.lerp(startSph.phi,    endSph.phi,    t),
        THREE.MathUtils.lerp(startSph.theta,  endTheta,      t),
      );
      camera.position.copy(look).add(new THREE.Vector3().setFromSpherical(sph));
      camera.lookAt(look);
    },
    onComplete() {
      camera.position.copy(targetPos);
      controls.target.copy(pinPos);
      controls.enabled = true;
      _camAnimating = false;
      _camTween = null;
      startAutoOrbit(pinPos, PIN_RADIUS, PIN_ELEV);
    },
  });
}

window.showPointList = function() {
  stopAutoOrbit();
  updatePinHighlight(null);
  document.getElementById('point-list').style.display = '';
  document.getElementById('point-detail').classList.remove('visible');
  history.pushState(null, '', location.pathname);
};

window.startNav = function() {
  // Phase 7.5 — nav fly-through (to be implemented)
  alert('Navigation fly-through — Phase 7.5 (not yet implemented)');
};

// ── Point list panel ───────────────────────────────────────────────────────

function renderPointList(points) {
  const dropEl = document.getElementById('list-dropoff');
  const colEl  = document.getElementById('list-collection');

  points.forEach(pt => {
    const dot = { 'drop-off': '#185FA5', 'collection': '#1D9E75', 'both': '#854F0B' }[pt.type] ?? '#6b7280';
    const el = document.createElement('div');
    el.className = 'point-item';
    el.innerHTML = `
      <div class="pt-dot" style="background:${dot}"></div>
      <div>
        <div class="pt-label">${pt.label}</div>
        <div class="pt-sub">${pt.type.replace('-', ' ')}</div>
      </div>
    `;
    el.onclick = () => selectPoint(pt);
    if (pt.type === 'collection') colEl.appendChild(el);
    else dropEl.appendChild(el);
  });
}

// ── Building labels & loading zones ───────────────────────────────────────

// CSS2DObject gives true constant screen-space pixel size automatically.
// No per-frame scaling math — the CSS2DRenderer handles projection.
// size: 'small' | 'normal' | 'large'
function _makeLabelCSS2D(text, size = 'normal') {
  const fs  = size === 'large' ? '21px' : size === 'small' ? '14px' : '17px';
  const pad = size === 'large' ? '5px 12px' : size === 'small' ? '3px 8px' : '5px 11px';
  const mxw = size === 'large' ? '120px' : size === 'small' ? '100px' : '160px';
  const inner = document.createElement('div');
  inner.style.cssText = [
    'background:rgba(255,102,0,0.88)',
    'color:#fff',
    `font:600 ${fs} 'DM Sans',sans-serif`,
    `padding:${pad}`,
    `max-width:${mxw}`,
    'border-radius:6px',
    'white-space:pre-line',
    'text-align:center',
    'pointer-events:none',
    'line-height:1.4',
    'user-select:none',
    'transform-origin:center center',
  ].join(';');
  inner.textContent = text;
  // Wrapper: CSS2DRenderer sets transform on this; we scale inner instead.
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'pointer-events:none';
  wrapper.appendChild(inner);
  const obj = new CSS2DObject(wrapper);
  obj._scaleEl = inner;
  return obj;
}

async function renderBuildings(geoData) {
  for (const f of geoData.features) {
    const p = f.properties;
    if (!f.geometry) continue;

    // 3D position: use stored pos3d, fall back to centroid conversion
    let pos3d = p.pos3d;
    if (!pos3d) {
      const coords = f.geometry.coordinates[0];
      const avgLat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
      const avgLng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
      pos3d = await latlngToScene(avgLat, avgLng);
    }

    const labelText = p.labelText ?? (p.name + (p.department ? `  ${p.department}` : ''));
    const size = p.labelSmall ? 'small' : p.labelLarge ? 'large' : 'normal';
    const label = _makeLabelCSS2D(labelText, size);
    const ovr = _labelPos[p.id];
    const lx = ovr?.x ?? pos3d.x;
    const ly = ovr?.y ?? pos3d.y ?? 0.3;
    const lz = ovr?.z ?? pos3d.z;
    label.position.set(lx, ly, lz);
    scene.add(label);
    _bldRefs[p.id] = { css2d: label, name: p.name, x: lx, y: ly, z: lz };
    if (label._scaleEl) _allScaleEls.push(label._scaleEl);

    // Loading zone floor patch
    const zone = p.loadingZone;
    if (zone?.latlng) {
      const color = new THREE.Color(zone.color ?? '#185FA5');
      const pts = await Promise.all(zone.latlng.map(([lat, lng]) => latlngToScene(lat, lng)));
      const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.z)));
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color, transparent: true, opacity: 0.35, depthWrite: false,
      }));
      mesh.position.y = 0.02;
      scene.add(mesh);

      const borderPts = [...pts, pts[0]].map(p => new THREE.Vector3(p.x, 0.03, p.z));
      const borderGeo = new THREE.BufferGeometry().setFromPoints(borderPts);
      scene.add(new THREE.Line(borderGeo, new THREE.LineBasicMaterial({ color, opacity: 0.8, transparent: true })));

      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
      const zoneDiv = document.createElement('div');
      zoneDiv.style.cssText = `
        color:#fff;font:600 13px 'DM Mono',monospace;letter-spacing:0.05em;
        background:${zone.color ?? '#185FA5'}cc;padding:2px 7px;border-radius:4px;
        pointer-events:none;white-space:nowrap;
      `;
      zoneDiv.textContent = zone.label ?? 'Loading zone';
      zoneDiv.style.transformOrigin = 'center center';
      const zoneWrapper = document.createElement('div');
      zoneWrapper.style.cssText = 'pointer-events:none';
      zoneWrapper.appendChild(zoneDiv);
      const zoneLabel = new CSS2DObject(zoneWrapper);
      zoneLabel._scaleEl = zoneDiv;
      _allScaleEls.push(zoneDiv);
      zoneLabel.position.set(cx, 0.5, cz);
      scene.add(zoneLabel);
    }
  }
}

// ── Traffic direction arrows ───────────────────────────────────────────────

// Depth-shifted traffic material.
// Vertices render at their actual world Y (visually ground-level) but the
// depth value written to the depth buffer is calculated as if the vertex
// were at world Y = 2.0.  This makes traffic lose the depth test only
// against splat content that is ABOVE Y=2 (buildings), not against
// ground-level Gaussian blobs (Y<2) which sit slightly farther from camera.
function _makeTrafficMat(hex) {
  return new THREE.ShaderMaterial({
    uniforms: { diffuse: { value: new THREE.Color(hex) } },
    vertexShader: `
      void main() {
        vec4 worldPos   = modelMatrix * vec4(position, 1.0);
        vec4 actualClip = projectionMatrix * viewMatrix * worldPos;
        // Depth as if the vertex were at world Y = 2.0
        vec4 shiftedClip = projectionMatrix * viewMatrix
                         * vec4(worldPos.x, 2.0, worldPos.z, 1.0);
        actualClip.z = (shiftedClip.z / shiftedClip.w) * actualClip.w;
        gl_Position = actualClip;
      }
    `,
    fragmentShader: `
      uniform vec3 diffuse;
      void main() { gl_FragColor = vec4(diffuse, 0.5); }
    `,
    side: THREE.DoubleSide,
    transparent: true,
    depthTest: true,
    depthWrite: true,
  });
}


// ── Traffic rendering (into _trafficGrp so it can be cleared/redrawn) ───────

let _jsonRoutes = []; // saved reference so redraw can include them

function _redrawTraffic() {
  while (_trafficGrp.children.length) _trafficGrp.remove(_trafficGrp.children[0]);

  const routes = [...(_jsonOff ? [] : _jsonRoutes), ..._customRoutes];
  const ROUTE_COLORS = [
    { ribbon: 0xFFA040, arrow: 0xFFBF77 }, // light Landcros orange
    { ribbon: 0xFFA040, arrow: 0xFFBF77 }, // light Landcros orange
  ];
  const Y = 0.19;

  // Debug colours — one distinct colour per custom route for identification
  const DEBUG_COLORS = [0xFF3333, 0x33FF33, 0x3388FF, 0xFFFF00]; // kept distinct for debug ID

  routes.forEach((route, routeIdx) => {
    const isCustom = routeIdx >= _jsonRoutes.length;
    const customIdx = routeIdx - _jsonRoutes.length; // 0-based index within custom routes

    // In debug mode show distinct colours per route so user can identify each one.
    // In normal mode all custom routes share the primary orange.
    let rc, ac;
    if (_debugMode && isCustom) {
      rc = ac = DEBUG_COLORS[customIdx % DEBUG_COLORS.length];
    } else {
      const colorIdx = isCustom ? 0 : routeIdx;
      ({ ribbon: rc, arrow: ac } = ROUTE_COLORS[colorIdx % ROUTE_COLORS.length]);
    }
    const ribbonMat = _makeTrafficMat(rc);
    const arrowMat  = _makeTrafficMat(ac);
    const pts = route.points.map(([x, z]) => new THREE.Vector3(x, Y, z));
    if (pts.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    const samples = curve.getSpacedPoints(pts.length * 25);
    const hw = _roadWidth / 2;

    // Flat ribbon along XZ — renderOrder 2 so it renders above the splat (renderOrder 1)
    // Tangent derived from adjacent arc-length samples (central diff) so width stays
    // constant through turns — parametric getTangent() drifts at dense corners.
    const verts = [], idxs = [];
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      const prev = samples[Math.max(0, i - 1)];
      const next = samples[Math.min(samples.length - 1, i + 1)];
      const tx = next.x - prev.x, tz = next.z - prev.z;
      const len = Math.sqrt(tx * tx + tz * tz) || 1;
      const perp = new THREE.Vector3(-tz / len, 0, tx / len);
      verts.push(
        p.x + perp.x * hw, Y, p.z + perp.z * hw,
        p.x - perp.x * hw, Y, p.z - perp.z * hw
      );
      if (i < samples.length - 1) {
        const a = i*2, b = i*2+1, c = i*2+2, d = i*2+3;
        idxs.push(a, b, c, b, d, c);
      }
    }
    const rGeo = new THREE.BufferGeometry();
    rGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    rGeo.setIndex(idxs);
    const ribbonMesh = new THREE.Mesh(rGeo, ribbonMat);
    ribbonMesh.renderOrder = 2;
    _trafficGrp.add(ribbonMesh);

    // Debug: show "R1 ▶" at start and "R1 ■" at end so topology is visible
    if (_debugMode && isCustom) {
      const color = `#${DEBUG_COLORS[customIdx % DEBUG_COLORS.length].toString(16).padStart(6,'0')}`;
      const num = customIdx + 1;
      const startPt = route.points[0];
      const endPt   = route.points[route.points.length - 1];

      [
        { pt: startPt, text: `R${num} ▶ start` },
        { pt: endPt,   text: `R${num} ■ end`   },
      ].forEach(({ pt, text }) => {
        const div = document.createElement('div');
        div.textContent = text;
        div.style.cssText = `background:${color};color:#000;font:bold 12px monospace;
          padding:2px 6px;border-radius:4px;pointer-events:none;white-space:nowrap;`;
        const lbl = new CSS2DObject(div);
        lbl.position.set(pt[0], Y + 1.5, pt[1]);
        _trafficGrp.add(lbl);
      });

      // Extra route-style arrows at R1 start, R1 end, R2 end
      if (num === 1 || num === 2) {
        const extraPts = num === 1
          ? [route.points[0], route.points[route.points.length - 1]]
          : [route.points[route.points.length - 1]];

        const eaw = _roadWidth * 1.785, eal = eaw * 1.3, ethick = 0.036;
        const eShape = new THREE.Shape();
        eShape.moveTo(0, eal * 2 / 3);
        eShape.lineTo(-eaw * 0.5, -eal / 3);
        eShape.lineTo( eaw * 0.5, -eal / 3);
        eShape.closePath();
        const qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

        extraPts.forEach(ep => {
          // Direction: tangent at that endpoint from the CatmullRom curve
          const t = ep === route.points[0] ? 0.001 : 0.999;
          const tan = curve.getTangentAt(t);
          const dir = new THREE.Vector3(tan.x, 0, tan.z).normalize();
          if (dir.lengthSq() < 0.01) return;

          const geo = new THREE.ExtrudeGeometry(eShape, {
            depth: ethick, bevelEnabled: true,
            bevelSize: 0.01, bevelThickness: 0.01, bevelSegments: 1,
          });
          geo.translate(0, 0, -ethick / 2);
          const mesh = new THREE.Mesh(geo, arrowMat);
          mesh.renderOrder = 3;
          const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-dir.x, -dir.z));
          mesh.quaternion.multiplyQuaternions(qY, qX);
          mesh.position.set(ep[0], Y + ethick * 0.5 + 0.04, ep[1]);
          _trafficGrp.add(mesh);
        });
      }
    }

    // Arrows: arc-length equal spacing + extras at sharp waypoint turns.
    // getPointAt / getTangentAt use arc-length parameterisation → equal world-space gaps.
    const arrowThick = 0.036;                  // 70% thinner than original 0.12
    const aw = _roadWidth * 1.785;             // 40% larger then +50% = ×1.785
    const al = aw * 1.3;
    const curveLen = curve.getLength();
    const numEvenly = Math.max(2, Math.floor(curveLen / 6.0));
    const arrowTs = [];
    for (let i = 1; i <= numEvenly; i++) arrowTs.push(i / (numEvenly + 1));

    const qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    for (const t of arrowTs) {
      const pos = curve.getPointAt(t);
      const tan = curve.getTangentAt(t);
      const dir = new THREE.Vector3(tan.x, 0, tan.z).normalize();
      if (dir.lengthSq() < 0.01) continue;

      const shape = new THREE.Shape();
      shape.moveTo(0,         al * 2 / 3);
      shape.lineTo(-aw * 0.5, -al / 3);
      shape.lineTo( aw * 0.5, -al / 3);
      shape.closePath();

      const extGeo = new THREE.ExtrudeGeometry(shape, {
        depth: arrowThick, bevelEnabled: true,
        bevelSize: 0.01, bevelThickness: 0.01, bevelSegments: 1,
      });
      extGeo.translate(0, 0, -arrowThick / 2);

      const arrowMesh = new THREE.Mesh(extGeo, arrowMat);
      arrowMesh.renderOrder = 2;
      const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-dir.x, -dir.z));
      arrowMesh.quaternion.multiplyQuaternions(qY, qX);
      arrowMesh.position.set(pos.x, Y + arrowThick * 0.5 + 0.04, pos.z);
      _trafficGrp.add(arrowMesh);
    }
  });
}

// ── Draw-mode preview ──────────────────────────────────────────────────────

function _updateDrawPreview() {
  while (_drawGrp.children.length) _drawGrp.remove(_drawGrp.children[0]);
  if (!_drawPts.length) return;

  const ptMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
  _drawPts.forEach(([x, z]) => {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 8), ptMat);
    s.position.set(x, 0.35, z);
    _drawGrp.add(s);
  });

  if (_drawPts.length >= 2) {
    const Y = 0.08;
    const pts = _drawPts.map(([x, z]) => new THREE.Vector3(x, Y, z));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    const samples = curve.getSpacedPoints(pts.length * 25);
    const hw = _roadWidth / 2;
    const verts = [], idxs = [];
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      const t = i / Math.max(1, samples.length - 1);
      const tan = curve.getTangent(t);
      const perp = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
      verts.push(
        p.x + perp.x * hw, Y, p.z + perp.z * hw,
        p.x - perp.x * hw, Y, p.z - perp.z * hw
      );
      if (i < samples.length - 1) {
        const a = i*2, b = i*2+1, c = i*2+2, d = i*2+3;
        idxs.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.setIndex(idxs);
    _drawGrp.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.75, side: THREE.DoubleSide })));
  }
}

// ── Custom label management ────────────────────────────────────────────────

function _restoreCustomLabels() {
  for (const [id, data] of Object.entries(_customLabelData)) {
    const label = _makeLabelCSS2D(data.name, 'normal');
    label.position.set(data.x, data.y, data.z);
    scene.add(label);
    _bldRefs[id] = { css2d: label, name: data.name, x: data.x, y: data.y, z: data.z, isCustom: true };
    if (label._scaleEl) _allScaleEls.push(label._scaleEl);
  }
}

function _addCustomLabel() {
  const id = 'cl_' + (crypto.randomUUID?.() ?? Date.now());
  const { x, z } = controls.target;
  _customLabelData[id] = { name: 'New Label', x, y: 1.5, z };
  localStorage.setItem(_LS_CUSTOM_LABELS, JSON.stringify(_customLabelData));
  const label = _makeLabelCSS2D('New Label', 'normal');
  label.position.set(x, 1.5, z);
  scene.add(label);
  _bldRefs[id] = { css2d: label, name: 'New Label', x, y: 1.5, z, isCustom: true };
  if (label._scaleEl) _allScaleEls.push(label._scaleEl);
  const panel = document.getElementById('sn-editor-panel');
  if (panel) _renderEdPanel(panel);
}

function _removeCustomLabel(id) {
  const ref = _bldRefs[id];
  if (!ref || !ref.isCustom) return;
  scene.remove(ref.css2d);
  const idx = _allScaleEls.indexOf(ref.css2d._scaleEl);
  if (idx !== -1) _allScaleEls.splice(idx, 1);
  delete _bldRefs[id];
  delete _customLabelData[id];
  localStorage.setItem(_LS_CUSTOM_LABELS, JSON.stringify(_customLabelData));
  const panel = document.getElementById('sn-editor-panel');
  if (panel) _renderEdPanel(panel);
}

// ── Editor UI ──────────────────────────────────────────────────────────────

function _initEditorUI() {
  const edBtn = document.createElement('button');
  edBtn.className = 'cam-btn';
  edBtn.style.cssText += 'margin-top:8px;border-color:rgba(250,204,21,0.5);color:#facc15;';
  edBtn.textContent = '✏ Edit';
  document.getElementById('cam-presets').appendChild(edBtn);

  const panel = document.createElement('div');
  panel.id = 'sn-editor-panel';
  panel.style.cssText = `display:none;position:fixed;top:60px;left:16px;z-index:997;
    background:rgba(15,17,23,0.97);backdrop-filter:blur(10px);
    border:1px solid rgba(255,255,255,0.15);border-radius:12px;
    padding:16px;width:310px;max-height:72vh;overflow-y:auto;
    font:12px/1.7 'DM Mono',monospace;color:#e5e7eb;`;
  document.body.appendChild(panel);

  edBtn.addEventListener('click', () => {
    const open = panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    if (open) _renderEdPanel(panel);
  });

  // Route waypoint capture on canvas click
  renderer.domElement.addEventListener('click', e => {
    if (!_drawing) return;
    const rect = renderer.domElement.getBoundingClientRect();
    _pointer.x =  (e.clientX - rect.left) / rect.width  * 2 - 1;
    _pointer.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
    _raycaster.setFromCamera(_pointer, camera);
    const hits = _raycaster.intersectObject(_pickGround);
    if (!hits.length) return;
    const { x, z } = hits[0].point;
    _drawPts.push([+x.toFixed(2), +z.toFixed(2)]);
    _updateDrawPreview();
    _renderEdPanel(panel);
  }, true); // capture phase so it fires before orbit
}

function _renderEdPanel(panel) {
  const labelRows = Object.entries(_bldRefs).map(([id, ref]) => {
    const pos = _labelPos[id] ?? { x: ref.x, y: ref.y, z: ref.z };
    const inp = (axis, val) =>
      `<label style="display:flex;align-items:center;gap:3px">
        <span style="color:#9ca3af;width:10px">${axis}</span>
        <input data-id="${id}" data-axis="${axis}" type="number" step="0.5" value="${(+val).toFixed(1)}"
          style="width:55px;background:#1f2937;border:1px solid #374151;color:#fff;
                 border-radius:4px;padding:2px 5px;font:11px 'DM Mono',monospace">
      </label>`;
    const nameRow = ref.isCustom
      ? `<input data-id="${id}" data-axis="name" type="text" value="${ref.name.replace(/"/g,'&quot;')}"
           style="width:100%;background:#1f2937;border:1px solid #374151;color:#fff;
                  border-radius:4px;padding:2px 5px;font:11px 'DM Mono',monospace;margin-bottom:4px">`
      : `<div style="color:#60a5fa;font-size:10px;margin-bottom:3px">${ref.name}</div>`;
    const rmvBtn = ref.isCustom
      ? `<button data-rmv="${id}" style="margin-left:auto;padding:1px 7px;background:rgba(239,68,68,0.15);
           border:1px solid rgba(239,68,68,0.5);border-radius:4px;color:#f87171;cursor:pointer;
           font:11px 'DM Mono',monospace">×</button>`
      : '';
    return `<div style="margin-bottom:7px;padding-bottom:7px;border-bottom:1px solid rgba(255,255,255,0.06)">
      <div style="display:flex;align-items:center;gap:4px;margin-bottom:3px">
        ${nameRow}${rmvBtn}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${inp('x', pos.x)}${inp('z', pos.z)}${inp('y', pos.y)}
      </div>
    </div>`;
  }).join('');

  const drawing = _drawing;
  const nCustom = _customRoutes.length;

  panel.innerHTML = `
    <div style="font-weight:700;color:#34d399;margin-bottom:10px;font-size:13px">✏ Site Editor</div>

    <div style="font-weight:600;color:#facc15;margin-bottom:6px;font-size:11px">LABELS</div>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <button id="ed-copy-pos" class="_ed-btn" style="border-color:#34d399;color:#34d399;flex:1">
        Copy positions to clipboard
      </button>
      <button id="ed-add-label" class="_ed-btn" style="border-color:#a78bfa;color:#c4b5fd">+ Add label</button>
    </div>
    ${labelRows || '<div style="color:#6b7280;font-size:11px">No buildings loaded yet</div>'}

    <div style="font-weight:600;color:#facc15;margin:10px 0 6px;font-size:11px">ROAD WIDTH</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <button id="ed-rw-dec" class="_ed-btn" style="border-color:#6b7280;color:#d1d5db;padding:3px 10px">−</button>
      <span id="ed-rw-val" style="font-size:13px;color:#fff;min-width:28px;text-align:center">${_roadWidth.toFixed(1)}</span>
      <button id="ed-rw-inc" class="_ed-btn" style="border-color:#6b7280;color:#d1d5db;padding:3px 10px">+</button>
    </div>

    <div style="font-weight:600;color:#facc15;margin:10px 0 6px;font-size:11px">TRAFFIC ROUTES</div>
    ${drawing ? `
      <div style="color:#f59e0b;margin-bottom:6px">● Drawing — ${_drawPts.length} pt${_drawPts.length!==1?'s':''}<br>
        <span style="color:#9ca3af;font-size:10px">Click on the ground to add waypoints</span></div>
      <div style="display:flex;flex-direction:column;gap:5px">
        <button id="ed-undo"   class="_ed-btn" style="border-color:#f59e0b;color:#fcd34d">↩ Undo last point</button>
        <button id="ed-finish" class="_ed-btn" style="border-color:#10b981;color:#34d399">✓ Finish route (${_drawPts.length} pts)</button>
        <button id="ed-cancel" class="_ed-btn" style="border-color:#6b7280;color:#9ca3af">✕ Cancel</button>
      </div>
    ` : `
      <div style="display:flex;flex-direction:column;gap:5px">
        <button id="ed-new"    class="_ed-btn" style="border-color:#2563eb;color:#60a5fa">+ Draw new route</button>
        ${nCustom >= 1 ? `<button id="ed-snap-save" class="_ed-btn" style="border-color:#f59e0b;color:#fcd34d">💾 Save snapshot (${nCustom} routes)</button>` : ''}
        ${localStorage.getItem(_LS_ROUTES_SNAP) ? `<button id="ed-snap-restore" class="_ed-btn" style="border-color:#f59e0b;color:#fcd34d">↺ Restore snapshot</button>` : ''}
${nCustom >= 1 ? `<button id="ed-export" class="_ed-btn" style="border-color:#a78bfa;color:#c4b5fd">📋 Copy traffic.json</button>` : ''}
        ${nCustom ? `<button id="ed-clr-custom" class="_ed-btn" style="border-color:#ef4444;color:#f87171">🗑 Clear ${nCustom} drawn route${nCustom!==1?'s':''}</button>` : ''}
        <button id="ed-clr-all" class="_ed-btn" style="border-color:#ef4444;color:#f87171">🗑 Clear ALL routes</button>
        ${_jsonOff && nCustom===0 ? `<button id="ed-restore" class="_ed-btn" style="border-color:#6b7280;color:#9ca3af">↺ Restore default routes</button>` : ''}
      </div>
    `}
  `;

  // Style shared buttons
  panel.querySelectorAll('._ed-btn').forEach(b => {
    b.style.cssText += `padding:5px 10px;background:rgba(255,255,255,0.05);
      border-width:1px;border-style:solid;border-radius:6px;cursor:pointer;
      font:12px 'DM Mono',monospace;text-align:left;`;
  });

  // Label input handlers
  panel.querySelectorAll('input[data-id]').forEach(inp => {
    inp.addEventListener('change', () => {
      const id = inp.dataset.id, axis = inp.dataset.axis;
      const ref = _bldRefs[id];
      if (!ref) return;
      if (axis === 'name') {
        ref.name = inp.value;
        _customLabelData[id].name = inp.value;
        localStorage.setItem(_LS_CUSTOM_LABELS, JSON.stringify(_customLabelData));
        if (ref.css2d._scaleEl) ref.css2d._scaleEl.textContent = inp.value;
        return;
      }
      const val = parseFloat(inp.value);
      if (isNaN(val)) return;
      if (!_labelPos[id]) _labelPos[id] = { x: ref.x, y: ref.y, z: ref.z };
      _labelPos[id][axis] = val;
      ref.css2d.position.set(_labelPos[id].x, _labelPos[id].y, _labelPos[id].z);
      if (ref.isCustom) {
        _customLabelData[id][axis] = val;
        localStorage.setItem(_LS_CUSTOM_LABELS, JSON.stringify(_customLabelData));
      } else {
        localStorage.setItem(_LS_LABELS, JSON.stringify(_labelPos));
      }
    });
  });

  // Add / remove custom label buttons
  panel.querySelector('#ed-add-label')?.addEventListener('click', _addCustomLabel);
  panel.querySelectorAll('[data-rmv]').forEach(btn => {
    btn.addEventListener('click', () => _removeCustomLabel(btn.dataset.rmv));
  });

  // Route button handlers
  panel.querySelector('#ed-new')?.addEventListener('click', () => {
    _drawing = true; _drawPts = []; controls.enabled = false;
    _renderEdPanel(panel);
  });
  panel.querySelector('#ed-undo')?.addEventListener('click', () => {
    _drawPts.pop(); _updateDrawPreview(); _renderEdPanel(panel);
  });
  panel.querySelector('#ed-finish')?.addEventListener('click', () => {
    if (_drawPts.length >= 2) {
      _customRoutes.push({ id: `r${Date.now()}`, points: [..._drawPts] });
      localStorage.setItem(_LS_ROUTES, JSON.stringify(_customRoutes));
      _redrawTraffic();
    }
    _drawing = false; _drawPts = []; controls.enabled = true;
    while (_drawGrp.children.length) _drawGrp.remove(_drawGrp.children[0]);
    _renderEdPanel(panel);
  });
  panel.querySelector('#ed-cancel')?.addEventListener('click', () => {
    _drawing = false; _drawPts = []; controls.enabled = true;
    while (_drawGrp.children.length) _drawGrp.remove(_drawGrp.children[0]);
    _renderEdPanel(panel);
  });
  panel.querySelector('#ed-clr-custom')?.addEventListener('click', () => {
    _customRoutes = []; localStorage.setItem(_LS_ROUTES, JSON.stringify([]));
    _redrawTraffic(); _renderEdPanel(panel);
  });
  panel.querySelector('#ed-clr-all')?.addEventListener('click', () => {
    _customRoutes = []; _jsonOff = true;
    localStorage.setItem(_LS_ROUTES, JSON.stringify([]));
    localStorage.setItem(_LS_JSON_OFF, '1');
    _redrawTraffic(); _renderEdPanel(panel);
  });
  panel.querySelector('#ed-snap-save')?.addEventListener('click', () => {
    localStorage.setItem(_LS_ROUTES_SNAP, JSON.stringify(_customRoutes));
    _renderEdPanel(panel);
    alert(`Snapshot saved — ${_customRoutes.length} routes backed up.`);
  });
  panel.querySelector('#ed-snap-restore')?.addEventListener('click', () => {
    const snap = localStorage.getItem(_LS_ROUTES_SNAP);
    if (!snap) return;
    _customRoutes = JSON.parse(snap);
    localStorage.setItem(_LS_ROUTES, JSON.stringify(_customRoutes));
    _redrawTraffic(); _renderEdPanel(panel);
  });
  panel.querySelector('#ed-export')?.addEventListener('click', () => {
    const json = JSON.stringify({ routes: _customRoutes }, null, 2);
    const a = document.createElement('a');
    a.href = 'data:application/json,' + encodeURIComponent(json);
    a.download = 'traffic.json';
    a.click();
  });
  panel.querySelector('#ed-restore')?.addEventListener('click', () => {
    _jsonOff = false; localStorage.removeItem(_LS_JSON_OFF);
    _redrawTraffic(); _renderEdPanel(panel);
  });

  // Copy label positions to clipboard
  panel.querySelector('#ed-copy-pos')?.addEventListener('click', async (e) => {
    const out = {};
    Object.entries(_bldRefs).forEach(([id, ref]) => {
      const ovr = _labelPos[id];
      out[id] = {
        x: +(ovr?.x ?? ref.x).toFixed(2),
        y: +(ovr?.y ?? ref.y).toFixed(2),
        z: +(ovr?.z ?? ref.z).toFixed(2),
      };
    });
    const json = JSON.stringify(out, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      e.target.textContent = 'Copied!';
      setTimeout(() => { e.target.textContent = 'Copy positions to clipboard'; }, 2000);
    } catch {
      // Fallback: show in textarea
      const ta = document.createElement('textarea');
      ta.value = json;
      ta.style.cssText = 'width:100%;height:120px;font:10px monospace;margin-top:6px;resize:none;background:#111;color:#ccc;border:1px solid #374151;border-radius:4px;padding:4px';
      e.target.after(ta);
    }
  });

  // Road width handlers
  panel.querySelector('#ed-rw-dec')?.addEventListener('click', () => {
    _roadWidth = Math.max(0.2, +(_roadWidth - 0.1).toFixed(1));
    localStorage.setItem('sn_road_w', _roadWidth);
    _redrawTraffic(); _renderEdPanel(panel);
  });
  panel.querySelector('#ed-rw-inc')?.addEventListener('click', () => {
    _roadWidth = Math.min(5.0, +(_roadWidth + 0.1).toFixed(1));
    localStorage.setItem('sn_road_w', _roadWidth);
    _redrawTraffic(); _renderEdPanel(panel);
  });
}

// ── Road network ───────────────────────────────────────────────────────────

async function renderRoads(roads) {
  const nodeMap = Object.fromEntries(roads.nodes.map(n => [n.id, n]));

  for (const edge of roads.edges) {
    const a = nodeMap[edge.from];
    const b = nodeMap[edge.to];
    if (!a || !b) continue;

    const pa = await latlngToScene(a.latlng[0], a.latlng[1]);
    const pb = await latlngToScene(b.latlng[0], b.latlng[1]);

    const color = edge.oneWay ? 0xDC2626 : 0x854F0B;
    const curve = new THREE.LineCurve3(
      new THREE.Vector3(pa.x, 0.05, pa.z),
      new THREE.Vector3(pb.x, 0.05, pb.z)
    );
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 4, 0.15, _Q.roadSegs, false),
      new THREE.MeshStandardMaterial({ color, opacity: 0.6, transparent: true })
    );
    scene.add(tube);

    // Direction cone at midpoint for one-way edges
    if (edge.oneWay) {
      const mx = (pa.x + pb.x) / 2;
      const mz = (pa.z + pb.z) / 2;
      const dx = pb.x - pa.x, dz = pb.z - pa.z;
      const angle = Math.atan2(dx, dz);
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.22, 0.55, 6),
        new THREE.MeshStandardMaterial({ color })
      );
      cone.position.set(mx, 0.4, mz);
      cone.rotation.z = Math.PI; // point forward
      cone.rotation.y = angle;
      scene.add(cone);
    }
  }
}


// ── Splat loading — runs in background after scene is visible ──────────────

async function _addGroundPlane() {
  const tex = await new THREE.TextureLoader().loadAsync(_cfg.assets?.satellite ?? './assets/satellite.png');
  tex.colorSpace = THREE.SRGBColorSpace;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1), // scale via group, so base size = 1
    new THREE.MeshStandardMaterial({
      map: tex,
      color: new THREE.Color(1.6, 1.5, 1.4),
      roughness: 0.72,
      metalness: 0,
    })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.renderOrder = 0;
  ground.material.depthWrite = true;

  // Group plane so pan/scale moves it
  _planeGroup = new THREE.Group();
  _planeGroup.add(ground);
  scene.add(_planeGroup);

  // Restore saved plane transform
  const LS_PLANE = 'planeTransform';
  const savedPlane = JSON.parse(localStorage.getItem(LS_PLANE) || 'null');
  _planeGroup.scale.set(savedPlane?.sx ?? (_cfg.plane?.scale?.[0] ?? 62.0), 1, savedPlane?.sz ?? (_cfg.plane?.scale?.[1] ?? 39.5));
  _planeGroup.position.set(savedPlane?.px ?? (_cfg.plane?.position?.[0] ?? 1.61), 0, savedPlane?.pz ?? (_cfg.plane?.position?.[2] ?? -4.30));

  // Soil block — PBR textures from dirtwithrocks-ogl (skipped on LOW tier)
  const SOIL_THICKNESS = 1;
  if (!_Q.soilPBR) {
    // LOW tier: flat colour strip, no texture fetch
    const soilFlat = new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 1, metalness: 0 });
    const soilFlatMesh = new THREE.Mesh(
      new THREE.BoxGeometry(_planeGroup.scale.x, SOIL_THICKNESS, _planeGroup.scale.z),
      soilFlat
    );
    soilFlatMesh.position.set(_planeGroup.position.x, -(SOIL_THICKNESS / 2 + 0.01), _planeGroup.position.z);
    scene.add(soilFlatMesh);
  } else {

  const loader = new THREE.TextureLoader();
  const DR = './assets/dirtwithrocks/';
  const EXT = 'webp'; // WebP saves ~84% over PNG at same quality
  const aniso = renderer.capabilities.getMaxAnisotropy();

  const setupTex = (t, srgb = false) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = aniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };

  const [soilColor, soilNormal, soilAO] = await Promise.all([
    loader.loadAsync(DR + `dirtwithrocks_Base_Color.${EXT}`).then(t => setupTex(t, true)),
    loader.loadAsync(DR + `dirtwithrocks_Normal-ogl.${EXT}`).then(t => setupTex(t)),
    loader.loadAsync(DR + `dirtwithrocks_Ambient_Occlusion.${EXT}`).then(t => setupTex(t)),
  ]);

  const soilSideMat = new THREE.MeshStandardMaterial({
    map:            soilColor,
    normalMap:      soilNormal,
    normalScale:    new THREE.Vector2(1.2, 1.2),
    aoMap:          soilAO,
    aoMapIntensity: 0.7,
    color:          new THREE.Color(1.25, 1.0, 0.82),
    roughness:      0.85,
    metalness:      0,
  });

  // Triplanar mapping via onBeforeCompile — bypasses UV entirely, samples
  // textures using world-space XY/XZ/YZ projections blended by face normal.
  // This fixes the 62:1 UV stretching on the thin side-wall strips.
  const TRI_SCALE = 0.47; // world units → UV (1/TRI_SCALE ≈ 2.1-unit tile size)
  soilSideMat.onBeforeCompile = shader => {
    shader.uniforms.triScale = { value: TRI_SCALE };

    // Pass world position + world normal from vertex shader
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vWorldPos;\nvarying vec3 vWorldNormal;')
      .replace('#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWorldNormal = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);');

    // Inject triplanar helpers + varying into fragment shader
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `
#include <common>
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
uniform float triScale;
vec3 _triW(vec3 n) {
  vec3 w = pow(abs(normalize(n)), vec3(3.0));
  return w / (w.x + w.y + w.z + 1e-6);
}
vec4 _triTex(sampler2D t, vec3 p, vec3 w) {
  vec2 uvX = p.yz * triScale;
  vec2 uvY = p.xz * triScale;
  vec2 uvZ = p.xy * triScale;
  return textureGrad(t, uvX, dFdx(uvX), dFdy(uvX)) * w.x
       + textureGrad(t, uvY, dFdx(uvY), dFdy(uvY)) * w.y
       + textureGrad(t, uvZ, dFdx(uvZ), dFdy(uvZ)) * w.z;
}`);

    // Replace UV-based albedo sampling with triplanar
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
  diffuseColor *= _triTex(map, vWorldPos, _triW(vWorldNormal));
#endif`);

    // Replace UV-based AO sampling with triplanar
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <aomap_fragment>',
      `#ifdef USE_AOMAP
  float ambientOcclusion = (_triTex(aoMap, vWorldPos, _triW(vWorldNormal)).r - 1.0) * aoMapIntensity + 1.0;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined(USE_CLEARCOAT)
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined(USE_SHEEN)
    sheenSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined(USE_IRIDESCENCE)
    iridescenceSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined(USE_ANISOTROPY)
    anisotropicSpecularIndirect *= ambientOcclusion;
  #endif
#endif`);

    // Triplanar normal: sample from dominant projection, perturb geometry normal
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `#ifdef TANGENTSPACE_NORMALMAP
  {
    vec3 _tw = _triW(vWorldNormal);
    vec3 mapN = (_triTex(normalMap, vWorldPos, _tw).xyz * 2.0 - 1.0);
    mapN.xy *= normalScale;
    normal = perturbNormal2Arb(-vViewPosition, normal, mapN, faceDirection);
  }
#endif`);
  };
  soilSideMat.customProgramCacheKey = () => 'triplanar-soil';

  const soilTopMat = new THREE.MeshStandardMaterial({ color: 0x9e7a4a, roughness: 1, metalness: 0 });
  // BoxGeometry face order: +X, -X, +Y (top), -Y (bottom), +Z, -Z
  const soilGeo = new THREE.BoxGeometry(_planeGroup.scale.x, SOIL_THICKNESS, _planeGroup.scale.z);
  soilGeo.setAttribute('uv2', soilGeo.getAttribute('uv')); // aoMap uv2 still needed for uniform binding
  const soilMesh = new THREE.Mesh(
    soilGeo,
    [soilSideMat, soilSideMat, soilTopMat, soilSideMat, soilSideMat, soilSideMat]
  );
  soilMesh.position.set(
    _planeGroup.position.x,
    -(SOIL_THICKNESS / 2 + 0.01), // top face at y=-0.01, flush under satellite plane
    _planeGroup.position.z
  );
  soilMesh.renderOrder = 0;
  scene.add(soilMesh);

  } // end _Q.soilPBR

  // Fossil — skipped on LOW tier (reduces boot fetch count and scene complexity)
  if (_Q.scenery) {
  // ── T-Rex STL ──────────────────────────────────────────────────────────────
  const savedTrex = null; // position locked — edit defaults in code to reposition
  let _trex = null;

  const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
  const stlGeo = await new STLLoader().loadAsync('./assets/Trex.stl');
  stlGeo.computeVertexNormals();
  stlGeo.computeBoundingBox();
  const stlScale = savedTrex?.s ?? 0.0132;

  _trex = new THREE.Mesh(
    stlGeo,
    new THREE.MeshStandardMaterial({ color: 0xd4b483, roughness: 0.75, metalness: 0.05 })
  );
  _trex.scale.setScalar(stlScale);
  _trex.position.set(
    savedTrex?.x ?? -1.59,
    savedTrex?.y ?? -1.00,
    savedTrex?.z ??  15.18
  );
  _trex.rotation.y = savedTrex?.ry ?? THREE.MathUtils.degToRad(-361.0);
  scene.add(_trex);
  } // end _Q.scenery


  // ── Plane adjust HUD ──────────────────────────────────────────────────────
  const texHud = document.createElement('div');
  texHud.style.cssText = `position:fixed;bottom:80px;right:16px;z-index:999;
    background:rgba(15,17,23,0.92);backdrop-filter:blur(8px);
    border:1px solid rgba(255,255,255,0.15);border-radius:12px;
    padding:14px 16px;font:13px/1.8 monospace;color:#e5e7eb;min-width:230px`;
  texHud.innerHTML = `<div style="font-weight:700;margin-bottom:6px;color:#34d399">Satellite Plane</div>
    <div><kbd style="color:#facc15">1 / 2</kbd>  Width ±</div>
    <div><kbd style="color:#facc15">3 / 4</kbd>  Depth ±</div>
    <div id="pan-btn" style="margin-top:8px;padding:5px 10px;border-radius:6px;
      background:rgba(52,211,153,0.15);border:1px solid #34d399;cursor:pointer;
      text-align:center;color:#34d399;font-weight:600">🖱 Pan Mode: OFF</div>
    <div style="margin-top:8px;border-top:1px solid rgba(255,255,255,0.1);padding-top:8px" id="tex-vals"></div>`;
  if (_debugMode) document.body.appendChild(texHud);

  const texVals  = document.getElementById('tex-vals');
  const panBtn   = document.getElementById('pan-btn');
  const savePlane = () => localStorage.setItem(LS_PLANE, JSON.stringify({
    sx: _planeGroup.scale.x, sz: _planeGroup.scale.z,
    px: _planeGroup.position.x, pz: _planeGroup.position.z,
  }));
  const updateTexHud = () => {
    if (!texVals) return;
    texVals.innerHTML =
      `width:  <b>${_planeGroup.scale.x.toFixed(1)}</b><br>` +
      `depth:  <b>${_planeGroup.scale.z.toFixed(1)}</b><br>` +
      `pan X:  <b>${_planeGroup.position.x.toFixed(2)}</b><br>` +
      `pan Z:  <b>${_planeGroup.position.z.toFixed(2)}</b>`;
  };
  updateTexHud();

  if (_debugMode) {
    // Size keys
    window.addEventListener('keydown', (e) => {
      if (!_planeGroup) return;
      const step = e.shiftKey ? 0.1 : 0.5;
      if (e.key === '1') _planeGroup.scale.x += step;
      if (e.key === '2') _planeGroup.scale.x = Math.max(1, _planeGroup.scale.x - step);
      if (e.key === '3') _planeGroup.scale.z += step;
      if (e.key === '4') _planeGroup.scale.z = Math.max(1, _planeGroup.scale.z - step);
      updateTexHud(); savePlane();
    });

    // Mouse pan mode
    let _panMode = false, _dragging = false, _lastMouse = null;
    panBtn.addEventListener('click', () => {
      _panMode = !_panMode;
      panBtn.textContent = `🖱 Pan Mode: ${_panMode ? 'ON' : 'OFF'}`;
      panBtn.style.background = _panMode ? 'rgba(52,211,153,0.35)' : 'rgba(52,211,153,0.15)';
      controls.enabled = !_panMode;
    });

    const cvs = document.getElementById('three-canvas');
    cvs.addEventListener('mousedown', (e) => {
      if (!_panMode) return;
      _dragging = true;
      _lastMouse = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mousemove', (e) => {
      if (!_panMode || !_dragging || !_lastMouse) return;
      const speed = camera.position.y * 0.0015;
      _planeGroup.position.x += (e.clientX - _lastMouse.x) * speed;
      _planeGroup.position.z += (e.clientY - _lastMouse.y) * speed;
      _lastMouse = { x: e.clientX, y: e.clientY };
      updateTexHud(); savePlane();
    });
    window.addEventListener('mouseup', () => { _dragging = false; });
  }

  // Procedural sky — skipped on LOW tier (saves one full shader compile + GPU draw)
  if (_Q.sky) {
    const sky = new Sky();
    sky.scale.setScalar(10000);
    scene.add(sky);

    const sun = new THREE.Vector3();
    const su = sky.material.uniforms;
    su['turbidity'].value       = 5;
    su['rayleigh'].value        = 1.0;
    su['mieCoefficient'].value  = 0.003;
    su['mieDirectionalG'].value = 0.96;
    const phi   = THREE.MathUtils.degToRad(82);
    const theta = THREE.MathUtils.degToRad(200);
    sun.setFromSphericalCoords(1, phi, theta);
    su['sunPosition'].value.copy(sun);

    const sunLight = new THREE.DirectionalLight(0xfff0d0, 1.4);
    sunLight.position.copy(sun).multiplyScalar(60);
    scene.add(sunLight);
  }
}

async function loadSplatBackground() {
  if (_Q.skipSplat) return; // save-data / 2G: skip the large splat download entirely
  const _splatAsset = _cfg.assets?.splat;
  const candidates = Array.isArray(_splatAsset) ? _splatAsset
                   : typeof _splatAsset === 'string' ? [_splatAsset]
                   : ['./assets/site.splat', './assets/site.ply'];
  let splatPath = null;
  for (const path of candidates) {
    try {
      const r = await fetch(path, { method: 'HEAD' });
      if (r.ok) { splatPath = path; break; }
    } catch {}
  }
  if (!splatPath) return;

  const ext  = splatPath.split('.').pop().toUpperCase();
  const bar  = document.getElementById('splat-bar');
  const msg  = document.getElementById('splat-msg');
  const wrap = document.getElementById('splat-progress');
  if (wrap) wrap.style.display = 'flex';
  if (msg)  msg.textContent = `Loading ${ext}… 0%`;

  // Hoisted so the point cloud fallback catch-block can reuse the downloaded bytes
  let rawBuf = null;

  try {
    // Pass 1: fetch raw bytes and scan positions for bounding box.
    // Only valid for .splat (32-byte records) — skip pre-scan for .ply to avoid NaN bounds.
    if (msg) msg.textContent = `Scanning ${ext}…`;
    rawBuf = ext === 'SPLAT' ? await fetch(splatPath).then(r => r.arrayBuffer()) : null;
    const STRIDE = 32;
    let cx = 0, cy = 0, cz = 0, scale = 1;
    if (rawBuf) {
      const count = Math.floor(rawBuf.byteLength / STRIDE);
      const dv = new DataView(rawBuf);
      let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity, minZ=Infinity, maxZ=-Infinity;
      for (let i = 0; i < count; i++) {
        const o = i * STRIDE;
        const x = dv.getFloat32(o,     true);
        const y = dv.getFloat32(o + 4, true);
        const z = dv.getFloat32(o + 8, true);
        if (x < minX) minX=x; if (x > maxX) maxX=x;
        if (y < minY) minY=y; if (y > maxY) maxY=y;
        if (z < minZ) minZ=z; if (z > maxZ) maxZ=z;
      }
      cx = (minX + maxX) / 2;
      cy = (minY + maxY) / 2;
      cz = (minZ + maxZ) / 2;
      const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
      scale = 40 / span;
    }

    // Pass 2: GS3D Gaussian rendering — requires cross-origin isolation (COEP/COOP
    // headers). Skip on static hosts like GitHub Pages where the service worker
    // may not have activated; fall through to the point cloud fallback instead.
    if (!window.crossOriginIsolated) throw new Error('GS3D requires cross-origin isolation');

    if (msg) msg.textContent = `Loading ${ext}… 0%`;
    const GS3D = await import('@mkkellogg/gaussian-splats-3d');
    const sv = new GS3D.Viewer({
      selfDrivenMode: false,
      useBuiltInControls: false,
      renderer,
      camera,
      gpuAcceleratedSort: false,
      sharedMemoryForWorkers: false,
      splatAlphaRemovalThreshold: 1,
    });

    await Promise.race([
      sv.addSplatScene(splatPath, {
        showLoadingUI: false,
        onProgress: (p) => {
          const pct = Math.min(99, Math.round(p));
          if (bar) bar.style.width = pct + '%';
          if (msg) msg.textContent = `Loading ${ext}… ${pct}%`;
        },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('GS3D timeout')), 15000)
      ),
    ]);

    sv.splatMesh.scale.setScalar(scale);
    const [sr0, sr1, sr2] = _cfg.splat?.rotation ?? [3.260, -1.779, 0.122];
    sv.splatMesh.rotation.set(sr0, sr1, sr2);
    const [so0, so1, so2] = _cfg.splat?.centerOffset ?? [0, -1.70, -1.3];
    sv.splatMesh.position.set(-cx * scale + so0, so1, cz * scale + so2);

    sv.splatMesh.renderOrder = 1;
    // Force depth test so the opaque ground plane (renderOrder 0, depthWrite true)
    // occludes splat fragments below y=0.
    if (sv.splatMesh.material) sv.splatMesh.material.depthTest = true;
    scene.add(sv.splatMesh);
    _splatViewer = sv;

    controls.minDistance = 1;
    controls.maxDistance = 100;

    // Splat is ready — arc camera from overhead to a 45° side view over 3 s.
    // Interpolate in spherical coords so the camera follows an arc (no straight-
    // line zoom-in artifact that occurs when animating Cartesian x/y/z directly).
    controls.enabled = false;
    _camAnimating = true;
    const lookAt   = new THREE.Vector3(0, 0, 0);
    // End position: side-45° view at a closer distance than the overhead start.
    // Arc from current overhead radius → smaller end radius = genuine zoom-in.
    const startSph = new THREE.Spherical().setFromVector3(camera.position);
    const _intro = _cfg.camera?.introAnimation ?? {};
    const endSph   = new THREE.Spherical(
      _intro.radius ?? 19.55,
      THREE.MathUtils.degToRad(_intro.phi   ?? 80.9),
      THREE.MathUtils.degToRad(_intro.theta ?? -25.9),
    );
    const prog     = { t: 0 };
    gsap.to(prog, {
      t: 1,
      duration: 3.0,
      delay: 0.4,
      ease: 'power2.inOut',
      onUpdate() {
        camera.position.setFromSpherical(new THREE.Spherical(
          THREE.MathUtils.lerp(startSph.radius, endSph.radius, prog.t),
          THREE.MathUtils.lerp(startSph.phi,    endSph.phi,    prog.t),
          THREE.MathUtils.lerp(startSph.theta,  endSph.theta,  prog.t),
        ));
        camera.lookAt(lookAt);
      },
      onComplete() {
        controls.target.copy(lookAt);
        controls.update();
        controls.enabled = true;
        _camAnimating = false;
      },
    });

    if (msg) msg.textContent = 'Splat ready';
    if (bar) bar.style.width = '100%';
    setTimeout(() => { if (wrap) wrap.style.display = 'none'; }, 1200);
    return;
  } catch (err) {
    console.warn('Splat load failed:', err);
    if (msg) msg.textContent = `Splat error: ${err.message}`;
    setTimeout(() => { if (wrap) wrap.style.display = 'none'; }, 3000);
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  document.getElementById('load-msg').textContent = 'Loading config…';
  _cfg = await fetch('./data/config.json').then(r => r.json()).catch(() => ({}));

  // Apply config-driven camera initial position
  if (_cfg.camera?.initial) {
    const [px, py, pz] = _cfg.camera.initial.position ?? [0, 26.60, 0];
    const [tx, ty, tz] = _cfg.camera.initial.target ?? [0, 0, 0];
    camera.position.set(px, py, pz);
    controls.target.set(tx, ty, tz);
    controls.update();
  }

  _buildPresets(_cfg);
  _buildCamButtons(_cfg);
  _applyBranding(_cfg);

  document.getElementById('load-msg').textContent = 'Loading site data…';

  const [geoRes, trafficRes, roadsRes] = await Promise.all([
    fetch('./data/buildings.geojson').then(r => r.json()).catch(() => null),
    fetch('./data/traffic.json').then(r => r.json()).catch(() => null),
    fetch('./data/roads.json').then(r => r.json()).catch(() => null),
  ]);
  document.getElementById('load-fill').style.width = '30%';
  document.getElementById('load-msg').textContent = 'Loading satellite…';

  await _addGroundPlane();

  document.getElementById('load-fill').style.width = '70%';
  document.getElementById('load-msg').textContent = 'Building scene…';

  if (geoRes) await renderBuildings(geoRes);
  if (roadsRes) await renderRoads(roadsRes);
  _restoreCustomLabels();
  _jsonRoutes = trafficRes?.routes ?? [];
  _redrawTraffic();
  if (_debugMode) _initEditorUI();

  document.getElementById('load-fill').style.width = '100%';
  await new Promise(r => setTimeout(r, 150));
  document.getElementById('loading').classList.add('done');

  // Expose API for admin3d.js and dispatch ready event
  window._v3d = { renderer, camera, controls, _raycaster, _pickGround, renderPins, removePin, updatePinHighlight, latlngToScene, pins: _pins };
  window.dispatchEvent(new CustomEvent('viewer3d:ready'));

  // viewer3d.html: load pins/contacts and handle ?id= deep-link
  if (!document.getElementById('admin-controls')) {
    const [points, contacts] = await Promise.all([
      fetch('./data/points.json').then(r => r.json()).catch(() => []),
      fetch('./data/contacts.json').then(r => r.json()).catch(() => []),
    ]);
    _allContacts = contacts;
    renderPins(points);
    renderPointList(points);
  }

  // Load splat in background — scene is already usable without it
  loadSplatBackground();
}

boot();
