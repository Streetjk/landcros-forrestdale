import { getContacts, getPoints, savePoint, deletePoint, saveContact } from './db.js';
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
let _userId        = null;

// ── Esc key ───────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (_placing) _setPlacing(false);
  else if (_editingPoint) window.closeEditor();
});

// ── Init (fires after viewer3d boot completes) ────────────────────────────────
window.addEventListener('viewer3d:ready', async () => {
  _v3d = window._v3d;

  const canvas = _v3d.renderer.domElement;
  const wrap   = canvas.parentElement;

  wrap.addEventListener('pointerdown', _onWrapPointerDown, { capture: true });
  wrap.addEventListener('pointerup', _onWrapPointerUp, { capture: true });
  wrap.addEventListener('click', _onWrapClick, { capture: true });

  _siteBounds = await fetch('./assets/site-map-bounds.json').then(r => r.json());
  [_points, _contacts] = await Promise.all([getPoints(), getContacts()]);
  _contactsAll = [..._contacts];

  _userId = _getUserId();
  _personalPins = _loadPersonalPins();

  const allPins = [..._points, ..._personalPins];
  await Promise.all(allPins.map(async pt => {
    pt.position3d = await _v3d.latlngToScene(pt.latlng[0], pt.latlng[1]);
  }));

  _v3d.renderPins(allPins);
  renderPointList();

  document.getElementById('point-list').addEventListener('click', e => {
    const item = e.target.closest('[data-pt-id]');
    if (item) window._adminOpenEditor(item.dataset.ptId);
  });

  document.getElementById('drawer-body').addEventListener('click', e => {
    const chip = e.target.closest('[data-remove-contact]');
    if (chip) window._adminRemoveContact(chip.dataset.removeContact);
  });

  document.getElementById('drawer-body').addEventListener('change', e => {
    const typeEl = e.target.closest('[data-type-value]');
    if (typeEl) window._adminSetType(typeEl.dataset.typeValue);
    const scopeEl = e.target.closest('[data-scope-value]');
    if (scopeEl) window._adminSetScope(scopeEl.dataset.scopeValue);
  });

  _loadAnalytics();
});

