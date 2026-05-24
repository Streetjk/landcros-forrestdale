import * as THREE from 'three';
import { SVD } from 'svd-js';

let _viewers = [];
let _sliderX = 0.5;
let _canvasEl = null;
let _renderer = null;
let _camera   = null;
let _scene    = null;
let _active   = false;
let _splitDirty = false;
let _bgViewer = null;
let _skyObj = null;
let _splatGroup = null;
let _lastCamPos = new THREE.Vector3();
let _lastCamQuat = new THREE.Quaternion();
let _needsSort = true;

const SPLAT_STRIDE = 32;
const LS_KEY = 'sn_comp_transforms';
const LS_ALIGN = 'sn_comp_align';

const _align = {
  enabled: false,
  picking: null,
  pairs: [],
  panel: null,
};

// -----------------------------------------------------------------------
// Splat scanning — returns bounds + raw positions for pick proxy
// -----------------------------------------------------------------------

async function scanSplatData(path) {
  const result = { scale: 1, cx: 0, cy: 0, cz: 0, rawPositions: null };
  if (!path.toLowerCase().endsWith('.splat')) return result;

  const rawBuf = await fetch(path).then(r => {
    if (!r.ok) throw new Error(`Failed to scan ${path}: ${r.status}`);
    return r.arrayBuffer();
  });
  const count = Math.floor(rawBuf.byteLength / SPLAT_STRIDE);
  if (!count) return result;

  const dv = new DataView(rawBuf);
  const positions = new Float32Array(count * 3);
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < count; i++) {
    const o = i * SPLAT_STRIDE;
    const x = dv.getFloat32(o,     true);
    const y = dv.getFloat32(o + 4, true);
    const z = dv.getFloat32(o + 8, true);
    positions[i * 3]     = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (!Number.isFinite(span) || span <= 0) return result;

  result.scale = 40 / span;
  result.cx = (minX + maxX) / 2;
  result.cy = (minY + maxY) / 2;
  result.cz = (minZ + maxZ) / 2;
  result.rawPositions = positions;
  return result;
}

// -----------------------------------------------------------------------
// Pick proxy — invisible THREE.Points sharing splatMesh transform
// -----------------------------------------------------------------------

