import { getContacts, getStaffContacts, getPoints, savePoint, deletePoint, saveContact } from './db.js';
import { createMyPinsSession } from './my-pins-session.js';
import { buildLegacyImportPlan } from './my-pins-client.js';
import { generateQR, downloadQR } from './qr.js';

// ── State ─────────────────────────────────────────────────────────────────────
let _v3d           = null;
let _points        = [];
let _personalPins  = [];
let _contacts      = [];
let _contactsAll   = [];
let _siteBounds    = null;
let _editingPoint  = null;
let _editingType   = null;
let _editingScope  = 'personal';
let _editingContactIds = [];
let _saving        = false;
let _isNewPoint    = false;
let _placing        = false;
let _accountSession = null;
let _accountReady = false;
let _legacyPins = [];       // read-only browser backup until explicitly imported
let _editingIsLegacy = false;
let _accountEmail = null;
let _editingIsAccount = false;
let _initPromise = null;
let _initEpoch = 0;
let _viewerHooksInstalled = false;
let _slug          = null;   // site slug, for the /api/sites/:slug/points/... photo routes
let _pinPhotos     = [];     // photos of the pin currently open in the editor
let _pinPhotosFor  = null;   // which pin id _pinPhotos belongs to

// ── Esc key ───────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (_placing) _setPlacing(false);
  else if (_editingPoint) window.closeEditor();
});