async function _loadAnalytics() {
  const panel = document.getElementById('analytics-panel');
  if (!panel) return;
  try {
    const r = await fetch('/api/visits', { headers: { 'x-admin-token': window.__SN_ADMIN_TOKEN || '' } });
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

// ── Personal pin storage ──────────────────────────────────────────────────────
function _getUserId() {
  if (_userId) return _userId;
  let id = localStorage.getItem('sn_uid');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('sn_uid', id); }
  _userId = id;
  return id;
}

function _loadPersonalPins() {
  try { return JSON.parse(localStorage.getItem('sn_user_pins') || '[]'); }
  catch { return []; }
}

function _savePersonalPins(pins) {
  localStorage.setItem('sn_user_pins', JSON.stringify(pins));
}

function _addToHistory(pt) {
  try {
    const hist = JSON.parse(localStorage.getItem('sn_pin_history') || '[]');
    hist.unshift({ id: pt.id, label: pt.label, latlng: pt.latlng, timestamp: new Date().toISOString() });
    if (hist.length > 50) hist.length = 50;
    localStorage.setItem('sn_pin_history', JSON.stringify(hist));
  } catch {}
}

// ── Inverse coord: scene pos3d → [lat, lng] ───────────────────────────────────
function _sceneToLatlng(x, z) {
  const [sw, ne] = _siteBounds.bounds;
  const lng = (x / 40 + 0.5) * (ne[1] - sw[1]) + sw[1];
  const lat = (-z / 30 + 0.5) * (ne[0] - sw[0]) + sw[0];
  return [lat, lng];
}

// ── Pointerdown: only used to block OrbitControls starting a pan during placement ─
function _onWrapPointerDown(e) {
  if (e.button !== 0 || !_placing) return;
  if (!e.target.closest('#cam-presets')) e.stopPropagation();
}

function _onWrapPointerUp(e) {
  if (e.button !== 0 || !_placing) return;
  if (e.target.closest('#cam-presets, #nav-progress, #splat-progress')) return;
  e.stopPropagation();
  _placeFromEvent(e);
}

function _onWrapClick(e) {
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
  const latlng = _sceneToLatlng(pos3d.x, pos3d.z);
  const newPt = {
    id: _uuid(),
    label: 'New pin',
    type: 'drop-off',
    scope: 'personal',
    latlng,
    position3d: { x: pos3d.x, y: 0, z: pos3d.z },
    notes: '',
    contactIds: [],
    routeWaypoints: [],
    routeWaypoints3d: [],
    cameraPreset3d: { position: { x: 0, y: 5, z: -3 }, lookAt: { x: 0, y: 0, z: 0 } },
    buildingRef: '',
    createdBy: _getUserId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  _isNewPoint = true;
  _v3d.upsertPin(newPt);
  openEditor(newPt);
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

  const groups = { 'drop-off': [], 'collection': [], 'both': [] };
  visibleShared.forEach(p => (groups[p.type] ?? groups['drop-off']).push(p));
  const dotColor = { 'drop-off': 'var(--primary)', 'collection': 'var(--accent)', 'both': 'var(--amber)' };
  const typeLabel = { 'drop-off': 'Drop-off', 'collection': 'Collection', 'both': 'Both' };

  let html = '';

  if (visibleShared.length) {
    html += `<div class="list-section">Shared pins</div>`;
    for (const [type, pts] of Object.entries(groups)) {
      if (!pts.length) continue;
      html += `<div class="list-section" style="font-size:11px;padding-left:12px">${typeLabel[type]}</div>`;
      pts.forEach(p => {
        const isActive = _editingPoint?.id === p.id;
        const item = document.createElement('div');
        item.className = 'point-item' + (isActive ? ' selected' : '');
        item.dataset.ptId = p.id;
        item.innerHTML = `<div class="pt-dot" style="background:${dotColor[type]}"></div><div class="pt-label">${_esc(p.label)}</div><span style="color:var(--text-tertiary);font-size:16px">›</span>`;
        html += item.outerHTML;
      });
    }
  }

  html += `<div class="list-section">My pins</div>`;
  if (visiblePersonal.length) {
    visiblePersonal.forEach(p => {
      const isActive = _editingPoint?.id === p.id;
      const item = document.createElement('div');
      item.className = 'point-item' + (isActive ? ' selected' : '');
      item.dataset.ptId = p.id;
      item.innerHTML = `<div class="pt-dot" style="background:#4F6AF5"></div><div class="pt-label">${_esc(p.label)}</div><span style="color:var(--text-tertiary);font-size:16px">›</span>`;
      html += item.outerHTML;
    });
  } else {
    html += `<div style="padding:12px 16px;font-size:12px;color:var(--text-secondary)">No personal pins yet — place a pin and choose 'My pin'</div>`;
  }

  if (!visibleShared.length && !visiblePersonal.length) {
    html = `<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px">No pins found</div>`;
  }

  el.innerHTML = html;
}

window._adminOpenEditor = id => {
  const pt = _points.find(p => p.id === id) || _personalPins.find(p => p.id === id);
  openEditor(pt);
};
window.filterPins = val => renderPointList(val);

// ── Editor drawer ─────────────────────────────────────────────────────────────
function openEditor(pt) {
  if (!pt) return;
  _editingPoint = pt;
  _editingContactIds = [...pt.contactIds];
  _editingType = pt.type;
  _editingScope = pt.scope ?? 'shared';
  document.getElementById('drawer-title').textContent = pt.label || 'New pin';
  document.getElementById('list-view').classList.add('panel-slide-out');
  document.getElementById('editor-view').classList.add('panel-slide-in');
  renderDrawerBody();
  _v3d?.updatePinHighlight(pt.id);
}

window.closeEditor = function() {
  if (_isNewPoint && _editingPoint) {
    _v3d?.removePin(_editingPoint.id);
    _isNewPoint = false;
  }
  _editingPoint = null;
  _editingType  = null;
  document.getElementById('list-view').classList.remove('panel-slide-out');
  document.getElementById('editor-view').classList.remove('panel-slide-in');
  document.getElementById('qr-section').style.display = 'none';
  renderPointList();
  _v3d?.updatePinHighlight(null);
};

function renderDrawerBody() {
  const pt = _editingPoint;
  const allContacts = _contacts.filter(c => c.active);
  const assigned   = _editingContactIds.map(id => allContacts.find(c => c.id === id)).filter(Boolean);
  const unassigned = allContacts.filter(c => !_editingContactIds.includes(c.id));
  const typeLabel  = { 'drop-off': 'Drop-off', 'collection': 'Collection', 'both': 'Both' };
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

  const typeRadios = ['drop-off', 'collection', 'both'].map(t => {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'pt-type';
    input.value = t;
    input.dataset.typeValue = t;
    if (_editingType === t) input.checked = true;
    label.appendChild(input);
    label.appendChild(document.createTextNode(' ' + typeLabel[t]));
    return label.outerHTML;
  }).join('');

  const scopeRadios = ['personal', 'shared'].map(s => {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'pt-scope';
    input.value = s;
    input.dataset.scopeValue = s;
    if (_editingScope === s) input.checked = true;
    label.appendChild(input);
    label.appendChild(document.createTextNode(s === 'personal' ? ' My pin (this device only)' : ' Shared (saved to site)'));
    return label.outerHTML;
  }).join('');

  // unassigned contacts used by the search autocomplete (attached after innerHTML)

  const actionButtons = isPersonal
    ? `<button class="btn-secondary" style="flex:1" onclick="window._adminSharePersonal()">Share…</button>`
    : `<button class="btn-secondary" style="flex:1" onclick="window._adminToggleQR()">QR code</button>
       <button class="btn-secondary" style="flex:1" onclick="window._adminCopyLink()">Copy link</button>`;

  document.getElementById('drawer-body').innerHTML = `
    <div class="form-group">
      <label class="form-label">Label <span style="color:var(--red)">*</span></label>
      <input class="form-input" id="field-label" value="${_esc(pt.label)}" maxlength="80" placeholder="e.g. Dock 1 – Receiving">
    </div>
    <div class="form-group">
      <label class="form-label">Type</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${typeRadios}</div>
    </div>
    <div class="form-group">
      <label class="form-label">Pin scope</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${scopeRadios}</div>
    </div>
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
    <div class="full" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="btn-primary" style="width:auto;padding:9px 18px" onclick="window._adminSave()">Save pin</button>
      <div style="display:flex;gap:8px;flex:1;min-width:180px">${actionButtons}</div>
      <button class="btn-primary danger" style="width:auto;padding:9px 14px" onclick="window._adminDelete()">Delete</button>
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
}

window._adminSetType  = type  => { _editingType  = type;  };
window._adminSetScope = scope => { _editingScope = scope; renderDrawerBody(); };

window._adminAddContact = id => {
  if (!id || _editingContactIds.includes(id)) return;
  _editingContactIds.push(id);
  renderDrawerBody();
};

window._adminRemoveContact = id => {
  _editingContactIds = _editingContactIds.filter(c => c !== id);
  renderDrawerBody();
};

// ── Save / Delete ─────────────────────────────────────────────────────────────
window._adminSave = async () => {
  if (!_editingPoint || _saving) return;
  const label = document.getElementById('field-label').value.trim();
  if (label.length < 2) { showToast('Label must be at least 2 characters'); return; }

  _saving = true;
  try {
    _editingPoint.label      = label;
    _editingPoint.notes      = document.getElementById('field-notes').value.trim();
    _editingPoint.type       = _editingType;
    _editingPoint.scope      = _editingScope;
    _editingPoint.contactIds = [..._editingContactIds];
    _editingPoint.updatedAt  = new Date().toISOString();

    if (_editingPoint.scope === 'personal') {
      const idx = _personalPins.findIndex(p => p.id === _editingPoint.id);
      if (idx >= 0) _personalPins[idx] = _editingPoint; else _personalPins.push(_editingPoint);
      _savePersonalPins(_personalPins);
      _addToHistory(_editingPoint);
      _points = _points.filter(p => p.id !== _editingPoint.id);
      _isNewPoint = false;
      _v3d.upsertPin(_editingPoint);
      _v3d.updatePinHighlight(_editingPoint.id);
      renderPointList();
      renderDrawerBody();
      document.getElementById('drawer-title').textContent = _editingPoint.label;
      showToast('Saved to your device');
    } else {
      await savePoint(_editingPoint);
      const idx = _points.findIndex(p => p.id === _editingPoint.id);
      if (idx >= 0) _points[idx] = _editingPoint; else _points.push(_editingPoint);
      _personalPins = _personalPins.filter(p => p.id !== _editingPoint.id);
      _savePersonalPins(_personalPins);
      _addToHistory(_editingPoint);
      _isNewPoint = false;
      _v3d.upsertPin(_editingPoint);
      _v3d.updatePinHighlight(_editingPoint.id);
      renderPointList();
      renderDrawerBody();
      document.getElementById('drawer-title').textContent = _editingPoint.label;
      showToast('Saved');
    }
  } catch (e) {
    showToast('Save failed — ' + (e.message || 'check connection'));
  } finally {
    _saving = false;
  }
};

window._adminDelete = async () => {
  if (!_editingPoint || _saving) return;
  const id    = _editingPoint.id;
  const label = _editingPoint.label;
  _saving = true;
  try {
    if (!_isNewPoint) {
      if (_editingPoint.scope === 'personal') {
        _personalPins = _personalPins.filter(p => p.id !== id);
        _savePersonalPins(_personalPins);
      } else {
        await deletePoint(id);
        _points = _points.filter(p => p.id !== id);
      }
    }
    _v3d.removePin(id);
    _isNewPoint   = false;
    _editingPoint = null;
    _editingType  = null;
    document.getElementById('list-view').classList.remove('panel-slide-out');
    document.getElementById('editor-view').classList.remove('panel-slide-in');
    document.getElementById('qr-section').style.display = 'none';
    renderPointList();
    _v3d.updatePinHighlight(null);
    showToast(`Deleted "${label}"`);
  } catch (e) {
    showToast('Delete failed — ' + e.message);
  } finally {
    _saving = false;
  }
};

// ── QR / link ─────────────────────────────────────────────────────────────────
window._adminToggleQR = () => {
  if (!_editingPoint) return;
  const sec     = document.getElementById('qr-section');
  const visible = sec.style.display !== 'block';
  sec.style.display = visible ? 'block' : 'none';
  if (visible) {
    const url = `${location.origin}/viewer3d.html?id=${_editingPoint.id}`;
    document.getElementById('qr-canvas-wrap').innerHTML = '';
    generateQR(url, 'qr-canvas-wrap');
  }
};

window._adminDownloadQR = () => {
  if (!_editingPoint) return;
  const url = `${location.origin}/viewer3d.html?id=${_editingPoint.id}`;
  downloadQR(url, `sitenav-${_editingPoint.id.slice(0, 8)}.png`);
};

window._adminCopyLink = () => {
  if (!_editingPoint) return;
  const url = `${location.origin}/viewer3d.html?id=${_editingPoint.id}`;
  navigator.clipboard.writeText(url).catch(() => {});
  showToast('Link copied!');
};

window._adminSharePersonal = () => {
  if (!_editingPoint) return;
  const payload = { label: _editingPoint.label, latlng: _editingPoint.latlng, notes: _editingPoint.notes, type: _editingPoint.type };
  const hash = '#share=' + btoa(JSON.stringify(payload));
  const url = `${location.origin}/viewer3d.html${hash}`;
  navigator.clipboard.writeText(url).catch(() => {});
  showToast('Share link copied!');
};

// ── Contact manager ───────────────────────────────────────────────────────────
let _contactTbodyListenerAdded = false;

window.openContactManager = async () => {
  _contactsAll = await getContacts();
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