function createPickProxy(v) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(v.rawPositions, 3));
  geo.computeBoundingSphere();
  const mat = new THREE.PointsMaterial({
    size: 0.01, sizeAttenuation: true,
    transparent: true, opacity: 0, depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.visible = false;
  pts.layers.set(1);
  _scene.add(pts);
  v.pickProxy = pts;
}

function syncPickProxy(v) {
  const mesh = v.viewer.splatMesh;
  mesh.updateMatrixWorld(true);
  const p = v.pickProxy;
  p.position.copy(mesh.position);
  p.rotation.copy(mesh.rotation);
  p.scale.copy(mesh.scale);
  p.updateMatrixWorld(true);
}

// -----------------------------------------------------------------------
// Markers — small colored spheres at picked points
// -----------------------------------------------------------------------

function addMarker(v, worldPos, label) {
  const geo = new THREE.SphereGeometry(0.15, 8, 8);
  const color = v.side === 'left' ? 0x3b82f6 : 0xf59e0b;
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(worldPos);
  mesh.renderOrder = 10;
  mesh.userData.alignLabel = label;
  mesh.userData.side = v.side;
  _scene.add(mesh);
  if (!v.markers) v.markers = [];
  v.markers.push(mesh);
  return mesh;
}

function removeMarker(label) {
  for (const v of _viewers) {
    if (!v.markers) continue;
    const idx = v.markers.findIndex(m => m.userData.alignLabel === label);
    if (idx !== -1) {
      const m = v.markers[idx];
      _scene.remove(m); m.geometry.dispose(); m.material.dispose();
      v.markers.splice(idx, 1);
    }
  }
}

function clearMarkers() {
  for (const v of _viewers) {
    if (!v.markers) continue;
    for (const m of v.markers) { _scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    v.markers = [];
  }
}

function removePair(index) {
  if (index < 0 || index >= _align.pairs.length) return;
  removeMarker(`R${index + 1}`);
  removeMarker(`A${index + 1}`);
  _align.pairs.splice(index, 1);
  // Renumber remaining markers
  clearMarkers();
  for (let i = 0; i < _align.pairs.length; i++) {
    const p = _align.pairs[i];
    if (p.ref) {
      const lv = _viewers.find(v => v.side === 'left');
      if (lv) addMarker(lv, p.ref, `R${i + 1}`);
    }
    if (p.aligned) {
      const rv = _viewers.find(v => v.side === 'right');
      if (rv) addMarker(rv, p.aligned, `A${i + 1}`);
    }
  }
  // Resume picking if under 4
  if (_align.pairs.length < 4) {
    const lastPair = _align.pairs[_align.pairs.length - 1];
    if (!lastPair || (lastPair.ref && lastPair.aligned)) {
      _align.picking = 'left';
    } else if (lastPair.ref && !lastPair.aligned) {
      _align.picking = 'right';
    }
    _canvasEl.style.cursor = 'crosshair';
  }
  renderAlignPanel();
}

function undoLastPick() {
  if (!_align.pairs.length) return;
  const lastPair = _align.pairs[_align.pairs.length - 1];
  const idx = _align.pairs.length;
  if (lastPair.aligned) {
    removeMarker(`A${idx}`);
    lastPair.aligned = null;
    _align.picking = 'right';
  } else {
    removeMarker(`R${idx}`);
    _align.pairs.pop();
    _align.picking = 'left';
  }
  _canvasEl.style.cursor = 'crosshair';
  renderAlignPanel();
}

// -----------------------------------------------------------------------
// Slider UI
// -----------------------------------------------------------------------

function createSliderUI(container, config) {
  const slider = document.createElement('div');
  slider.id = 'splat-compare-slider';
  Object.assign(slider.style, {
    position: 'absolute', top: '0', bottom: '0', width: '36px',
    marginLeft: '-18px', cursor: 'col-resize',
    zIndex: '100', left: `${(_sliderX * 100).toFixed(1)}%`,
    transition: 'none',
  });
  const line = document.createElement('div');
  Object.assign(line.style, {
    position: 'absolute', top: '0', bottom: '0', left: '50%',
    width: '4px', marginLeft: '-2px', pointerEvents: 'none',
    background: 'rgba(255,255,255,0.8)', boxShadow: '0 0 8px rgba(0,0,0,0.5)',
  });
  slider.appendChild(line);

  const handle = document.createElement('div');
  Object.assign(handle.style, {
    position: 'absolute', top: '50%', left: '50%',
    transform: 'translate(-50%, -50%)', width: '32px', height: '32px',
    borderRadius: '50%', background: 'rgba(255,255,255,0.9)',
    border: '2px solid rgba(0,0,0,0.3)', display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    fontSize: '14px', color: '#333', pointerEvents: 'none',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
  });
  handle.textContent = '⇔';
  slider.appendChild(handle);

  const labels = config.models || [];
  if (labels.length >= 2) {
    container.appendChild(createLabel(labels[0].label || 'Model 1', 'left'));
    container.appendChild(createLabel(labels[1].label || 'Model 2', 'right'));
  }

  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    _sliderX = Math.max(0.02, Math.min(0.98, (clientX - rect.left) / rect.width));
    _splitDirty = true;
    slider.style.left = `${(_sliderX * 100).toFixed(1)}%`;
  };
  const onUp = () => { dragging = false; };
  slider.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
  slider.addEventListener('touchstart', (e) => { dragging = true; e.preventDefault(); }, { passive: false });
  slider.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchend', onUp);

  container.appendChild(slider);
  return slider;
}

function createLabel(text, side) {
  const el = document.createElement('div');
  const parts = text.match(/^(.+?)\s+(\S+\s+\d{4})$/);
  const mobile = window.innerWidth <= 767;
  Object.assign(el.style, {
    position: 'absolute', top: '35%', transform: 'translateY(-50%)', [side]: '16px',
    padding: '5px 14px', background: 'rgba(0,0,0,0.55)', color: '#fff',
    borderRadius: '6px', fontSize: mobile ? '11px' : '12px',
    fontFamily: "'DM Sans', sans-serif", fontWeight: '500',
    zIndex: '101', pointerEvents: 'none', backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
  });
  if (parts) {
    el.innerHTML = `${parts[1]}<br>${parts[2]}`;
    el.style.textAlign = 'center';
  } else {
    el.textContent = text;
  }
  return el;
}

// -----------------------------------------------------------------------
// Manual transform adjustment panel
// -----------------------------------------------------------------------

function _loadSaved() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}

function _saveTransforms() {
  const out = {};
  for (const v of _viewers) {
    const m = v.viewer.splatMesh;
    out[v.label] = {
      rx: +m.rotation.x.toFixed(4), ry: +m.rotation.y.toFixed(4), rz: +m.rotation.z.toFixed(4),
      px: +m.position.x.toFixed(3), py: +m.position.y.toFixed(3), pz: +m.position.z.toFixed(3),
      s: +m.scale.x.toFixed(4),
    };
  }
  localStorage.setItem(LS_KEY, JSON.stringify(out));
}

