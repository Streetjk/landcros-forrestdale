// scene-editor.js — Phase 2 SLICE 2b: visual scene-object editor (label/button
// kinds only — STL 'model' and 'widget' scripts are later slices).
//
// Wires the three.js engine exposed by viewer3d.js (window._v3d, see the
// 'viewer3d:ready' event) to the slice-2a persistence API
// (/api/sites/:slug/objects). Kept as a separate page/module from
// admin3d.html/admin3d.js — this must not touch the existing pin/contact
// admin surface.

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const SLUG = new URLSearchParams(location.search).get('site');

// ── State ────────────────────────────────────────────────────────────────
let _v3d              = null;
let _scene             = null;
let _transformControls = null;
let _objects           = new Map(); // id -> { obj, anchor, raycastMesh, css2dObj, div }
let _selectedId        = null;
let _placingKind       = null; // 'label' | 'button' | null
let _justDragged       = false;
const _saveTimers      = new Map();

if (!SLUG) {
  document.getElementById('no-site-msg').style.display = 'block';
} else {
  window.addEventListener('viewer3d:ready', init);
}

// ── Init (fires after viewer3d boot completes) ──────────────────────────
async function init() {
  _v3d = window._v3d;
  _scene = _v3d._pickGround.parent;

  _transformControls = new TransformControls(_v3d.camera, _v3d.renderer.domElement);
  _transformControls.setMode('translate');
  _scene.add(_transformControls);
  _transformControls.addEventListener('dragging-changed', e => { _v3d.controls.enabled = !e.value; });
  _transformControls.addEventListener('objectChange', onTransformChange);
  _transformControls.addEventListener('mouseUp', () => { _justDragged = true; if (_selectedId) scheduleSave(_selectedId); });

  const wrap = _v3d.renderer.domElement.parentElement;
  wrap.addEventListener('pointerdown', onWrapPointerDown, { capture: true });
  wrap.addEventListener('pointerup', onWrapPointerUp, { capture: true });
  wrap.addEventListener('click', onWrapClick, { capture: true });

  document.getElementById('add-label-btn').addEventListener('click', () => togglePlacing('label'));
  document.getElementById('add-button-btn').addEventListener('click', () => togglePlacing('button'));
  document.getElementById('prop-text').addEventListener('input', onPropTextInput);
  document.getElementById('prop-delete-btn').addEventListener('click', onDeleteClick);
  document.addEventListener('keydown', onKeydown);

  await loadObjects();

  // Test hook (Playwright smoke test) — not used by the editor itself.
  window.__sceneEditor = {
    slug: SLUG,
    getObjects: () => Array.from(_objects.values()).map(e => e.obj),
  };
}

// ── Load ─────────────────────────────────────────────────────────────────
async function loadObjects() {
  let list = [];
  try {
    const r = await fetch(`/api/sites/${encodeURIComponent(SLUG)}/objects`);
    if (r.ok) list = await r.json();
  } catch {
    showToast('Could not load scene objects');
  }
  list.filter(o => o.kind === 'label' || o.kind === 'button').forEach(renderObject);
}

// ── Render (kind → mesh + CSS2D text) ───────────────────────────────────
function objectDisplayText(obj) {
  return obj.kind === 'button' ? (obj.props?.label ?? '') : (obj.props?.text ?? '');
}

