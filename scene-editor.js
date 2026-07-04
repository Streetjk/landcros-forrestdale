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
import { generateQR } from './qr.js';

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
let _editingScriptId   = null;
let _scenes            = []; // scenes this site owns (Scenes feature, Slice 4)
let _currentSceneId    = null;

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
  document.getElementById('add-widget-btn').addEventListener('click', () => togglePlacing('widget'));
  document.getElementById('add-scene-btn').addEventListener('click', onAddSceneClick);
  document.getElementById('new-scene-confirm-btn').addEventListener('click', onNewSceneConfirm);
  document.getElementById('new-scene-cancel-btn').addEventListener('click', onNewSceneCancel);
  document.getElementById('new-scene-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') onNewSceneConfirm();
    if (e.key === 'Escape') onNewSceneCancel();
  });
  document.getElementById('scene-share-copy-btn').addEventListener('click', onCopySceneShareUrl);
  document.getElementById('prop-text').addEventListener('input', onPropTextInput);
  document.getElementById('prop-delete-btn').addEventListener('click', onDeleteClick);
  document.getElementById('prop-action-type').addEventListener('change', onActionTypeChange);
  ['prop-action-url', 'prop-action-preset', 'prop-action-title', 'prop-action-body'].forEach(id => {
    document.getElementById(id).addEventListener('input', onActionFieldInput);
  });
  document.getElementById('prop-widget-script').addEventListener('change', onPropWidgetScriptChange);
  document.getElementById('manage-scripts-btn').addEventListener('click', openScriptsModal);
  document.getElementById('scripts-modal-close').addEventListener('click', closeScriptsModal);
  document.getElementById('save-new-script-btn').addEventListener('click', onSaveNewScriptClick);
  document.addEventListener('keydown', onKeydown);

  updateAddButtonsEnabled();
  await loadScenes();

  // Test hook (Playwright smoke test) — not used by the editor itself.
  window.__sceneEditor = {
    slug: SLUG,
    getObjects: () => Array.from(_objects.values()).map(e => e.obj),
  };
}

// ── Scenes (Scenes feature, Slice 4) ────────────────────────────────────
// The editor's canvas always shows exactly one scene's objects at a time —
// scene_objects.scene_id is NOT NULL (Scenes Slice 1), so there is no
// "unscoped" set of objects to fall back to. Selecting a scene clears the
// canvas and loads only that scene's objects; placement is disabled until a
// scene exists and is selected.
async function loadScenes() {
  try {
    const r = await fetch(`/api/sites/${encodeURIComponent(SLUG)}/scenes`);
    if (r.ok) _scenes = await r.json();
  } catch {
    showToast('Could not load scenes');
  }
  renderScenesList();
  if (!_currentSceneId && _scenes.length) await selectScene(_scenes[0].id);
}

function renderScenesList() {
  const list = document.getElementById('scenes-list');
  list.replaceChildren();
  _scenes.forEach(scene => {
    const row = document.createElement('div');
    row.className = 'scene-list-item' + (scene.id === _currentSceneId ? ' active' : '');
    const name = document.createElement('span');
    name.textContent = scene.name;
    row.appendChild(name);
    const del = document.createElement('button');
    del.className = 'scene-del-btn';
    del.textContent = '✕';
    del.title = 'Delete scene';
    del.addEventListener('click', e => { e.stopPropagation(); onDeleteSceneClick(scene.id); });
    row.appendChild(del);
    row.addEventListener('click', () => selectScene(scene.id));
    list.appendChild(row);
  });
}

async function selectScene(id) {
  if (id === _currentSceneId) return;
  deselect();
  // Flush pending debounced saves before clearing the canvas — otherwise an
  // in-flight edit (scheduleSave/flushSave, 400ms debounce) is silently
  // dropped: disposeEntry() clearTimeouts the pending save without sending it.
  await flushAllPending();
  Array.from(_objects.keys()).forEach(disposeEntry);
  _currentSceneId = id;
  renderScenesList();
  updateAddButtonsEnabled();
  const scene = _scenes.find(s => s.id === id);
  if (scene) showSceneShare(scene);
  await loadObjects();
}

function showSceneShare(scene) {
  const row = document.getElementById('scene-share-row');
  const input = document.getElementById('scene-share-url');
  const qrWrap = document.getElementById('scene-qr-wrap');
  const url = `${location.origin}/s/${scene.shareCode}`;
  input.value = url;
  qrWrap.replaceChildren();
  generateQR(url, 'scene-qr-wrap');
  row.style.display = 'block';
}

