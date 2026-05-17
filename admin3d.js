import { getContacts, getPoints, savePoint, deletePoint, saveContact } from './db.js';
import { generateQR, downloadQR } from './qr.js';

// ── State ─────────────────────────────────────────────────────────────────────
let _v3d           = null;
let _points        = [];
let _contacts      = [];
let _contactsAll   = [];
let _siteBounds    = null;
let _editingPoint  = null;
let _editingType   = null;
let _editingContactIds = [];
let _saving        = false;
let _isNewPoint    = false;
let _placing        = false;

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

  await Promise.all(_points.map(async pt => {
    pt.position3d = await _v3d.latlngToScene(pt.latlng[0], pt.latlng[1]);
  }));

  _v3d.renderPins(_points);
  renderPointList();
});

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
    latlng,
    position3d: { x: pos3d.x, y: 0, z: pos3d.z },
    notes: '',
    contactIds: [],
    routeWaypoints: [],
    routeWaypoints3d: [],
    cameraPreset3d: { position: { x: 0, y: 5, z: -3 }, lookAt: { x: 0, y: 0, z: 0 } },
    buildingRef: '',
    createdBy: 'browser',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  _isNewPoint = true;
  _v3d.renderPins([newPt]);
  openEditor(newPt);
}

// ── Point list (right panel) ──────────────────────────────────────────────────
function renderPointList(filter = '') {
  const el = document.getElementById('point-list');
  const lf = filter.toLowerCase();
  const visible = _points.filter(p =>
    !lf || p.label.toLowerCase().includes(lf) || p.type.includes(lf)
  );
  const groups = { 'drop-off': [], 'collection': [], 'both': [] };
  visible.forEach(p => (groups[p.type] ?? groups['drop-off']).push(p));
  const dotColor = { 'drop-off': 'var(--primary)', 'collection': 'var(--accent)', 'both': 'var(--amber)' };
  const typeLabel = { 'drop-off': 'Drop-off', 'collection': 'Collection', 'both': 'Both' };

  let html = '';
  for (const [type, pts] of Object.entries(groups)) {
    if (!pts.length) continue;
    html += `<div class="list-section">${typeLabel[type]}</div>`;
    pts.forEach(p => {
      const isActive = _editingPoint?.id === p.id;
      html += `<div class="point-item${isActive ? ' selected' : ''}" onclick="window._adminOpenEditor('${p.id}')">
        <div class="pt-dot" style="background:${dotColor[type]}"></div>
        <div class="pt-label">${_esc(p.label)}</div>
        <span style="color:var(--text-tertiary);font-size:16px">›</span>
      </div>`;
    });
  }
  if (!visible.length) {
    html = `<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px">No pins found</div>`;
  }
  el.innerHTML = html;
}

window._adminOpenEditor = id => openEditor(_points.find(p => p.id === id));
window.filterPins = val => renderPointList(val);

// ── Editor drawer ─────────────────────────────────────────────────────────────
function openEditor(pt) {
  if (!pt) return;
  _editingPoint = pt;
  _editingContactIds = [...pt.contactIds];
  _editingType = pt.type;
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
  const chips = assigned.map(c => `
    <span class="contact-chip">${_esc(c.name)}
      <button class="chip-remove" onclick="window._adminRemoveContact('${c.id}')" aria-label="Remove">&times;</button>
    </span>`).join('');
  const typeLabel = { 'drop-off': 'Drop-off', 'collection': 'Collection', 'both': 'Both' };

  document.getElementById('drawer-body').innerHTML = `
    <div class="form-group">
      <label class="form-label">Label <span style="color:var(--red)">*</span></label>
      <input class="form-input" id="field-label" value="${_esc(pt.label)}" maxlength="80" placeholder="e.g. Dock 1 – Receiving">
    </div>
    <div class="form-group">
      <label class="form-label">Type</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${['drop-off','collection','both'].map(t => `
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer">
            <input type="radio" name="pt-type" value="${t}" ${_editingType===t?'checked':''} onchange="window._adminSetType('${t}')">
            ${typeLabel[t]}
          </label>`).join('')}
      </div>
    </div>
    <div class="form-group full">
      <label class="form-label">Contacts</label>
      <div id="contact-chips" style="margin-bottom:6px">
        ${chips || '<span style="font-size:12px;color:var(--text-secondary)">None assigned</span>'}
      </div>
      <select class="form-input" id="contact-picker" onchange="window._adminAddContact(this.value)" style="max-width:280px">
        <option value="">Add contact…</option>
        ${unassigned.map(c => `<option value="${c.id}">${_esc(c.name)} — ${_esc(c.role)}</option>`).join('')}
      </select>
    </div>
    <div class="form-group full">
      <label class="form-label">Notes (optional)</label>
      <textarea class="form-input" id="field-notes">${_esc(pt.notes ?? '')}</textarea>
    </div>
    <div class="full" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="btn-primary" style="width:auto;padding:9px 18px" onclick="window._adminSave()">Save pin</button>
      <div style="display:flex;gap:8px;flex:1;min-width:180px">
        <button class="btn-secondary" style="flex:1" onclick="window._adminToggleQR()">QR code</button>
        <button class="btn-secondary" style="flex:1" onclick="window._adminCopyLink()">Copy link</button>
      </div>
      <button class="btn-primary danger" style="width:auto;padding:9px 14px" onclick="window._adminDelete()">Delete</button>
    </div>
  `;
}

window._adminSetType = type => { _editingType = type; };

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
    _editingPoint.contactIds = [..._editingContactIds];
    _editingPoint.updatedAt  = new Date().toISOString();

    await savePoint(_editingPoint);

    const idx = _points.findIndex(p => p.id === _editingPoint.id);
    if (idx >= 0) _points[idx] = _editingPoint; else _points.push(_editingPoint);
    _isNewPoint = false;

    await _syncPin(_editingPoint);
    renderPointList();
    renderDrawerBody();
    document.getElementById('drawer-title').textContent = _editingPoint.label;
    showToast('Saved');
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
      await deletePoint(id);
      _points = _points.filter(p => p.id !== id);
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

async function _syncPin(pt) {
  _v3d.removePin(pt.id);
  pt.position3d = await _v3d.latlngToScene(pt.latlng[0], pt.latlng[1]);
  _v3d.renderPins([pt]);
  _v3d.updatePinHighlight(pt.id);
}

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

// ── Contact manager ───────────────────────────────────────────────────────────
window.openContactManager = async () => {
  _contactsAll = await getContacts();
  _contacts    = [..._contactsAll];
  window.renderContactTable('');
  document.getElementById('modal-backdrop').classList.add('open');
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
    return `<tr>
      <td>${_esc(c.name)}${orphan ? '<span class="orphan-badge">orphan</span>' : ''}</td>
      <td>${_esc(c.role)}</td>
      <td>${_esc(c.phone)}</td>
      <td><input type="checkbox" ${c.active ? 'checked' : ''} onchange="window._adminToggleActive('${c.id}',this.checked)"></td>
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

function showToast(msg) {
  const t = document.createElement('div');
  t.className   = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}