function renderObject(obj) {
  const [x, y, z] = obj.transform?.position ?? [0, 0, 0];
  const anchor = new THREE.Object3D();
  anchor.position.set(x, y, z);

  let raycastMesh;
  if (obj.kind === 'button') {
    raycastMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.4, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x0f766e })
    );
    raycastMesh.position.y = 0.2;
  } else {
    // Label: invisible sphere as the raycast hit target (text does the visual work).
    raycastMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 8, 6),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    raycastMesh.position.y = 0.1;
  }
  anchor.add(raycastMesh);

  const div = document.createElement('div');
  div.className = 'scene-obj-label';
  const bg = obj.kind === 'button' ? 'rgba(15,118,110,0.88)' : 'rgba(24,95,165,0.88)';
  div.style.cssText = `pointer-events:none;white-space:nowrap;font:600 13px 'DM Sans',sans-serif;color:#fff;background:${bg};padding:3px 8px;border-radius:6px;transform:translate(-50%,-130%);`;
  div.textContent = objectDisplayText(obj);
  const css2dObj = new CSS2DObject(div);
  css2dObj.position.set(0, obj.kind === 'button' ? 0.4 : 0.1, 0);
  anchor.add(css2dObj);

  _scene.add(anchor);
  const entry = { obj, anchor, raycastMesh, css2dObj, div };
  _objects.set(obj.id, entry);
  return entry;
}

function disposeEntry(id) {
  const entry = _objects.get(id);
  if (!entry) return;
  if (_selectedId === id) deselect();
  _scene.remove(entry.anchor);
  entry.raycastMesh.geometry.dispose();
  entry.raycastMesh.material.dispose();
  if (entry.div.parentNode) entry.div.parentNode.removeChild(entry.div);
  clearTimeout(_saveTimers.get(id));
  _saveTimers.delete(id);
  _objects.delete(id);
}

// ── Placement mode ───────────────────────────────────────────────────────
function togglePlacing(kind) {
  if (_placingKind === kind) { setPlacing(null); return; }
  deselect();
  setPlacing(kind);
}

function setPlacing(kind) {
  _placingKind = kind;
  document.getElementById('add-label-btn').classList.toggle('active', kind === 'label');
  document.getElementById('add-button-btn').classList.toggle('active', kind === 'button');
  document.getElementById('placement-hint').style.display = kind ? 'block' : 'none';
  document.getElementById('canvas-wrap').style.cursor = kind ? 'crosshair' : '';
}

function setRaycasterFromEvent(e) {
  const canvas = _v3d.renderer.domElement;
  const rect = canvas.getBoundingClientRect();
  const nx = (e.clientX - rect.left) / rect.width * 2 - 1;
  const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _v3d._raycaster.setFromCamera({ x: nx, y: ny }, _v3d.camera);
}

function placeFromEvent(e) {
  setRaycasterFromEvent(e);
  const hits = _v3d._raycaster.intersectObject(_v3d._pickGround);
  const pos = hits.length
    ? hits[0].point
    : { x: _v3d.controls.target.x, y: 0, z: _v3d.controls.target.z };
  const kind = _placingKind;
  setPlacing(null);
  createObject(kind, pos);
}