// ── Init (fires after viewer3d boot completes) ────────────────────────────────
function _setEditorPanel(active) {
  const panel = document.getElementById('side-panel');
  panel?.classList.toggle('staff-editing', active);
  document.getElementById('app')?.classList.toggle('staff-editing', active);
  if (active) panel?.classList.remove('panel-folded');
  window._updateCamPresetsBottom?.();
}
function _safeStorage() { try { return window.localStorage; } catch { return null; } }
function _copy(value) { return structuredClone(value); }
function _accountState() { return _accountSession?.getState() || { pins: [], scene: null }; }
function _syncAccountPins() { _personalPins = _accountState().pins; }
async function _loadLegacyPins() {
  const plan = buildLegacyImportPlan(_safeStorage());
  return (await Promise.all(plan.pins.map(_preparePosition))).filter(Boolean);
}
function _visibleLegacyPins() {
  const accountIds = new Set(_personalPins.map(p => p.id));
  return _legacyPins.filter(p => !accountIds.has(p.id));
}
function _renderAllPins() {
  if (!_v3d) return;
  const occupied = new Set([..._points, ..._personalPins].map(p => p.id));
  // A local backup with a colliding server ID remains visible in the list but
  // does not replace the authoritative server marker in the renderer.
  const renderableLegacy = _visibleLegacyPins().filter(p => !occupied.has(p.id));
  _v3d.renderPins([..._points, ..._personalPins, ...renderableLegacy]);
  renderPointList(document.getElementById('search-input')?.value || '');
}
function _accountError(error) {
  const messages = {
    UNAUTHORIZED: 'Session expired. Reload and sign in again.',
    SESSION_CHANGED: 'The signed-in account changed. Reload before continuing.',
    FORBIDDEN: 'Your account does not have access to these pins.',
    POINT_HAS_PHOTOS: 'Remove attached photos before deleting this pin.',
    CONFLICT: 'The pin conflicts with another record. Nothing was overwritten.',
    SAVE_NOT_VERIFIED: 'Save could not be verified. Reload your account pins before retrying.',
    NETWORK_ERROR: 'Connection failed. Your changes have not been confirmed.',
    BUSY: 'Wait for the current operation to finish.',
  };
  return messages[error?.code] || 'Account operation failed. Your browser copies are unchanged; retry when connected.';
}
function _handleAccountFailure(error) {
  if (error?.status === 401 || error?.code === 'SESSION_CHANGED') {
    window._snAdminIdentity = null;
    window.dispatchEvent(new CustomEvent('sitenav:auth-cleared'));
    _setAccountStatus(_accountError(error));
  }
  return _accountError(error);
}
function _setAccountStatus(message, retry = false) {
  const el = document.getElementById('my-pins-status');
  if (!el) return;
  el.replaceChildren();
  const text = document.createElement('span'); text.textContent = message; el.appendChild(text);
  if (retry) {
    const button = document.createElement('button'); button.type = 'button'; button.id = 'my-pins-retry';
    button.className = 'btn-secondary'; button.textContent = 'Retry loading';
    button.addEventListener('click', () => _maybeInitAdmin()); el.appendChild(button);
  }
}
function _setBusy(on) {
  document.querySelectorAll('#admin-controls button, #admin-controls input, #drawer-body button, #drawer-body input, #drawer-body textarea, .back-btn, .ev-delete-btn, #legacy-import-button, #my-pins-retry').forEach(el => {
    if (on) {
      if (!el.hasAttribute('data-pin-busy-disabled')) el.dataset.pinBusyDisabled = el.disabled ? '1' : '0';
      el.disabled = true;
    } else if (el.hasAttribute('data-pin-busy-disabled')) {
      el.disabled = el.dataset.pinBusyDisabled === '1'; delete el.dataset.pinBusyDisabled;
    }
  });
  const place = document.getElementById('place-btn');
  if (place) place.disabled = on || !_accountReady;
}
function _renderImportNotice() {
  const el = document.getElementById('legacy-import-notice');
  if (!el) return;
  el.replaceChildren();
  if (!_accountReady) return;
  const plan = buildLegacyImportPlan(_safeStorage());
  const accountIds = new Set(_personalPins.map(p => p.id));
  const remaining = plan.pins.filter(p => !accountIds.has(p.id));
  if (!remaining.length) return;
  const text = document.createElement('p');
  text.textContent = `${remaining.length} device-only pin${remaining.length === 1 ? '' : 's'} not yet in your account. Import only pins that belong to you; browser copies will be kept.`;
  const button = document.createElement('button'); button.type = 'button'; button.id = 'legacy-import-button';
  button.className = 'btn-secondary'; button.textContent = 'Import browser pins';
  button.addEventListener('click', () => window._adminImportLegacyPins());
  el.append(text, button);
  if (_saving) _setBusy(true);
}
async function _preparePosition(pt) {
  const pos = pt.position3d;
  if (pos && ['x','y','z'].every(key => Number.isFinite(pos[key]))) return pt;
  if (Array.isArray(pt.latlng) && pt.latlng.length === 2 && pt.latlng.every(Number.isFinite)) {
    return { ...pt, position3d: await _v3d.latlngToScene(...pt.latlng) };
  }
  return null;
}
async function _maybeInitAdmin() {
  if (_saving || _initPromise || !window._v3d || !window._snAdminIdentity?.email) return _initPromise;
  _v3d = window._v3d;
  if (!_viewerHooksInstalled) {
    const wrap = _v3d.renderer.domElement.parentElement;
    wrap.addEventListener('pointerdown', _onWrapPointerDown, { capture: true });
    wrap.addEventListener('pointerup', _onWrapPointerUp, { capture: true });
    wrap.addEventListener('click', _onWrapClick, { capture: true });
    document.getElementById('point-list').addEventListener('click', e => {
      const item = e.target.closest('[data-pt-id]');
      if (item && !_saving) window._adminOpenEditor(item.dataset.ptId, item.dataset.pinSource);
    });
    document.getElementById('drawer-body').addEventListener('click', e => {
      const chip = e.target.closest('[data-remove-contact]');
      if (chip && !_saving) window._adminRemoveContact(chip.dataset.removeContact);
    });
    _viewerHooksInstalled = true;
  }
  const epoch = ++_initEpoch;
  const email = window._snAdminIdentity.email;
  _accountReady = false; _setBusy(false); _setAccountStatus('Loading account pins…');
  _initPromise = (async () => {
    const [bounds, site] = await Promise.all([
      fetch('./assets/site-map-bounds.json').then(r => { if (!r.ok) throw new Error('bounds'); return r.json(); }),
      fetch('/api/site').then(r => { if (!r.ok) throw new Error('site'); return r.json(); }),
    ]);
    if (!site?.slug) throw new Error('site');
    const session = createMyPinsSession(site.slug, { identity: email, storage: _safeStorage() });
    const [state, contacts, baseResult] = await Promise.all([
      session.load(), getStaffContacts(site.slug),
      getPoints().then(data => ({ data, failed: !Array.isArray(data) })).catch(() => ({ data: [], failed: true })),
    ]);
    const preparedAccount = (await Promise.all(state.pins.map(_preparePosition))).filter(Boolean);
    const ownIds = new Set(preparedAccount.map(pt => pt.id));
    const preparedBase = (await Promise.all((Array.isArray(baseResult.data) ? baseResult.data : []).map(_preparePosition))).filter(pt => pt && !ownIds.has(pt.id));
    // Legacy coordinate preparation is asynchronous too. Keep it local until
    // the identity/epoch check after every await so a sign-out cannot revive
    // stale private account state.
    const preparedLegacy = await _loadLegacyPins();
    if (epoch !== _initEpoch || window._snAdminIdentity?.email !== email) return;
    _siteBounds = bounds; _slug = site.slug; _accountSession = session; _accountEmail = email;
    _personalPins = preparedAccount; _points = preparedBase; _legacyPins = preparedLegacy;
    _contacts = contacts; _contactsAll = [...contacts]; _accountReady = true;
    _renderAllPins(); _renderImportNotice();
    _setAccountStatus(`My pins are saved to ${email}.` + (state.duplicates ? ' Multiple workspaces found; showing the oldest.' : '') + (baseResult.failed ? ' Base-site pins are temporarily unavailable.' : ''));
    _loadAnalytics(); window._updateCamPresetsBottom?.();
  })().catch(error => {
    if (epoch === _initEpoch) {
      _accountReady = false; _setAccountStatus(_accountError(error), true);
      document.getElementById('legacy-import-notice')?.replaceChildren();
    }
  }).finally(() => {
    _initPromise = null; _setBusy(_saving);
    if (window._snAdminIdentity?.email && window._snAdminIdentity.email !== email) queueMicrotask(_maybeInitAdmin);
  });
  return _initPromise;
}
window.addEventListener('viewer3d:ready', () => _maybeInitAdmin());
window.addEventListener('sitenav:auth-ready', () => _maybeInitAdmin());
window.addEventListener('sitenav:auth-cleared', () => {
  _setEditorPanel(false);
  ++_initEpoch; _accountReady = false; _accountSession = null; _accountEmail = null;
  _personalPins = []; _legacyPins = []; _contacts = []; _contactsAll = []; _editingContactIds = [];
  _editingPoint = null; _editingIsLegacy = false; _isNewPoint = false;
  _v3d?.renderPins(_points); renderPointList();
  document.getElementById('editor-view')?.classList.remove('panel-slide-in');
  document.getElementById('list-view')?.classList.remove('panel-slide-out');
  document.getElementById('drawer-body')?.replaceChildren();
  document.getElementById('legacy-import-notice')?.replaceChildren();
  document.getElementById('modal-backdrop')?.classList.remove('open');
  document.getElementById('contact-tbody')?.replaceChildren();
  _setAccountStatus('Sign in to load your account pins.'); _setBusy(false);
});
queueMicrotask(() => { _setBusy(false); _maybeInitAdmin(); });

window._adminImportLegacyPins = async () => {
  if (_saving || !_accountReady || !_accountSession) return;
  _setPlacing(false); _saving = true; _setBusy(true);
  const epoch = _initEpoch;
  try {
    const result = await _accountSession.importLegacy(({ email, count }) => window.confirm(
      `Import ${count} browser-local pins into ${email}?\n\nThis browser may have been used by another employee. Confirm that these pins belong to you. Existing account pins will not be overwritten. Original browser copies will be kept.`));
    if (epoch !== _initEpoch) return;
    if (result.cancelled) { _setAccountStatus('Import cancelled. No browser pins were copied or removed.'); return; }
    _syncAccountPins();
    const importEmail = _accountEmail;
    const refreshedLegacy = await _loadLegacyPins();
    if (epoch !== _initEpoch || window._snAdminIdentity?.email !== importEmail) return;
    _legacyPins = refreshedLegacy; _renderAllPins();
    const unverified = result.imported - result.verified;
    _setAccountStatus(`${result.verified} imported and verified; ${result.skipped} already present; ${result.failed} failed.` + (unverified ? ` ${unverified} saves remain unverified; reload before retrying.` : '') + ' Browser copies kept.');
  } catch (error) { _setAccountStatus(_handleAccountFailure(error), true); }
  finally { _saving = false; _renderImportNotice(); _setBusy(false); }
};