function onCopySceneShareUrl() {
  const input = document.getElementById('scene-share-url');
  if (!input.value) return;
  navigator.clipboard.writeText(input.value).catch(() => {});
  const btn = document.getElementById('scene-share-copy-btn');
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
}

function updateAddButtonsEnabled() {
  const enabled = !!_currentSceneId;
  ['add-label-btn', 'add-button-btn', 'add-widget-btn'].forEach(id => {
    document.getElementById(id).disabled = !enabled;
  });
  document.getElementById('no-scene-hint').style.display = enabled ? 'none' : 'block';
  if (!enabled) togglePlacing(null); // cancel any in-progress placement (scene switched away mid-placement)
}

function onAddSceneClick() {
  document.getElementById('new-scene-row').style.display = 'flex';
  document.getElementById('new-scene-name').value = '';
  document.getElementById('new-scene-name').focus();
}

function onNewSceneCancel() {
  document.getElementById('new-scene-row').style.display = 'none';
}

async function onNewSceneConfirm() {
  const name = document.getElementById('new-scene-name').value.trim();
  if (name.length < 1) { showToast('Scene name is required'); return; }
  const created = await apiWrite(`/api/sites/${encodeURIComponent(SLUG)}/scenes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!created) return;
  onNewSceneCancel();
  _scenes.push(created);
  await selectScene(created.id);
}

async function onDeleteSceneClick(id) {
  // Cancel (don't flush) pending autosaves for the scene being deleted —
  // its objects are about to be cascade-deleted, so saving them is wasted
  // work and could otherwise race the DELETE (a debounced save landing after
  // the scene's gone would 500 on the FK). Only the current scene can have
  // pending timers/objects loaded (switching scenes already flushes+clears).
  if (id === _currentSceneId) cancelAllPending();
  const ok = await apiWrite(`/api/sites/${encodeURIComponent(SLUG)}/scenes/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!ok) return;
  _scenes = _scenes.filter(s => s.id !== id);
  if (_currentSceneId === id) {
    _currentSceneId = null;
    Array.from(_objects.keys()).forEach(disposeEntry);
    document.getElementById('scene-share-row').style.display = 'none';
    updateAddButtonsEnabled();
    if (_scenes.length) await selectScene(_scenes[0].id);
    else renderScenesList();
  } else {
    renderScenesList();
  }
}

// ── Load ─────────────────────────────────────────────────────────────────
async function loadObjects() {
  if (!_currentSceneId) return;
  const requestedSceneId = _currentSceneId;
  let list = [];
  try {
    const r = await fetch(`/api/sites/${encodeURIComponent(SLUG)}/objects?scene=${encodeURIComponent(requestedSceneId)}`);
    if (r.ok) list = await r.json();
  } catch {
    showToast('Could not load scene objects');
  }
  // Scene may have changed again while this fetch was in flight (fast
  // clicking between scenes) — a stale response must not render into
  // whatever scene is current now.
  if (_currentSceneId !== requestedSceneId) return;
  list.filter(o => o.kind === 'label' || o.kind === 'button' || o.kind === 'widget').forEach(renderObject);
}

// ── Render (kind → mesh + CSS2D text) ───────────────────────────────────
function objectDisplayText(obj) {
  return (obj.kind === 'button' || obj.kind === 'widget') ? (obj.props?.label ?? '') : (obj.props?.text ?? '');
}