function _applySaved(v) {
  const saved = _loadSaved()[v.label];
  const t = saved ? {
    rx: saved.rx, ry: saved.ry, rz: saved.rz,
    px: saved.px, py: saved.py, pz: saved.pz,
    s: saved.s,
  } : v.configTransform ? {
    rx: v.configTransform.rotation[0], ry: v.configTransform.rotation[1], rz: v.configTransform.rotation[2],
    px: v.configTransform.position[0], py: v.configTransform.position[1], pz: v.configTransform.position[2],
    s: v.configTransform.scale,
  } : null;
  if (!t) return;
  const m = v.viewer.splatMesh;
  m.rotation.set(t.rx, t.ry, t.rz);
  m.position.set(t.px, t.py, t.pz);
  if (t.s) m.scale.setScalar(t.s);
}

function createAdjustPanel(container) {
  const panel = document.createElement('div');
  panel.id = 'splat-adjust-panel';
  Object.assign(panel.style, {
    position: 'absolute', top: '100px', right: '12px', zIndex: '200',
    background: 'rgba(15,17,23,0.92)', backdropFilter: 'blur(8px)',
    borderRadius: '8px', padding: '10px 12px', color: '#fff',
    fontFamily: "'DM Mono', monospace", fontSize: '10px',
    maxHeight: 'calc(100vh - 140px)', overflowY: 'auto', minWidth: '260px',
    border: '1px solid rgba(255,255,255,0.08)',
  });

  const tiltHeader = document.createElement('div');
  tiltHeader.textContent = 'Global Tilt';
  tiltHeader.style.cssText = 'font-weight:600;color:#60a5fa;margin:0 0 6px;font-size:11px';
  panel.appendChild(tiltHeader);

  const tiltAxes = [
    { label: 'TX', idx: 0, min: -1, max: 1, step: 0.005 },
    { label: 'TY', idx: 1, min: -1, max: 1, step: 0.005 },
    { label: 'TZ', idx: 2, min: -1, max: 1, step: 0.005 },
  ];
  for (const ax of tiltAxes) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:3px';
    const lbl = document.createElement('span');
    lbl.textContent = ax.label;
    lbl.style.cssText = 'color:#9ca3af;width:20px;font-size:10px';
    const numInput = document.createElement('input');
    numInput.type = 'number'; numInput.min = ax.min; numInput.max = ax.max; numInput.step = ax.step;
    numInput.value = _splatGroup.rotation.toArray()[ax.idx].toFixed(4);
    numInput.style.cssText = 'width:70px;background:#1f2937;border:1px solid #374151;color:#fff;font:10px monospace;padding:2px 4px;border-radius:3px;text-align:right';
    numInput.addEventListener('input', () => {
      const val = parseFloat(numInput.value);
      if (isNaN(val)) return;
      const arr = _splatGroup.rotation.toArray();
      arr[ax.idx] = Math.max(ax.min, Math.min(ax.max, val));
      _splatGroup.rotation.set(arr[0], arr[1], arr[2]);
      _needsSort = true;
    });
    row.appendChild(lbl); row.appendChild(numInput);
    panel.appendChild(row);
  }

  const axes = [
    { key: 'rx', label: 'RX', prop: 'rotation', idx: 0, min: -Math.PI, max: Math.PI, step: 0.005 },
    { key: 'ry', label: 'RY', prop: 'rotation', idx: 1, min: -Math.PI, max: Math.PI, step: 0.005 },
    { key: 'rz', label: 'RZ', prop: 'rotation', idx: 2, min: -Math.PI, max: Math.PI, step: 0.005 },
    { key: 'px', label: 'X',  prop: 'position', idx: 0, min: -50, max: 50, step: 0.005 },
    { key: 'py', label: 'Y',  prop: 'position', idx: 1, min: -50, max: 50, step: 0.005 },
    { key: 'pz', label: 'Z',  prop: 'position', idx: 2, min: -50, max: 50, step: 0.005 },
    { key: 's',  label: 'S',  prop: 'scale',    idx: 0, min: 0.5, max: 40, step: 0.05 },
  ];

  for (let vi = 0; vi < _viewers.length; vi++) {
    const v = _viewers[vi];
    const mesh = v.viewer.splatMesh;
    const header = document.createElement('div');
    header.textContent = v.label;
    header.style.cssText = 'font-weight:600;color:#facc15;margin:' + (vi ? '12px' : '0') + ' 0 6px;font-size:11px';
    panel.appendChild(header);

    for (const ax of axes) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:3px';
      const lbl = document.createElement('span');
      lbl.textContent = ax.label;
      lbl.style.cssText = 'color:#9ca3af;width:20px;font-size:10px';
      const cur = ax.prop === 'scale' ? mesh.scale.x : mesh[ax.prop].toArray()[ax.idx];
      const decimals = ax.step < 0.01 ? 4 : 3;

      const numInput = document.createElement('input');
      numInput.type = 'number';
      numInput.min = ax.min; numInput.max = ax.max; numInput.step = ax.step;
      numInput.value = cur.toFixed(decimals);
      numInput.style.cssText = 'width:70px;background:#1f2937;border:1px solid #374151;color:#fff;font:10px monospace;padding:2px 4px;border-radius:3px;text-align:right';

      const applyVal = (val) => {
        if (isNaN(val)) return;
        val = Math.max(ax.min, Math.min(ax.max, val));
        if (ax.prop === 'scale') { mesh.scale.setScalar(val); }
        else { const arr = mesh[ax.prop].toArray(); arr[ax.idx] = val; mesh[ax.prop].set(arr[0], arr[1], arr[2]); }
        _needsSort = true;
        _saveTransforms();
      };

      numInput.addEventListener('input', () => {
        const val = parseFloat(numInput.value);
        applyVal(val);
      });

      row.appendChild(lbl); row.appendChild(numInput);
      panel.appendChild(row);
    }
  }

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;margin-top:10px';

  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy JSON';
  copyBtn.style.cssText = 'flex:1;padding:4px 8px;background:rgba(52,211,153,0.15);border:1px solid #34d399;color:#34d399;border-radius:4px;cursor:pointer;font:10px monospace';
  copyBtn.addEventListener('click', async () => {
    const data = {};
    if (_splatGroup) {
      data._globalTilt = [+_splatGroup.rotation.x.toFixed(4), +_splatGroup.rotation.y.toFixed(4), +_splatGroup.rotation.z.toFixed(4)];
    }
    for (const v of _viewers) {
      const m = v.viewer.splatMesh;
      data[v.label] = {
        rotation: [+m.rotation.x.toFixed(4), +m.rotation.y.toFixed(4), +m.rotation.z.toFixed(4)],
        position: [+m.position.x.toFixed(3), +m.position.y.toFixed(3), +m.position.z.toFixed(3)],
        scale: +m.scale.x.toFixed(4),
      };
    }
    const text = JSON.stringify(data, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy JSON'; }, 2000);
  });

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset';
  resetBtn.style.cssText = 'flex:1;padding:4px 8px;background:rgba(239,68,68,0.15);border:1px solid #ef4444;color:#f87171;border-radius:4px;cursor:pointer;font:10px monospace';
  resetBtn.addEventListener('click', () => { localStorage.removeItem(LS_KEY); localStorage.removeItem(LS_ALIGN); location.reload(); });

  btnRow.appendChild(copyBtn); btnRow.appendChild(resetBtn);
  panel.appendChild(btnRow);
  container.appendChild(panel);
}