async function _loadAnalytics() {
  const panel = document.getElementById('analytics-panel');
  if (!panel) return;
  try {
    const r = await fetch('/api/visits');
    if (!r.ok) { panel.innerHTML = '<p style="color:var(--color-text-muted);font-size:0.875rem">Analytics unavailable</p>'; return; }
    const data = await r.json();
    const fmt = d => d ? new Date(d).toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' }) : '—';
    // Get all known pin labels from the admin's pin list
    const pinLabels = {};
    document.querySelectorAll('[data-pt-id]').forEach(el => {
      const labelEl = el.querySelector('.pt-label');
      pinLabels[el.dataset.ptId] = labelEl ? labelEl.textContent : el.dataset.ptId;
    });
    const pointRows = Object.entries(data.points || {})
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => {
        const label = pinLabels[id] || id;
        const pct = data.total ? Math.round((count / data.total) * 100) : 0;
        // Escape label for safety
        const escLabel = label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        return `<div class="analytics-row">
          <span class="analytics-label" title="${escLabel}">${escLabel}</span>
          <div class="analytics-bar-wrap"><div class="analytics-bar" style="width:${pct}%"></div></div>
          <span class="analytics-count">${count}</span>
        </div>`;
      }).join('');
    panel.innerHTML = `
      <div class="analytics-summary">
        <span class="analytics-stat"><strong>${data.total || 0}</strong> total visits</span>
        <span class="analytics-stat-sep">·</span>
        <span class="analytics-stat">First: ${fmt(data.firstVisit)}</span>
        <span class="analytics-stat-sep">·</span>
        <span class="analytics-stat">Last: ${fmt(data.lastVisit)}</span>
      </div>
      ${pointRows || '<p style="color:var(--color-text-muted);font-size:0.875rem">No pin visits recorded yet.</p>'}
    `;
  } catch (e) {
    panel.innerHTML = '<p style="color:var(--color-text-muted);font-size:0.875rem">Could not load analytics.</p>';
  }
}
window._loadAnalytics = _loadAnalytics;

// Account pins never write the legacy browser pin/history keys. The import
// planner is read-only, and explicit confirmation is required before copying.

// ── Inverse coord: scene pos3d → [lat, lng] ───────────────────────────────────
function _sceneToLatlng(x, z) {
  const [sw, ne] = _siteBounds.bounds;
  const lng = (x / 40 + 0.5) * (ne[1] - sw[1]) + sw[1];
  const lat = (-z / 30 + 0.5) * (ne[0] - sw[0]) + sw[0];
  return [lat, lng];
}

// ── Pointerdown: only used to block OrbitControls starting a pan during placement ─
function _onWrapPointerDown(e) {
  if (_saving || !_accountReady || e.button !== 0 || !_placing) return;
  if (!e.target.closest('#cam-presets')) e.stopPropagation();
}

function _onWrapPointerUp(e) {
  if (_saving || !_accountReady || e.button !== 0 || !_placing) return;
  if (e.target.closest('#cam-presets, #nav-progress, #splat-progress')) return;
  e.stopPropagation();
  _placeFromEvent(e);
}

function _onWrapClick(e) {
  if (_saving || !_accountReady) return;
  if (e.target.closest('#cam-presets, #nav-progress, #splat-progress')) return;
  e.stopPropagation();
  if (_placing) { _placeFromEvent(e); return; }
  _setRaycasterFromEvent(e);
  const spheres = Object.values(_v3d.pins).map(p => p.sphere);
  if (!spheres.length) return;
  const pinHits = _v3d._raycaster.intersectObjects(spheres);
  if (!pinHits.length) return;
  const hitSphere = pinHits[0].object;
  const entry = Object.entries(_v3d.pins).find(([, p]) => p.sphere === hitSphere);
  if (entry) openEditor(entry[1].pt);
}

function _setRaycasterFromEvent(e) {
  const canvas = _v3d.renderer.domElement;
  const rect   = canvas.getBoundingClientRect();
  const nx =  (e.clientX - rect.left) / rect.width  * 2 - 1;
  const ny = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  _v3d._raycaster.setFromCamera({ x: nx, y: ny }, _v3d.camera);
}

function _placeFromEvent(e) {
  _setRaycasterFromEvent(e);
  const groundHits = _v3d._raycaster.intersectObject(_v3d._pickGround);
  const pos3d = groundHits.length
    ? groundHits[0].point
    : { x: _v3d.controls.target.x, y: 0, z: _v3d.controls.target.z };
  _placePin(pos3d);
  _setPlacing(false);
}

// ── Placement mode ────────────────────────────────────────────────────────────
function _setPlacing(on) {
  _placing = on;
  const btn  = document.getElementById('place-btn');
  const hint = document.getElementById('placement-hint');
  btn.textContent = on ? 'Cancel placement' : '+ Place new pin';
  btn.className   = on ? 'btn-primary danger' : 'btn-primary';
  hint.style.display = on ? 'block' : 'none';
  document.getElementById('canvas-wrap').style.cursor = on ? 'crosshair' : '';
}

window.togglePlacement = () => {
  if (_saving || !_accountReady) return;
  if (_placing) { _setPlacing(false); return; }
  window.closeEditor();
  _setPlacing(true);
};