async function createObject(kind, pos) {
  const id = crypto.randomUUID();
  const obj = {
    id, kind,
    transform: { position: [pos.x, pos.y, pos.z], rotation: [0, 0, 0], scale: [1, 1, 1] },
    style: {},
    props: kind === 'label' ? { text: 'New label' } : { label: 'Button', action: 'none' },
  };
  renderObject(obj);
  select(id);
  const saved = await apiWrite(`/api/sites/${encodeURIComponent(SLUG)}/objects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  if (!saved) { disposeEntry(id); return; }
  const entry = _objects.get(id);
  if (entry) { entry.obj.createdAt = saved.createdAt; entry.obj.updatedAt = saved.updatedAt; }
}

// ── Selection ────────────────────────────────────────────────────────────
function selectFromEvent(e) {
  setRaycasterFromEvent(e);
  const meshes = Array.from(_objects.values()).map(en => en.raycastMesh);
  if (!meshes.length) { deselect(); return; }
  const hits = _v3d._raycaster.intersectObjects(meshes);
  if (!hits.length) { deselect(); return; }
  const hitMesh = hits[0].object;
  const found = Array.from(_objects.entries()).find(([, en]) => en.raycastMesh === hitMesh);
  if (found) select(found[0]);
}

function select(id) {
  const entry = _objects.get(id);
  if (!entry) return;
  _selectedId = id;
  _transformControls.attach(entry.anchor);
  showPropertyPanel(entry.obj);
}

function deselect() {
  _selectedId = null;
  _transformControls.detach();
  hidePropertyPanel();
}

function showPropertyPanel(obj) {
  document.getElementById('empty-selection').style.display = 'none';
  document.getElementById('property-panel').style.display = 'flex';
  document.getElementById('prop-kind-label').textContent = obj.kind === 'button' ? 'Button label' : 'Label text';
  document.getElementById('prop-text').value = objectDisplayText(obj);
}

function hidePropertyPanel() {
  document.getElementById('property-panel').style.display = 'none';
  document.getElementById('empty-selection').style.display = 'block';
}

// ── Move (TransformControls) ────────────────────────────────────────────
function onTransformChange() {
  if (!_selectedId) return;
  const entry = _objects.get(_selectedId);
  if (!entry) return;
  const p = entry.anchor.position;
  entry.obj.transform.position = [p.x, p.y, p.z];
  scheduleSave(_selectedId);
}

// ── Edit text ────────────────────────────────────────────────────────────
function onPropTextInput(e) {
  if (!_selectedId) return;
  const entry = _objects.get(_selectedId);
  if (!entry) return;
  const val = e.target.value;
  if (entry.obj.kind === 'button') entry.obj.props.label = val;
  else entry.obj.props.text = val;
  entry.div.textContent = val;
  scheduleSave(_selectedId);
}

// ── Delete ───────────────────────────────────────────────────────────────
async function onDeleteClick() {
  if (!_selectedId) return;
  const id = _selectedId;
  deselect();
  const ok = await apiWrite(`/api/sites/${encodeURIComponent(SLUG)}/objects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (ok) disposeEntry(id);
  else select(id); // write failed — restore selection so the user can retry
}

// ── Debounced save (move + text edits share one path) ───────────────────
function scheduleSave(id) {
  clearTimeout(_saveTimers.get(id));
  _saveTimers.set(id, setTimeout(() => flushSave(id), 400));
}

async function flushSave(id) {
  _saveTimers.delete(id);
  const entry = _objects.get(id);
  if (!entry) return;
  await apiWrite(`/api/sites/${encodeURIComponent(SLUG)}/objects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry.obj),
  });
}

// ── Canvas pointer wiring (mirrors admin3d.js's placement pattern) ──────
function onWrapPointerDown(e) {
  if (e.button !== 0 || !_placingKind) return;
  if (!e.target.closest('#cam-presets')) e.stopPropagation();
}

function onWrapPointerUp(e) {
  if (e.button !== 0 || !_placingKind) return;
  if (e.target.closest('#cam-presets, #nav-progress, #splat-progress')) return;
  e.stopPropagation();
  placeFromEvent(e);
}

function onWrapClick(e) {
  if (e.target.closest('#cam-presets, #nav-progress, #splat-progress')) return;
  if (_justDragged) { _justDragged = false; return; }
  if (_placingKind) { e.stopPropagation(); return; }
  selectFromEvent(e);
}

function onKeydown(e) {
  if (e.key !== 'Escape') return;
  if (_placingKind) setPlacing(null);
  else if (_selectedId) deselect();
}

// ── Write helper: centralises 401/403/error handling ────────────────────
async function apiWrite(url, options) {
  let res;
  try {
    res = await fetch(url, { ...options, credentials: 'same-origin' });
  } catch {
    showToast('Network error — check your connection');
    return null;
  }
  if (res.status === 401) {
    window._snShowLoginGate?.();
    showToast('Session expired — please sign in');
    return null;
  }
  if (res.status === 403) {
    document.getElementById('readonly-msg').style.display = 'block';
    showToast('Read-only — you need editor access to save changes');
    return null;
  }
  if (!res.ok) {
    showToast(`Save failed (${res.status})`);
    return null;
  }
  document.getElementById('readonly-msg').style.display = 'none';
  try { return await res.json(); } catch { return {}; }
}

// ── Toast ────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}