function renderObject(obj) {
  const [x, y, z] = obj.transform?.position ?? [0, 0, 0];
  const anchor = new THREE.Object3D();
  anchor.position.set(x, y, z);

  let raycastMesh;
  if (obj.kind === 'button' || obj.kind === 'widget') {
    raycastMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.4, 0.4),
      new THREE.MeshStandardMaterial({ color: obj.kind === 'button' ? 0x0f766e : 0x7c3aed })
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
  const bg = obj.kind === 'widget' ? 'rgba(124,58,237,0.88)' : (obj.kind === 'button' ? 'rgba(15,118,110,0.88)' : 'rgba(24,95,165,0.88)');
  div.style.cssText = `pointer-events:none;white-space:nowrap;font:600 13px 'DM Sans',sans-serif;color:#fff;background:${bg};padding:3px 8px;border-radius:6px;transform:translate(-50%,-130%);`;
  div.textContent = objectDisplayText(obj);
  const css2dObj = new CSS2DObject(div);
  css2dObj.position.set(0, (obj.kind === 'button' || obj.kind === 'widget') ? 0.4 : 0.1, 0);
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
  document.getElementById('add-widget-btn').classList.toggle('active', kind === 'widget');
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
  if (!_currentSceneId) return;
  const id = crypto.randomUUID();
  const obj = {
    id, kind,
    sceneId: _currentSceneId,
    scriptId: null,
    transform: { position: [pos.x, pos.y, pos.z], rotation: [0, 0, 0], scale: [1, 1, 1] },
    style: {},
    props: kind === 'label' ? { text: 'New label' } : (kind === 'button' ? { label: 'Button', action: { type: 'none' } } : { label: 'Widget' }),
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

const ACTION_FIELDS = {
  'open-url':      ['prop-action-url'],
  'camera-preset': ['prop-action-preset'],
  'show-panel':    ['prop-action-title', 'prop-action-body'],
  'submit-report': ['prop-action-title'],
};

function showPropertyPanel(obj) {
  document.getElementById('empty-selection').style.display = 'none';
  document.getElementById('property-panel').style.display = 'flex';
  document.getElementById('prop-kind-label').textContent = (obj.kind === 'button' || obj.kind === 'widget') ? (obj.kind === 'widget' ? 'Widget label' : 'Button label') : 'Label text';
  document.getElementById('prop-text').value = objectDisplayText(obj);

  const actionGroup = document.getElementById('prop-action-group');
  actionGroup.style.display = obj.kind === 'button' ? 'flex' : 'none';
  const widgetGroup = document.getElementById('prop-widget-group');
  widgetGroup.style.display = obj.kind === 'widget' ? 'flex' : 'none';
  if (obj.kind === 'widget') _populateScriptDropdown(obj.scriptId);
  if (obj.kind === 'button') {
    // Older buttons stored action as a plain string (e.g. 'none'); normalize to an object.
    const raw = obj.props.action;
    const action = (raw && typeof raw === 'object') ? raw : { type: raw || 'none' };
    document.getElementById('prop-action-type').value = action.type;
    document.getElementById('prop-action-url').value = action.url ?? '';
    document.getElementById('prop-action-preset').value = action.preset ?? '';
    document.getElementById('prop-action-title').value = action.title ?? '';
    document.getElementById('prop-action-body').value = action.body ?? '';
    updateActionFieldVisibility(action.type);
  }
}

function updateActionFieldVisibility(type) {
  ['prop-action-url', 'prop-action-preset', 'prop-action-title', 'prop-action-body'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  (ACTION_FIELDS[type] ?? []).forEach(id => { document.getElementById(id).style.display = ''; });
}

function hidePropertyPanel() {
  document.getElementById('property-panel').style.display = 'none';
  document.getElementById('empty-selection').style.display = 'block';
}

// ── Action config (button kind only) ────────────────────────────────────
function onActionTypeChange(e) {
  if (!_selectedId) return;
  const entry = _objects.get(_selectedId);
  if (!entry || entry.obj.kind !== 'button') return;
  const type = e.target.value;
  entry.obj.props.action = { type };
  updateActionFieldVisibility(type);
  scheduleSave(_selectedId);
}

function onActionFieldInput() {
  if (!_selectedId) return;
  const entry = _objects.get(_selectedId);
  if (!entry || entry.obj.kind !== 'button') return;
  const type = document.getElementById('prop-action-type').value;
  const action = { type };
  if (type === 'open-url') action.url = document.getElementById('prop-action-url').value;
  else if (type === 'camera-preset') action.preset = document.getElementById('prop-action-preset').value;
  else if (type === 'show-panel') {
    action.title = document.getElementById('prop-action-title').value;
    action.body = document.getElementById('prop-action-body').value;
  } else if (type === 'submit-report') {
    action.title = document.getElementById('prop-action-title').value;
  }
  entry.obj.props.action = action;
  scheduleSave(_selectedId);
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
  if (entry.obj.kind === 'button' || entry.obj.kind === 'widget') entry.obj.props.label = val;
  else entry.obj.props.text = val;
  entry.div.textContent = val;
  scheduleSave(_selectedId);
}

// ── Delete ───────────────────────────────────────────────────────────────
async function onDeleteClick() {
  if (!_selectedId) return;
  const id = _selectedId;
  deselect();
  clearTimeout(_saveTimers.get(id)); // cancel any pending autosave so it can't recreate the row mid-delete
  _saveTimers.delete(id);
  const ok = await apiWrite(`/api/sites/${encodeURIComponent(SLUG)}/objects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (ok) disposeEntry(id);
  else select(id); // write failed — restore selection so the user can retry
}

// ── Debounced save (move + text edits share one path) ───────────────────
function scheduleSave(id) {
  clearTimeout(_saveTimers.get(id));
  _saveTimers.set(id, setTimeout(() => flushSave(id), 400));
}

// Send every pending debounced save immediately (scene switch — the edit
// belongs to a scene we're keeping, so it must not be silently dropped).
async function flushAllPending() {
  const ids = Array.from(_saveTimers.keys());
  ids.forEach(id => clearTimeout(_saveTimers.get(id)));
  await Promise.all(ids.map(id => flushSave(id)));
}

// Drop every pending debounced save without sending it (scene delete — the
// objects are about to be cascade-deleted, so saving them first is wasted
// work and would otherwise race the DELETE).
function cancelAllPending() {
  Array.from(_saveTimers.keys()).forEach(id => { clearTimeout(_saveTimers.get(id)); _saveTimers.delete(id); });
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

// ── Scripts Modal & API ─────────────────────────────────────────────────
async function _populateScriptDropdown(selectedValue) {
  const select = document.getElementById('prop-widget-script');
  try {
    const r = await fetch(`/api/sites/${encodeURIComponent(SLUG)}/scripts`);
    if (r.ok) {
      const scripts = await r.json();
      select.replaceChildren();
      const defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = 'No script';
      select.appendChild(defaultOpt);
      for (const script of scripts) {
        const opt = document.createElement('option');
        opt.value = script.id;
        opt.textContent = script.name;
        select.appendChild(opt);
      }
      select.value = selectedValue ?? '';
    }
  } catch {
    // Network errors should not throw
  }
}

function onPropWidgetScriptChange(e) {
  if (!_selectedId) return;
  const entry = _objects.get(_selectedId);
  if (!entry || entry.obj.kind !== 'widget') return;
  entry.obj.scriptId = e.target.value || null;
  scheduleSave(_selectedId);
}

function openScriptsModal() {
  document.getElementById('scripts-modal').style.display = 'flex';
  loadScriptsList();
}

function closeScriptsModal() {
  document.getElementById('scripts-modal').style.display = 'none';
  _editingScriptId = null;
  document.getElementById('new-script-name').value = '';
  document.getElementById('new-script-source').value = '';
}

async function loadScriptsList() {
  const listEl = document.getElementById('scripts-list');
  try {
    const r = await fetch(`/api/sites/${encodeURIComponent(SLUG)}/scripts`);
    if (r.ok) {
      const scripts = await r.json();
      listEl.replaceChildren();
      for (const script of scripts) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px;background:rgba(255,255,255,0.05);border-radius:6px;margin-bottom:8px;';

        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'flex:1;font-weight:500;';
        nameEl.textContent = script.name;

        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:8px;';

        const editBtn = document.createElement('button');
        editBtn.style.cssText = 'padding:4px 8px;background:rgba(255,255,255,0.1);border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;';
        editBtn.textContent = 'Edit';
        editBtn.onclick = () => {
          _editingScriptId = script.id;
          document.getElementById('new-script-name').value = script.name;
          document.getElementById('new-script-source').value = script.source;
        };

        const delBtn = document.createElement('button');
        delBtn.style.cssText = 'padding:4px 8px;background:#b91c1c;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;';
        delBtn.textContent = 'Delete';
        delBtn.onclick = async () => {
          const ok = await apiWrite(`/api/sites/${encodeURIComponent(SLUG)}/scripts/${encodeURIComponent(script.id)}`, { method: 'DELETE' });
          if (ok) {
            loadScriptsList();
            if (_selectedId && _objects.get(_selectedId)?.obj.kind === 'widget') {
              _populateScriptDropdown(_objects.get(_selectedId).obj.scriptId);
            }
          }
        };

        btns.appendChild(editBtn);
        btns.appendChild(delBtn);
        row.appendChild(nameEl);
        row.appendChild(btns);
        listEl.appendChild(row);
      }
    }
  } catch {
    // Network errors should not throw
  }
}

async function onSaveNewScriptClick() {
  const name = document.getElementById('new-script-name').value.trim();
  const source = document.getElementById('new-script-source').value;
  if (!name) return;

  const payload = { name, source };
  let ok;
  if (_editingScriptId) {
    ok = await apiWrite(`/api/sites/${encodeURIComponent(SLUG)}/scripts/${encodeURIComponent(_editingScriptId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } else {
    ok = await apiWrite(`/api/sites/${encodeURIComponent(SLUG)}/scripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  if (ok) {
    document.getElementById('new-script-name').value = '';
    document.getElementById('new-script-source').value = '';
    _editingScriptId = null;
    loadScriptsList();
    if (_selectedId && _objects.get(_selectedId)?.obj.kind === 'widget') {
      _populateScriptDropdown(_objects.get(_selectedId).obj.scriptId);
    }
  }
}

// ── Toast ────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}