function _uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function _placePin(pos3d) {
  if (_saving || !_accountReady) return;
  const latlng = _sceneToLatlng(pos3d.x, pos3d.z);
  const newPt = {
    id: _uuid(),
    label: 'New pin',
    type: 'meet-point',
    scope: 'personal',
    latlng,
    position3d: { x: pos3d.x, y: 0, z: pos3d.z },
    notes: '',
    contactIds: [],
    routeWaypoints: [],
    routeWaypoints3d: [],
    cameraPreset3d: { position: { x: 0, y: 5, z: -3 }, lookAt: { x: 0, y: 0, z: 0 } },
    buildingRef: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  _isNewPoint = true;
  _v3d.upsertPin(newPt);
  openEditor(newPt, true);
}

// ── Point list (right panel) ──────────────────────────────────────────────────
function renderPointList(filter = '') {
  const el = document.getElementById('point-list');
  const lf = filter.toLowerCase();

  const visibleShared = _points.filter(p =>
    !lf || p.label.toLowerCase().includes(lf) || p.type.includes(lf)
  );
  const visiblePersonal = _personalPins.filter(p =>
    !lf || p.label.toLowerCase().includes(lf) || p.type.includes(lf)
  );
  const visibleLegacy = _visibleLegacyPins().filter(p =>
    !lf || p.label.toLowerCase().includes(lf) || p.type.includes(lf)
  );

  const dotColor = { 'drop-off': 'var(--primary)', 'collection': 'var(--accent)', 'both': 'var(--amber)', 'meet-point': '#f59e0b' };

  let html = '';

  if (visibleShared.length) {
    html += `<div class="list-section">Base-site pins</div>`;
    visibleShared.forEach(p => {
      const isActive = _editingPoint?.id === p.id;
      const item = document.createElement('div');
      item.className = 'point-item' + (isActive ? ' selected' : '');
      item.dataset.ptId = p.id;
      item.dataset.pinSource = 'base';
      item.innerHTML = `<div class="pt-dot" style="background:${dotColor[p.type] ?? dotColor['meet-point']}"></div><div class="pt-label">${_esc(p.label)}</div><span style="color:var(--text-tertiary);font-size:16px">›</span>`;
      html += item.outerHTML;
    });
  }

  html += `<div class="list-section">My account pins</div>`;
  if (visiblePersonal.length) {
    visiblePersonal.forEach(p => {
      const isActive = _editingPoint?.id === p.id;
      const item = document.createElement('div');
      item.className = 'point-item' + (isActive ? ' selected' : '');
      item.dataset.ptId = p.id;
      item.dataset.pinSource = 'account';
      item.innerHTML = `<div class="pt-dot" style="background:#4F6AF5"></div><div class="pt-label">${_esc(p.label)}</div><span style="color:var(--text-tertiary);font-size:16px">›</span>`;
      html += item.outerHTML;
    });
  } else {
    html += `<div style="padding:12px 16px;font-size:12px;color:var(--text-secondary)">No account pins yet — place a pin and save it to your account</div>`;
  }

  if (visibleLegacy.length) {
    html += `<div class="list-section">Pins on this device</div>`;
    visibleLegacy.forEach(p => {
      const item = document.createElement('div');
      item.className = 'point-item' + (_editingPoint?.id === p.id && _editingIsLegacy ? ' selected' : '');
      item.dataset.ptId = p.id; item.dataset.pinSource = 'legacy';
      item.innerHTML = `<div class="pt-dot" style="background:#8B5CF6"></div><div class="pt-label">${_esc(p.label)}</div><span style="color:var(--text-tertiary);font-size:16px">›</span>`;
      html += item.outerHTML;
    });
  }
  if (!visibleShared.length && !visiblePersonal.length && !visibleLegacy.length) {
    html = `<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px">No pins found</div>`;
  }

  el.innerHTML = html;
}

window._adminOpenEditor = (id, source) => {
  if (_saving || !_accountReady) return;
  if (source === 'legacy') return openEditor(_visibleLegacyPins().find(p => p.id === id), false, true);
  const accountPin = _personalPins.find(p => p.id === id);
  openEditor(accountPin || _points.find(p => p.id === id), Boolean(accountPin), false);
};
window.filterPins = val => renderPointList(val);

// ── Editor drawer ─────────────────────────────────────────────────────────────
function openEditor(pt, account = Boolean(pt?.sceneId), legacy = false) {
  if (!pt || _saving || !_accountReady) return;
  if (_isNewPoint && _editingPoint && _editingPoint.id !== pt.id) _v3d?.removePin(_editingPoint.id);
  _isNewPoint = !legacy && !_points.some(p => p.id === pt.id) && !_personalPins.some(p => p.id === pt.id);
  _editingPoint = _copy(pt);
  _editingIsAccount = account;
  _editingIsLegacy = legacy;
  _setEditorPanel(true);
  _editingContactIds = [...(pt.contactIds || [])];
  _editingType = pt.type;
  _editingScope = pt.scope ?? 'shared';
  document.getElementById('drawer-title').textContent = pt.label || 'New pin';
  document.getElementById('list-view').classList.add('panel-slide-out');
  document.getElementById('editor-view').classList.add('panel-slide-in');
  // Photos only exist for shared pins that are already saved server-side.
  _pinPhotos = [];
  _pinPhotosFor = null;
  renderDrawerBody();
  if (!_editingIsAccount && _editingScope === 'shared' && !_isNewPoint && _slug) _loadPinPhotos(pt.id);
  _v3d?.updatePinHighlight(pt.id);
}

window.closeEditor = function() {
  if (_saving) return;
  _setEditorPanel(false);
  if (_isNewPoint && _editingPoint) {
    _v3d?.removePin(_editingPoint.id);
    _isNewPoint = false;
  }
  _editingPoint = null;
  _editingIsLegacy = false;
  _editingType  = null;
  _pinPhotos    = [];
  _pinPhotosFor = null;
  document.getElementById('list-view').classList.remove('panel-slide-out');
  document.getElementById('editor-view').classList.remove('panel-slide-in');
  document.getElementById('qr-section').style.display = 'none';
  renderPointList();
  _v3d?.updatePinHighlight(null);
};

function renderDrawerBody() {
  const pt = _editingPoint;
  if (_editingIsLegacy) {
    document.getElementById('drawer-body').innerHTML = `
      <div class="pin-scope-note"><span>Saved on this device only — not synced.</span></div>
      <div class="form-group"><label class="form-label">Label</label><div class="form-input" style="min-height:auto">${_esc(pt.label || '')}</div></div>
      ${pt.notes ? `<div class="form-group full"><label class="form-label">Notes</label><div style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap">${_esc(pt.notes)}</div></div>` : ''}
      <div class="form-group full"><div style="font-size:12px;color:var(--text-secondary)">Import this pin to your HCMA account before editing, sharing or adding photos. Your browser copy will remain as a backup.</div><button type="button" class="btn-secondary" style="margin-top:8px;width:auto" onclick="window._adminImportLegacyPins()">Import device pins</button></div>`;
    return;
  }
  const allContacts = _contacts.filter(c => c.active);
  const assigned   = _editingContactIds.map(id => allContacts.find(c => c.id === id)).filter(Boolean);
  const unassigned = allContacts.filter(c => !_editingContactIds.includes(c.id));
  const isPersonal = _editingScope === 'personal';

  const chips = assigned.map(c => {
    const btn = document.createElement('button');
    btn.className = 'chip-remove';
    btn.setAttribute('aria-label', 'Remove');
    btn.dataset.removeContact = c.id;
    btn.textContent = '×';
    const span = document.createElement('span');
    span.className = 'contact-chip';
    span.textContent = c.name + ' ';
    span.appendChild(btn);
    return span.outerHTML;
  }).join('');

  // unassigned contacts used by the search autocomplete (attached after innerHTML)

  const actionButtons = _editingIsAccount
    ? '<button class="pin-action-btn" type="button" disabled>Share link — not enabled</button><button class="pin-action-btn" type="button" disabled>QR — not enabled</button>'
    : isPersonal
    ? `<button class="pin-action-btn action" onclick="window._adminShowShareLink()">Share link</button>`
    : `<button class="pin-action-btn action" onclick="window._adminToggleQR()">QR</button>
       <button class="pin-action-btn action" onclick="window._adminShowShareLink()">Share link</button>`;

  document.getElementById('drawer-body').innerHTML = `
    <div class="form-group">
      <label class="form-label">Label <span style="color:var(--red)">*</span></label>
      <input class="form-input" id="field-label" value="${_esc(pt.label)}" maxlength="80" placeholder="e.g. Dock 1 – Receiving">
    </div>
    ${_editingIsAccount ? `<div class="pin-scope-note"><span>${_isNewPoint ? 'New private pin — save to your account.' : 'Saved to your account. Publishing and account photos are not enabled in this step.'}</span></div>` : isPersonal ? `
    <div class="pin-scope-note">
      <span>Saved on this device only</span>
      <button type="button" class="pin-scope-promote" onclick="window._adminPromoteToShared()">Share with everyone</button>
    </div>` : ''}
    <div class="form-group full">
      <label class="form-label">Contacts</label>
      <div id="contact-chips" style="margin-bottom:6px">
        ${chips || '<span style="font-size:12px;color:var(--text-secondary)">None assigned</span>'}
      </div>
      <div style="position:relative;max-width:280px">
        <input type="text" class="form-input" id="contact-search" placeholder="Type name or role…" autocomplete="off" style="padding-right:28px">
        <div id="contact-suggestions" style="display:none;position:absolute;left:0;right:0;top:calc(100% + 2px);z-index:100;background:#1a1d27;border:1px solid rgba(255,255,255,0.15);border-radius:6px;overflow-y:auto;max-height:160px;box-shadow:0 4px 16px rgba(0,0,0,0.5)"></div>
      </div>
    </div>
    <div class="form-group full">
      <label class="form-label">Notes (optional)</label>
      <textarea class="form-input" id="field-notes">${_esc(pt.notes ?? '')}</textarea>
    </div>
    ${(_editingIsAccount || isPersonal) ? `
    <div class="form-group full">
      <label class="form-label">Photos</label>
      <div style="font-size:12px;color:var(--text-secondary)">
        ${_editingIsAccount ? 'Account-photo attachments are not enabled yet. Saving this pin does not publish it.' : 'Photos require a saved base-site pin.'}
      </div>
    </div>` : `
    <div class="form-group full">
      <label class="form-label">Photos <span id="pin-photo-count" style="font-weight:400;text-transform:none"></span></label>
      <div id="pin-photos" class="pin-photos"></div>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);margin-top:8px;cursor:pointer">
        <input type="checkbox" id="pin-photo-keep"> Keep new photos indefinitely (otherwise deleted after 30 days)
      </label>
      <div style="margin-top:6px">
        <button type="button" class="pin-action-btn action" id="pin-add-photo"
          onclick="document.getElementById('pin-photo-input').click()">Add photo</button>
        <input type="file" id="pin-photo-input" accept="image/*" multiple hidden
          onchange="window._adminPinFilesChosen(event)">
      </div>
      <div id="pin-photo-status" style="font-size:11px;color:var(--text-secondary);margin-top:4px;min-height:14px">${_isNewPoint ? 'Save the pin before adding photos.' : ''}</div>
    </div>`}
    <div class="full">
      <button class="btn-primary" id="pin-save-button" onclick="window._adminSave()">${_editingIsAccount ? 'Save to my account' : 'Save base-site pin'}</button>
    </div>
    <div class="full pin-action-row">
      ${actionButtons}
    </div>
    <div id="share-link-row" style="display:none;padding-top:10px">
      <label class="form-label">Share link</label>
      <div class="share-link-field">
        <input class="form-input" id="share-url-input" readonly>
        <button class="share-copy-btn" id="share-copy-btn" onclick="window._adminCopyShareUrl()">Copy</button>
      </div>
    </div>
  `;

  // Contact search autocomplete
  const searchInput = document.getElementById('contact-search');
  const suggestionsEl = document.getElementById('contact-suggestions');

  function _renderSuggestions(q) {
    const term = q.trim().toLowerCase();
    const matches = unassigned
      .filter(c => !term || c.name.toLowerCase().includes(term) || (c.role || '').toLowerCase().includes(term))
      .slice(0, 8);
    if (!matches.length) { suggestionsEl.style.display = 'none'; return; }
    suggestionsEl.innerHTML = '';
    matches.forEach(c => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:8px 12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06);font-size:13px;';
      row.innerHTML = `<span style="color:#e5e7eb;font-weight:500">${_esc(c.name)}</span><span style="color:var(--text-secondary);font-size:11px;margin-left:6px">${_esc(c.role || '')}</span>`;
      row.addEventListener('mousedown', e => {
        e.preventDefault(); // prevent input blur before click
        window._adminAddContact(c.id);
        searchInput.value = '';
        suggestionsEl.style.display = 'none';
      });
      row.addEventListener('mouseover', () => row.style.background = 'rgba(255,255,255,0.06)');
      row.addEventListener('mouseout',  () => row.style.background = '');
      suggestionsEl.appendChild(row);
    });
    suggestionsEl.style.display = 'block';
  }

  searchInput.addEventListener('input', e => _renderSuggestions(e.target.value));
  searchInput.addEventListener('focus', () => _renderSuggestions(searchInput.value));
  searchInput.addEventListener('blur', () => setTimeout(() => { suggestionsEl.style.display = 'none'; }, 150));
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { suggestionsEl.style.display = 'none'; searchInput.blur(); }
  });

  // innerHTML above wiped the photo grid — repaint it from state. Photos are
  // fetched by openEditor/_adminSave, not here, so re-rendering on every
  // contact add/remove doesn't refetch.
  if (!_editingIsAccount && !isPersonal) _renderPinPhotos(pt.id);
  if (_saving) _setBusy(true);
}

// ── Pin photos (shared pins only) ─────────────────────────────────────────────
// Personal pins live only in localStorage, so there is no server row for a
// photo to reference — the panel points at "Share with everyone" instead.
const PHOTO_TARGET_BYTES = 300 * 1024;
const MAX_PIN_PHOTOS = 6;

// Browser-side compression: longest edge <= 1600px, JPEG quality stepped down
// until under 300 KB (then the dimensions, if needed). EXIF orientation is
// applied by createImageBitmap where supported. Same approach as the hazard
// editor's compressImage.
async function _compressImage(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bitmap = await createImageBitmap(file); }
  let scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  for (let pass = 0; pass < 4; pass++) {
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    for (const q of [0.85, 0.75, 0.65, 0.55, 0.45]) {
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', q));
      if (blob && blob.size <= PHOTO_TARGET_BYTES) { bitmap.close?.(); return { blob, width: w, height: h }; }
    }
    scale *= 0.75;
  }
  bitmap.close?.();
  throw new Error('Could not compress image under 300 KB');
}

// One binary request: [u32 BE header length][JSON header][compressed][original].
async function _uploadPinPhoto(pointId, file, keepIndefinitely) {
  if (_editingIsAccount) throw new Error('Account photo workflow is not enabled');
  const { blob, width, height } = await _compressImage(file);
  const header = new TextEncoder().encode(JSON.stringify({
    contentType: file.type || 'image/jpeg', originalName: file.name,
    width, height, compressedBytes: blob.size, keepIndefinitely,
  }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length, false);
  const body = new Blob([len, header, blob, file]);
  const r = await fetch(`/api/sites/${encodeURIComponent(_slug)}/points/${encodeURIComponent(pointId)}/photos`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `upload failed (${r.status})`);
  return r.json();
}

async function _loadPinPhotos(pointId) {
  if (_editingIsAccount) return;
  _pinPhotos = [];
  _pinPhotosFor = pointId;
  try {
    const r = await fetch(`/api/sites/${encodeURIComponent(_slug)}/points/${encodeURIComponent(pointId)}/photos`);
    if (r.ok) _pinPhotos = await r.json();
  } catch {}
  if (_editingPoint?.id === pointId) _renderPinPhotos(pointId);
}

function _retentionLabel(p) {
  if (!p.expiresAt) return 'Kept indefinitely';
  const days = Math.ceil((new Date(p.expiresAt) - Date.now()) / 86400000);
  return days > 0 ? `Expires in ${days}d` : 'Expiring';
}

function _renderPinPhotos(pointId, pending = 0) {
  const grid = document.getElementById('pin-photos');
  if (!grid) return;
  grid.replaceChildren();
  _pinPhotos.forEach(p => {
    const cell = document.createElement('div');
    cell.className = 'pin-photo';

    const img = document.createElement('img');
    img.src = `/api/point-photos/${encodeURIComponent(p.id)}`;
    img.alt = p.originalName || 'Pin photo';
    img.title = `${p.originalName || ''} — click to open original`;
    img.addEventListener('click', () => window.open(`/api/point-photos/${encodeURIComponent(p.id)}?original=1`, '_blank', 'noopener'));

    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'keep' + (p.expiresAt ? '' : ' forever');
    keep.textContent = _retentionLabel(p);
    keep.title = p.expiresAt ? 'Click to keep this photo indefinitely' : 'Click to expire this photo after 30 days';
    keep.addEventListener('click', async () => {
      const r = await fetch(`/api/sites/${encodeURIComponent(_slug)}/points/photos/${encodeURIComponent(p.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keep: !!p.expiresAt }),   // flip
      });
      if (!r.ok) { showToast('Could not change retention'); return; }
      const updated = await r.json();
      const i = _pinPhotos.findIndex(x => x.id === p.id);
      if (i >= 0) _pinPhotos[i] = updated;
      _renderPinPhotos(pointId);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.title = 'Remove photo';
    del.addEventListener('click', async () => {
      const r = await fetch(`/api/sites/${encodeURIComponent(_slug)}/points/photos/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      if (!r.ok) { showToast('Delete failed'); return; }
      _pinPhotos = _pinPhotos.filter(x => x.id !== p.id);
      _renderPinPhotos(pointId);
    });

    cell.append(img, keep, del);
    grid.appendChild(cell);
  });
  for (let i = 0; i < pending; i++) {
    const cell = document.createElement('div');
    cell.className = 'pin-photo';
    const ov = document.createElement('div');
    ov.className = 'uploading';
    ov.textContent = 'Uploading…';
    cell.appendChild(ov);
    grid.appendChild(cell);
  }
  const count = document.getElementById('pin-photo-count');
  if (count) count.textContent = `${_pinPhotos.length}/${MAX_PIN_PHOTOS}`;
  const add = document.getElementById('pin-add-photo');
  if (add) add.disabled = _pinPhotos.length + pending >= MAX_PIN_PHOTOS;
}

window._adminPinFilesChosen = async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!_editingPoint || _editingIsAccount || _editingIsLegacy || _saving || !files.length) return;
  const pointId = _editingPoint.id;
  const status = document.getElementById('pin-photo-status');
  if (_isNewPoint) { if (status) status.textContent = 'Save the pin before adding photos.'; return; }
  const room = MAX_PIN_PHOTOS - _pinPhotos.length;
  if (room <= 0) { if (status) status.textContent = `At most ${MAX_PIN_PHOTOS} photos per pin.`; return; }
  const batch = files.slice(0, room);
  if (batch.length < files.length) showToast(`Only ${room} more photo${room === 1 ? '' : 's'} allowed on this pin`);
  const keep = !!document.getElementById('pin-photo-keep')?.checked;

  let pending = batch.length;
  _renderPinPhotos(pointId, pending);
  for (const file of batch) {
    if (status) status.textContent = `Compressing ${file.name}…`;
    try {
      const saved = await _uploadPinPhoto(pointId, file, keep);
      if (saved) _pinPhotos.push(saved);
    } catch (err) {
      if (status) status.textContent = `${file.name}: ${err.message}`;
    }
    pending -= 1;
    if (_editingPoint?.id === pointId) _renderPinPhotos(pointId, pending);
  }
  if (_editingPoint?.id === pointId && status) {
    status.textContent = `${_pinPhotos.length} photo${_pinPhotos.length === 1 ? '' : 's'} attached.`;
  }
};

function _captureDraft() {
  if (!_editingPoint) return;
  _editingPoint.label = document.getElementById('field-label')?.value ?? _editingPoint.label;
  _editingPoint.notes = document.getElementById('field-notes')?.value ?? _editingPoint.notes;
}

window._adminAddContact = id => {
  if (_saving) return;
  _captureDraft();
  if (!id || _editingContactIds.includes(id)) return;
  _editingContactIds.push(id);
  renderDrawerBody();
};

window._adminRemoveContact = id => {
  if (_saving) return;
  _captureDraft();
  _editingContactIds = _editingContactIds.filter(c => c !== id);
  renderDrawerBody();
};

// ── Save / Delete ─────────────────────────────────────────────────────────────
window._adminSave = async () => {
  if (!_editingPoint || _saving || !_accountReady) return;
  if (_editingIsLegacy) return showToast('Import this device-only pin before editing it');
  _captureDraft();
  const snapshot = _copy(_editingPoint);
  const account = _editingIsAccount;
  const epoch = _initEpoch;
  snapshot.label = String(snapshot.label || '').trim();
  if (snapshot.label.length < 2) { showToast('Label must be at least 2 characters'); return; }
  snapshot.notes = String(snapshot.notes || '').trim();
  snapshot.type = _editingType;
  snapshot.contactIds = [..._editingContactIds];
  // This UI never newly publishes an account pin or promotes it to base data.
  snapshot.scope = account ? (_personalPins.find(p => p.id === snapshot.id)?.scope || 'personal') : _editingScope;
  _saving = true; _setBusy(true);
  try {
    const saved = account ? await _accountSession.save(snapshot) : await savePoint(snapshot);
    if (epoch !== _initEpoch) return;
    if (!saved?.id || saved.id !== snapshot.id) throw new Error('Save not verified');
    if (account) _syncAccountPins();
    else {
      const index = _points.findIndex(p => p.id === saved.id);
      if (index >= 0) _points[index] = saved; else _points.push(saved);
    }
    _editingPoint = _copy(saved); _isNewPoint = false;
    _v3d.upsertPin(saved); _v3d.updatePinHighlight(saved.id);
    renderPointList(); renderDrawerBody();
    document.getElementById('drawer-title').textContent = saved.label;
    if (!account && _slug) _loadPinPhotos(saved.id);
    showToast(account ? 'Saved and verified in your account' : 'Saved');
    if (account) _setAccountStatus(`My pins are saved to ${_accountEmail}.`);
  } catch (error) {
    showToast(account ? _handleAccountFailure(error) : 'Save failed. Your draft is still open.');
  } finally { _saving = false; _setBusy(false); }
};

window._adminPromoteToShared = async () => {
  if (_saving || !_editingPoint || _editingIsAccount) return;
  if (_editingScope !== 'personal') return;
  const oldScope = _editingScope; _editingScope = 'shared';
  await window._adminSave();
  if (_editingPoint?.scope !== 'shared') _editingScope = oldScope;
};

window._adminDelete = async () => {
  if (!_editingPoint || _saving || !_accountReady) return;
  if (_editingIsLegacy) return showToast('Import this device-only pin before deleting it');
  const snapshot = _copy(_editingPoint), account = _editingIsAccount;
  const epoch = _initEpoch;
  if (!window.confirm(`Delete "${snapshot.label}"${account ? ' from your account' : ''}? Browser-local copies, if any, will be kept.`)) return;
  _saving = true; _setBusy(true);
  try {
    if (!_isNewPoint) {
      if (account) { await _accountSession.remove(snapshot.id); _syncAccountPins(); }
      else { await deletePoint(snapshot.id); _points = _points.filter(p => p.id !== snapshot.id); }
    }
    if (epoch !== _initEpoch) return;
    _setEditorPanel(false);
    _v3d.removePin(snapshot.id); _isNewPoint = false; _editingPoint = null; _editingType = null;
    _pinPhotos = []; _pinPhotosFor = null;
    document.getElementById('list-view').classList.remove('panel-slide-out');
    document.getElementById('editor-view').classList.remove('panel-slide-in');
    document.getElementById('drawer-body').replaceChildren();
    document.getElementById('qr-section').style.display = 'none';
    renderPointList(); _v3d.updatePinHighlight(null);
    showToast('Pin deleted. Browser-local copies kept.');
  } catch (error) { showToast(account ? _handleAccountFailure(error) : 'Delete failed. Remove any attached photos first, then retry.'); }
  finally { _saving = false; _setBusy(false); }
};

// ── Share link helpers ────────────────────────────────────────────────────────
async function _buildShareUrl(pt) {
  if (pt?.sceneId || _editingIsAccount) throw new Error('Account sharing is not enabled');
  const allContacts = await getContacts();
  const contacts = allContacts.filter(c => (pt.contactIds ?? []).includes(c.id));
  const pinData = {
    id: pt.id, label: pt.label, type: pt.type,
    notes: pt.notes ?? '', latlng: pt.latlng,
    contactIds: pt.contactIds ?? [], contacts,
    position3d: pt.position3d, cameraPreset3d: pt.cameraPreset3d,
  };
  return `${location.origin}/viewer3d.html?id=${pt.id}&d=${encodeURIComponent(btoa(JSON.stringify(pinData)))}`;
}

// ── Share link (inline display) ───────────────────────────────────────────────
window._adminShowShareLink = async () => {
  if (!_editingPoint || _editingIsAccount || _editingIsLegacy || _saving) return;
  const row = document.getElementById('share-link-row');
  if (!row) return;
  if (row.style.display !== 'none') { row.style.display = 'none'; return; }

  let url = `${location.origin}/viewer3d.html?id=${_editingPoint.id}`;
  try { url = await _buildShareUrl(_editingPoint); } catch {}

  const input = document.getElementById('share-url-input');
  if (input) input.value = url;
  row.style.display = 'block';
};

window._adminCopyShareUrl = () => {
  const input = document.getElementById('share-url-input');
  if (!input?.value) return;
  navigator.clipboard.writeText(input.value).catch(() => {});
  const btn = document.getElementById('share-copy-btn');
  if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
};

window._toggleInfoBar = () => {
  const panel = document.getElementById('side-panel');
  const btn = document.getElementById('panel-fold-btn');
  const folded = panel.classList.toggle('panel-folded');
  if (btn) btn.classList.toggle('folded', folded);
  // Sync immediately — the CSS transition does the animating, and a delayed
  // call left the buttons 290ms behind the panel on browsers without :has().
  window._updateCamPresetsBottom();
};

// ── QR / link ─────────────────────────────────────────────────────────────────
window._adminToggleQR = async () => {
  if (!_editingPoint || _editingIsAccount || _editingIsLegacy || _saving) return;
  const sec     = document.getElementById('qr-section');
  const visible = sec.style.display !== 'block';
  sec.style.display = visible ? 'block' : 'none';
  if (visible) {
    let url = `${location.origin}/viewer3d.html?id=${_editingPoint.id}`;
    try { url = await _buildShareUrl(_editingPoint); } catch {}
    document.getElementById('qr-canvas-wrap').innerHTML = '';
    generateQR(url, 'qr-canvas-wrap');
  }
};

window._adminDownloadQR = async () => {
  if (!_editingPoint || _editingIsAccount || _editingIsLegacy || _saving) return;
  let url = `${location.origin}/viewer3d.html?id=${_editingPoint.id}`;
  try { url = await _buildShareUrl(_editingPoint); } catch {}
  downloadQR(url, `sitenav-${_editingPoint.id.slice(0, 8)}.png`);
};

// ── Contact manager ───────────────────────────────────────────────────────────
let _contactTbodyListenerAdded = false;

window.openContactManager = async () => {
  if (_saving || !_accountReady) return;
  _contactsAll = await getStaffContacts(_slug);
  _contacts    = [..._contactsAll];
  window.renderContactTable('');
  document.getElementById('modal-backdrop').classList.add('open');

  if (!_contactTbodyListenerAdded) {
    _contactTbodyListenerAdded = true;
    document.getElementById('contact-tbody').addEventListener('change', e => {
      const cb = e.target.closest('[data-contact-id]');
      if (cb && cb.type === 'checkbox') window._adminToggleActive(cb.dataset.contactId, cb.checked);
    });
  }
};

window.closeContactManager = () => {
  document.getElementById('modal-backdrop').classList.remove('open');
};

window.handleModalBackdrop = e => {
  if (e.target === document.getElementById('modal-backdrop')) window.closeContactManager();
};

window.renderContactTable = (filter = '') => {
  const q    = (filter ?? '').toLowerCase();
  const rows = _contactsAll.filter(c =>
    !q || c.name.toLowerCase().includes(q) || c.role.toLowerCase().includes(q) || c.phone.includes(q)
  );
  const usedIds = new Set(_points.flatMap(p => p.contactIds));
  document.getElementById('contact-tbody').innerHTML = rows.map(c => {
    const orphan = !usedIds.has(c.id);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    if (c.active) cb.checked = true;
    cb.dataset.contactId = c.id;
    return `<tr>
      <td>${_esc(c.name)}${orphan ? '<span class="orphan-badge">orphan</span>' : ''}</td>
      <td>${_esc(c.role)}</td>
      <td>${_esc(c.phone)}</td>
      <td>${cb.outerHTML}</td>
    </tr>`;
  }).join('');
};

window._adminToggleActive = async (id, active) => {
  const c = _contactsAll.find(x => x.id === id);
  if (!c) return;
  c.active = active;
  await saveContact(c);
};

window.addNewContact = () => {
  const tbody = document.getElementById('contact-tbody');
  const row   = document.createElement('tr');
  row.innerHTML = `
    <td><input class="form-input" id="nc-name"  placeholder="Full name"     style="padding:5px 8px"></td>
    <td><input class="form-input" id="nc-role"  placeholder="Role"          style="padding:5px 8px"></td>
    <td><input class="form-input" id="nc-phone" placeholder="04xx xxx xxx"  style="padding:5px 8px"></td>
    <td><button class="btn-primary" style="width:auto;padding:5px 10px;font-size:12px" onclick="window._adminSaveNewContact()">Save</button></td>
  `;
  tbody.prepend(row);
  document.getElementById('nc-name').focus();
};

window._adminSaveNewContact = async () => {
  const name  = document.getElementById('nc-name').value.trim();
  const role  = document.getElementById('nc-role').value.trim();
  const phone = document.getElementById('nc-phone').value.trim();
  if (!name || !phone) { showToast('Name and phone are required'); return; }
  const contact = {
    id: _uuid(), name, role, phone, email: '',
    active: true, createdBy: 'browser', createdAt: new Date().toISOString(),
  };
  await saveContact(contact);
  _contactsAll.push(contact);
  _contacts.push(contact);
  window.renderContactTable(document.getElementById('contact-search').value);
  showToast('Contact saved');
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _escAttr(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className   = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}