// -----------------------------------------------------------------------
// Umeyama alignment math (3x3 SVD via svd-js)
// -----------------------------------------------------------------------

function det3(m) {
  return m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
       - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
       + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
}

function mul3(a, b) {
  const r = [[0,0,0],[0,0,0],[0,0,0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++)
        r[i][j] += a[i][k] * b[k][j];
  return r;
}

function t3(m) {
  return [[m[0][0],m[1][0],m[2][0]],[m[0][1],m[1][1],m[2][1]],[m[0][2],m[1][2],m[2][2]]];
}

function applyR(R, v) {
  return new THREE.Vector3(
    R[0][0]*v.x + R[0][1]*v.y + R[0][2]*v.z,
    R[1][0]*v.x + R[1][1]*v.y + R[1][2]*v.z,
    R[2][0]*v.x + R[2][1]*v.y + R[2][2]*v.z,
  );
}

function meanVec3(pts) {
  const s = new THREE.Vector3();
  for (const p of pts) s.add(p);
  return s.divideScalar(pts.length);
}

function computeUmeyama(P, Q) {
  const n = P.length;
  if (n < 3 || n !== Q.length) throw new Error('Need 3+ point pairs');

  const muP = meanVec3(P);
  const muQ = meanVec3(Q);

  let varQ = 0;
  const H = [[0,0,0],[0,0,0],[0,0,0]];

  for (let i = 0; i < n; i++) {
    const p = P[i].clone().sub(muP);
    const q = Q[i].clone().sub(muQ);
    varQ += q.dot(q) / n;
    H[0][0] += q.x*p.x/n; H[0][1] += q.x*p.y/n; H[0][2] += q.x*p.z/n;
    H[1][0] += q.y*p.x/n; H[1][1] += q.y*p.y/n; H[1][2] += q.y*p.z/n;
    H[2][0] += q.z*p.x/n; H[2][1] += q.z*p.y/n; H[2][2] += q.z*p.z/n;
  }

  if (varQ < 1e-8) throw new Error('Aligned points are degenerate');

  const { u: U, v: V, q: D } = SVD(H, true, true);
  const detVU = det3(mul3(V, t3(U)));
  const S = [[1,0,0],[0,1,0],[0,0, detVU < 0 ? -1 : 1]];

  const R = mul3(mul3(V, S), t3(U));
  const scale = (D[0]*S[0][0] + D[1]*S[1][1] + D[2]*S[2][2]) / varQ;

  const rotMuQ = applyR(R, muQ).multiplyScalar(scale);
  const translation = muP.clone().sub(rotMuQ);

  return { R, scale, translation };
}

function buildAlignMatrix(R, s, t) {
  const m = new THREE.Matrix4();
  m.set(
    s*R[0][0], s*R[0][1], s*R[0][2], t.x,
    s*R[1][0], s*R[1][1], s*R[1][2], t.y,
    s*R[2][0], s*R[2][1], s*R[2][2], t.z,
    0,         0,         0,         1,
  );
  return m;
}

function computeRms(P, Q, alignMat) {
  let sum = 0;
  const tmp = new THREE.Vector3();
  for (let i = 0; i < P.length; i++) {
    tmp.copy(Q[i]).applyMatrix4(alignMat);
    sum += tmp.distanceToSquared(P[i]);
  }
  return Math.sqrt(sum / P.length);
}

// -----------------------------------------------------------------------
// Point picking
// -----------------------------------------------------------------------

const _raycaster = new THREE.Raycaster();
const _pointer = new THREE.Vector2();

function pickSplatPoint(event) {
  if (!_align.enabled || !_align.picking) return null;

  const rect = _canvasEl.getBoundingClientRect();
  const xNorm = (event.clientX - rect.left) / rect.width;
  const expectedSide = _align.picking;
  const side = xNorm <= _sliderX ? 'left' : 'right';
  if (side !== expectedSide) {
    console.log(`[align] Clicked ${side} side but expecting ${expectedSide}`);
    return null;
  }

  const v = _viewers.find(vw => vw.side === expectedSide);
  if (!v?.pickProxy) return null;

  _pointer.x = xNorm * 2 - 1;
  _pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  syncPickProxy(v);

  // Threshold in world units — generous to ensure hits
  _raycaster.params.Points.threshold = 0.5;
  _raycaster.layers.set(1);
  _raycaster.setFromCamera(_pointer, _camera);

  // Proxy must be visible for raycast to work
  v.pickProxy.visible = true;
  const hits = _raycaster.intersectObject(v.pickProxy, false);
  v.pickProxy.visible = false;

  if (!hits.length) {
    console.log(`[align] No hit on ${expectedSide} (${v.rawPositions.length / 3} splats)`);
    return null;
  }

  const hit = hits[0];
  const local = new THREE.Vector3().fromBufferAttribute(
    v.pickProxy.geometry.attributes.position, hit.index
  );
  const world = local.clone().applyMatrix4(v.pickProxy.matrixWorld);
  console.log(`[align] Picked ${expectedSide} point:`, world.x.toFixed(2), world.y.toFixed(2), world.z.toFixed(2));
  return { viewer: v, world, index: hit.index };
}

// -----------------------------------------------------------------------
// Alignment panel UI
// -----------------------------------------------------------------------

function createAlignmentPanel(container) {
  const panel = document.createElement('div');
  panel.id = 'splat-align-panel';
  Object.assign(panel.style, {
    position: 'absolute', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
    zIndex: '200', background: 'rgba(15,17,23,0.94)', backdropFilter: 'blur(8px)',
    borderRadius: '8px', padding: '10px 14px', color: '#fff',
    fontFamily: "'DM Mono', monospace", fontSize: '11px',
    border: '1px solid rgba(255,255,255,0.08)', minWidth: '340px',
  });
  _align.panel = panel;
  container.appendChild(panel);
  renderAlignPanel();

  _canvasEl.addEventListener('click', onAlignClick);
}

function onAlignClick(e) {
  if (!_align.enabled || !_align.picking) return;
  const result = pickSplatPoint(e);
  if (!result) return;

  const pairIdx = Math.floor(_align.pairs.length);
  const side = _align.picking;

  if (side === 'left') {
    _align.pairs.push({ ref: result.world, aligned: null });
    addMarker(result.viewer, result.world, `R${pairIdx + 1}`);
    _align.picking = 'right';
  } else {
    if (pairIdx < 1) return;
    const pair = _align.pairs[_align.pairs.length - 1];
    if (pair.aligned) {
      _align.pairs.push({ ref: null, aligned: result.world });
    } else {
      pair.aligned = result.world;
    }
    addMarker(result.viewer, result.world, `A${_align.pairs.length}`);
    if (_align.pairs.length >= 4) {
      _align.picking = null;
      _canvasEl.style.cursor = '';
    } else {
      _align.picking = 'left';
    }
  }
  renderAlignPanel();
}

function getCompletePairs() {
  return _align.pairs.filter(p => p.ref && p.aligned);
}

function renderAlignPanel() {
  const panel = _align.panel;
  if (!panel) return;

  const pairs = getCompletePairs();
  const canAlign = pairs.length >= 3;

  let html = '<div style="font-weight:600;color:#a78bfa;margin-bottom:6px;font-size:12px">POINT ALIGNMENT</div>';

  if (!_align.enabled) {
    html += `<button id="align-start" style="padding:5px 12px;background:rgba(167,139,250,0.15);border:1px solid #a78bfa;color:#c4b5fd;border-radius:4px;cursor:pointer;font:11px monospace;width:100%">Start alignment (pick 3-4 point pairs)</button>`;
  } else {
    const complete = pairs.length;
    const needed = Math.max(0, 3 - complete);

    if (_align.picking) {
      const pairNum = _align.picking === 'left' ? _align.pairs.length + 1 : _align.pairs.length;
      const sideLabel = _align.picking === 'left' ? 'LEFT (reference)' : 'RIGHT (to align)';
      const prefix = _align.picking === 'left' ? 'R' : 'A';
      html += `<div style="color:#fcd34d;margin-bottom:4px;font-size:12px">Click ${prefix}${pairNum} on ${sideLabel}</div>`;
    }

    if (needed > 0) {
      html += `<div style="color:#6b7280;margin-bottom:6px;font-size:10px">${complete}/3 pairs (need ${needed} more)</div>`;
    } else if (_align.pairs.length >= 4) {
      html += `<div style="color:#34d399;margin-bottom:6px;font-size:10px">4/4 pairs ready</div>`;
    } else {
      html += `<div style="color:#34d399;margin-bottom:6px;font-size:10px">${complete}/3 pairs ready — can align now or add more</div>`;
    }

    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:6px">';
    html += '<tr style="color:#6b7280;font-size:9px"><th style="text-align:left">#</th><th style="text-align:left">Ref (L)</th><th style="text-align:left">Aligned (R)</th><th></th></tr>';
    for (let i = 0; i < _align.pairs.length; i++) {
      const p = _align.pairs[i];
      const refStr = p.ref ? `${p.ref.x.toFixed(1)}, ${p.ref.y.toFixed(1)}, ${p.ref.z.toFixed(1)}` : '...';
      const alStr = p.aligned ? `${p.aligned.x.toFixed(1)}, ${p.aligned.y.toFixed(1)}, ${p.aligned.z.toFixed(1)}` : '...';
      html += `<tr style="color:#d1d5db;font-size:10px"><td style="padding:2px 4px">${i+1}</td><td style="padding:2px 4px;color:#3b82f6">${refStr}</td><td style="padding:2px 4px;color:#f59e0b">${alStr}</td><td style="padding:2px"><button data-del-pair="${i}" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:11px;padding:0 4px" title="Remove pair ${i+1}">x</button></td></tr>`;
    }
    html += '</table>';

    if (_align.rms != null) {
      html += `<div style="color:#34d399;margin-bottom:6px">RMS error: ${_align.rms.toFixed(4)}</div>`;
    }

    html += '<div style="display:flex;gap:6px">';
    if (canAlign) {
      html += `<button id="align-run" style="flex:1;padding:4px 8px;background:rgba(52,211,153,0.2);border:1px solid #34d399;color:#34d399;border-radius:4px;cursor:pointer;font:10px monospace">Align (${complete} pts)</button>`;
    }
    if (_align.pairs.length > 0) {
      html += `<button id="align-undo" style="flex:1;padding:4px 8px;background:rgba(251,191,36,0.15);border:1px solid #f59e0b;color:#fbbf24;border-radius:4px;cursor:pointer;font:10px monospace">Undo</button>`;
    }
    html += `<button id="align-clear" style="flex:1;padding:4px 8px;background:rgba(239,68,68,0.15);border:1px solid #ef4444;color:#f87171;border-radius:4px;cursor:pointer;font:10px monospace">Clear all</button>`;
    html += `<button id="align-cancel" style="flex:1;padding:4px 8px;background:rgba(107,114,128,0.15);border:1px solid #6b7280;color:#9ca3af;border-radius:4px;cursor:pointer;font:10px monospace">Done</button>`;
    html += '</div>';
  }

  panel.innerHTML = html;

  panel.querySelector('#align-start')?.addEventListener('click', () => {
    _align.enabled = true;
    _align.picking = 'left';
    _align.pairs = [];
    _align.rms = null;
    clearMarkers();
    _canvasEl.style.cursor = 'crosshair';
    renderAlignPanel();
  });

  panel.querySelector('#align-run')?.addEventListener('click', () => {
    runAlignment();
  });

  panel.querySelector('#align-undo')?.addEventListener('click', () => {
    undoLastPick();
  });

  panel.querySelectorAll('[data-del-pair]').forEach(btn => {
    btn.addEventListener('click', () => {
      removePair(parseInt(btn.dataset.delPair));
    });
  });

  panel.querySelector('#align-clear')?.addEventListener('click', () => {
    _align.pairs = [];
    _align.picking = 'left';
    _align.rms = null;
    clearMarkers();
    _canvasEl.style.cursor = 'crosshair';
    renderAlignPanel();
  });

  panel.querySelector('#align-cancel')?.addEventListener('click', () => {
    _align.enabled = false;
    _align.picking = null;
    _align.rms = null;
    clearMarkers();
    _canvasEl.style.cursor = '';
    renderAlignPanel();
  });
}

function runAlignment() {
  const pairs = getCompletePairs();
  if (pairs.length < 3) return;

  const P = pairs.map(p => p.ref.clone());
  const Q = pairs.map(p => p.aligned.clone());

  try {
    const { R, scale, translation } = computeUmeyama(P, Q);
    const alignMat = buildAlignMatrix(R, scale, translation);

    const rightV = _viewers.find(v => v.side === 'right');
    if (!rightV) return;

    const mesh = rightV.viewer.splatMesh;
    mesh.updateMatrixWorld(true);
    const currentWorld = mesh.matrixWorld.clone();
    const nextWorld = alignMat.clone().multiply(currentWorld);

    nextWorld.decompose(mesh.position, mesh.quaternion, mesh.scale);
    mesh.rotation.setFromQuaternion(mesh.quaternion);
    mesh.updateMatrixWorld(true);

    _align.rms = computeRms(P, Q, alignMat);
    _needsSort = true;
    _saveTransforms();

    console.log(`[splat-compare] Aligned with RMS=${_align.rms.toFixed(4)}, scale=${scale.toFixed(4)}`);
    renderAlignPanel();
  } catch (err) {
    console.warn('[splat-compare] Alignment failed:', err);
    _align.rms = null;
    renderAlignPanel();
  }
}

// -----------------------------------------------------------------------
// Visibility management for scissor rendering
// -----------------------------------------------------------------------

function setEntryVisible(v, visible) {
  v.viewer.splatMesh.visible = visible;
  if (v.markers) {
    for (const m of v.markers) m.visible = visible && _align.enabled;
  }
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

export async function initComparison(cfg, sceneRef, rendererRef, cameraRef, rotation, onProgress) {
  const compCfg = cfg.comparison;
  if (!compCfg?.enabled || !compCfg.models?.length || compCfg.models.length < 2) return;

  _scene    = sceneRef;
  _renderer = rendererRef;
  _camera   = cameraRef;
  _canvasEl = rendererRef.domElement;
  _sliderX  = compCfg.slider?.startPosition ?? 0.5;

  const [sr0, sr1, sr2] = rotation || cfg.splat?.rotation || [0, 0, 0];
  const [so0, so1, so2] = cfg.splat?.centerOffset ?? [0, 0, 0];
  const GS3D = await import('@mkkellogg/gaussian-splats-3d');

  _splatGroup = new THREE.Group();
  const gt = compCfg.globalTilt || [0, 0, 0];
  _splatGroup.rotation.set(gt[0], gt[1], gt[2]);
  _scene.add(_splatGroup);

  for (let i = 0; i < compCfg.models.length; i++) {
    const model = compCfg.models[i];
    const bounds = await scanSplatData(model.splat);

    const sv = new GS3D.Viewer({
      selfDrivenMode: false, useBuiltInControls: false,
      renderer: _renderer, camera: _camera,
      gpuAcceleratedSort: false, sharedMemoryForWorkers: false,
      splatAlphaRemovalThreshold: 1,
    });

    await sv.addSplatScene(model.splat, { showLoadingUI: false });

    sv.splatMesh.scale.setScalar(bounds.scale);
    sv.splatMesh.rotation.set(sr0, sr1, sr2);
    sv.splatMesh.position.set(
      -bounds.cx * bounds.scale + so0, so1, bounds.cz * bounds.scale + so2,
    );
    sv.splatMesh.renderOrder = 1;
    if (sv.splatMesh.material) sv.splatMesh.material.depthTest = true;

    const side = i === 0 ? 'left' : 'right';
    sv.splatMesh.visible = false;
    _splatGroup.add(sv.splatMesh);

    const entry = { viewer: sv, side, label: model.label, rawPositions: bounds.rawPositions, markers: [], configTransform: model.transform || null };
    _viewers.push(entry);
    _applySaved(entry);
    createPickProxy(entry);
    if (onProgress) onProgress(Math.round(((i + 1) / compCfg.models.length) * 100));
  }

  const bgCfg = compCfg.background;
  const bgPath = typeof bgCfg === 'string' ? bgCfg : bgCfg?.splat;
  if (bgPath) {
    try {
      const bgBounds = await scanSplatData(bgPath);
      const bgSv = new GS3D.Viewer({
        selfDrivenMode: false, useBuiltInControls: false,
        renderer: _renderer, camera: _camera,
        gpuAcceleratedSort: false, sharedMemoryForWorkers: false,
        splatAlphaRemovalThreshold: 0,
      });
      await bgSv.addSplatScene(bgPath, { showLoadingUI: false });

      const bgT = typeof bgCfg === 'object' ? bgCfg.transform : null;
      if (bgT) {
        bgSv.splatMesh.rotation.set(bgT.rotation[0], bgT.rotation[1], bgT.rotation[2]);
        bgSv.splatMesh.position.set(bgT.position[0], bgT.position[1], bgT.position[2]);
        bgSv.splatMesh.scale.setScalar(bgT.scale);
      } else {
        bgSv.splatMesh.scale.setScalar(bgBounds.scale);
        bgSv.splatMesh.rotation.set(sr0, sr1, sr2);
        bgSv.splatMesh.position.set(
          -bgBounds.cx * bgBounds.scale + so0, so1, bgBounds.cz * bgBounds.scale + so2,
        );
      }

      bgSv.splatMesh.renderOrder = 2;
      if (bgSv.splatMesh.material) bgSv.splatMesh.material.depthTest = true;
      bgSv.splatMesh.visible = false;
      _splatGroup.add(bgSv.splatMesh);
      _bgViewer = bgSv;
      console.log('[splat-compare] Background splat loaded');
    } catch (e) {
      console.warn('[splat-compare] Background splat failed:', e);
    }
  }

  _scene.traverse(obj => {
    if (obj.isMesh && obj.material?.uniforms?.sunPosition) {
      _skyObj = obj;
      obj.material.fog = false;
    }
  });

  _scene.fog = new THREE.FogExp2(0x8fa4bf, 0.012);

  const container = _canvasEl.parentElement;
  createSliderUI(container, compCfg);

  _active = true;
  console.log(`[splat-compare] Loaded ${_viewers.length} models with scissor rendering`);
}

export function updateComparison() {
  if (!_active || !_renderer || !_canvasEl) return false;

  if (!_camera.position.equals(_lastCamPos) || !_camera.quaternion.equals(_lastCamQuat)) {
    _needsSort = true;
    _lastCamPos.copy(_camera.position);
    _lastCamQuat.copy(_camera.quaternion);
  }

  const size = new THREE.Vector2();
  _renderer.getSize(size);
  const pw = size.x;
  const ph = size.y;
  const pr = _renderer.getPixelRatio();
  const splitPx = Math.round(_sliderX * pw * pr) / pr;

  _renderer.autoClear = false;

  // Pass 1: sky (full canvas)
  _renderer.setScissorTest(false);
  _renderer.setViewport(0, 0, pw, ph);
  _renderer.clear(true, true, true);
  if (_skyObj) {
    _skyObj.visible = true;
    _renderer.render(_scene, _camera);
    _skyObj.visible = false;
  }

  // Pass 2: background splat (full canvas)
  _renderer.clearDepth();
  _renderer.setScissorTest(false);
  if (_bgViewer) {
    if (_needsSort) _bgViewer.update();
    _bgViewer.splatMesh.visible = true;
    _renderer.render(_scene, _camera);
    _bgViewer.splatMesh.visible = false;
  }

  // Pass 3: comparison models (scissored, on top)
  _renderer.clearDepth();
  _renderer.setScissorTest(true);

  for (const v of _viewers) {
    if (_needsSort) v.viewer.update();
    setEntryVisible(v, true);

    if (v.side === 'left') {
      _renderer.setScissor(0, 0, splitPx, ph);
    } else {
      _renderer.setScissor(splitPx, 0, Math.max(0, pw - splitPx), ph);
    }

    _renderer.render(_scene, _camera);
    setEntryVisible(v, false);
  }

  if (_skyObj) _skyObj.visible = true;
  _needsSort = false;
  _splitDirty = false;
  return true;
}

export function isActive() { return _active; }
export function comparisonNeedsRender() { return _active && _splitDirty; }

export function setSliderPosition(normalized) {
  _sliderX = Math.max(0, Math.min(1, normalized));
  const sliderEl = document.getElementById('splat-compare-slider');
  if (sliderEl) sliderEl.style.left = `${(_sliderX * 100).toFixed(1)}%`;
}

export function getSliderPosition() { return _sliderX; }
