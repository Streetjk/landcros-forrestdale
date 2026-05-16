import { getContacts, getPoints, savePoint, deletePoint, saveContact, getChangelog, searchContacts } from './db.js';
import { initMap, renderRoadNetwork } from './map.js';
import { generateQR, downloadQR } from './qr.js';
import { findRoute, nearestNode, buildGraph, dijkstra } from './pathfinder.js';

// ── State ──────────────────────────────────────────────────────────────────

let _map = null;
let _points = [];
let _contacts = [];
let _markers = {};
let _placementMode = false;
let _editingPoint = null;
let _editingContactIds = [];
let _selectedMarker = null;
let _contactsAll = [];

// Road editor state
let _roads = { nodes: [], edges: [] };
let _roadMode = false;
let _roadPendingFrom = null;   // node id waiting for edge destination
let _roadNodeLayers = {};      // nodeId → L.CircleMarker
let _roadEdgeGroup = null;
let _roadNodeGroup = null;
let _roadDrawLine = null;      // temporary polyline while drawing edge

// ── Boot ───────────────────────────────────────────────────────────────────

async function boot() {
  const { map } = await initMap('map');
  _map = map;

  [_points, _contacts] = await Promise.all([getPoints(), getContacts()]);
  _contactsAll = [..._contacts];

  // Load road network
  try {
    const r = await fetch('./data/roads.json');
    _roads = await r.json();
  } catch {}

  renderMarkers();
  renderPointList();
  _renderRoadLayers();

  _map.on('click', onMapClick);
  _map.on('mousemove', _onMapMouseMove);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { cancelPlacement(); _cancelRoadEdge(); }
  });
}

// ── Marker rendering ───────────────────────────────────────────────────────

const PIN_COLORS = { 'drop-off': '#185FA5', 'collection': '#1D9E75', 'both': '#854F0B' };

function _pinIcon(type, selected = false) {
  const color = PIN_COLORS[type] ?? '#6b7280';
  const size = selected ? 34 : 26;
  const ring = selected ? `<circle cx="16" cy="13" r="13" fill="${color}22" stroke="${color}" stroke-width="1.5"/>` : '';
  const svgW = selected ? 32 : 24;
  return L.divIcon({
    className: '',
    iconSize: [svgW, svgW + 10],
    iconAnchor: [svgW / 2, svgW + 10],
    html: `<svg width="${svgW}" height="${svgW + 10}" viewBox="0 0 32 42" xmlns="http://www.w3.org/2000/svg">
      ${ring}
      <circle cx="16" cy="13" r="${selected ? 11 : 9}" fill="${color}" />
      <line x1="16" y1="${selected ? 24 : 22}" x2="16" y2="42" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
    </svg>`,
  });
}

function renderMarkers() {
  // Remove stale markers
  Object.keys(_markers).forEach(id => {
    if (!_points.find(p => p.id === id)) {
      _map.removeLayer(_markers[id]);
      delete _markers[id];
    }
  });

  _points.forEach(pt => {
    const latlng = L.latLng(pt.latlng[0], pt.latlng[1]);
    if (_markers[pt.id]) {
      _markers[pt.id].setLatLng(latlng);
      _markers[pt.id].setIcon(_pinIcon(pt.type, _editingPoint?.id === pt.id));
    } else {
      const marker = L.marker(latlng, { icon: _pinIcon(pt.type) })
        .addTo(_map)
        .bindTooltip(pt.label, { permanent: false, direction: 'top', offset: [0, -28] });
      marker.on('click', () => openEditor(pt));
      _markers[pt.id] = marker;
    }
  });
}

// ── Point list ─────────────────────────────────────────────────────────────

function renderPointList(filter = '') {
  const el = document.getElementById('point-list');
  const lf = filter.toLowerCase();
  const visible = _points.filter(p =>
    !lf || p.label.toLowerCase().includes(lf) || p.type.includes(lf)
  );

  const groups = { 'drop-off': [], 'collection': [], 'both': [] };
  visible.forEach(p => (groups[p.type] ?? groups['drop-off']).push(p));

  let html = '';
  const labels = { 'drop-off': 'Drop-off', 'collection': 'Collection', 'both': 'Drop-off & Collection' };
  for (const [type, pts] of Object.entries(groups)) {
    if (!pts.length) continue;
    html += `<div class="section-label">${labels[type]}</div>`;
    pts.forEach(p => {
      const contacts = p.contactIds.map(id => _contacts.find(c => c.id === id)).filter(Boolean);
      const isActive = _editingPoint?.id === p.id;
      html += `<div class="point-row${isActive ? ' active' : ''}" onclick="window._adminOpenEditor('${p.id}')">
        <div class="point-dot dot-${type.replace('-', '')}"></div>
        <div class="point-row-info">
          <div class="point-row-label">${_esc(p.label)}</div>
          <div class="point-row-sub">${contacts.map(c => c.name.split(' ')[0]).join(', ') || 'No contacts'}</div>
        </div>
        <span class="point-row-arrow">›</span>
      </div>`;
    });
  }
  if (!visible.length) {
    html = `<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px">No points found</div>`;
  }
  el.innerHTML = html;
}

window._adminOpenEditor = id => openEditor(_points.find(p => p.id === id));
window.filterPoints = val => renderPointList(val);

// ── Placement mode ─────────────────────────────────────────────────────────

window.togglePlacement = () => {
  _placementMode = !_placementMode;
  document.getElementById('placement-hint').style.display = _placementMode ? 'block' : 'none';
  document.getElementById('place-btn').textContent = _placementMode ? 'Cancel placement' : '+ Place new point';
  document.getElementById('place-btn').classList.toggle('active', _placementMode);
  _map.getContainer().style.cursor = _placementMode ? 'crosshair' : '';
};

function cancelPlacement() {
  if (_placementMode) {
    _placementMode = false;
    document.getElementById('placement-hint').style.display = 'none';
    document.getElementById('place-btn').textContent = '+ Place new point';
    document.getElementById('place-btn').classList.remove('active');
    _map.getContainer().style.cursor = '';
  }
}

function onMapClick(e) {
  if (_roadMode) { _onRoadMapClick(e); return; }
  if (!_placementMode) return;
  cancelPlacement();
  const newPoint = {
    id: crypto.randomUUID(),
    label: 'New point',
    type: 'drop-off',
    latlng: [e.latlng.lat, e.latlng.lng],
    position3d: { x: 0, y: 0, z: 0 },
    routeWaypoints: [],
    routeWaypoints3d: [],
    cameraPreset3d: { position: { x: 0, y: 5, z: -3 }, lookAt: { x: 0, y: 0, z: 0 } },
    contactIds: [],
    notes: '',
    buildingRef: '',
    createdBy: window._spPageContextInfo?.userDisplayName ?? 'browser',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  _points.push(newPoint);
  renderMarkers();
  renderPointList();
  openEditor(newPoint);
}

// ── Editor drawer ──────────────────────────────────────────────────────────

window.openEditor = function openEditor(pt) {
  _editingPoint = pt;
  _editingContactIds = [...pt.contactIds];

  document.getElementById('drawer-title').textContent = pt.label || 'New point';
  document.getElementById('editor-drawer').classList.add('open');

  renderMarkers();
  renderPointList();
  renderDrawerBody();
};

window.closeEditor = function closeEditor() {
  _editingPoint = null;
  document.getElementById('editor-drawer').classList.remove('open');
  document.getElementById('qr-section').classList.remove('visible');
  renderMarkers();
  renderPointList();
};

function renderDrawerBody() {
  const pt = _editingPoint;
  const allContacts = _contacts.filter(c => c.active);
  const assigned = _editingContactIds.map(id => allContacts.find(c => c.id === id)).filter(Boolean);
  const unassigned = allContacts.filter(c => !_editingContactIds.includes(c.id));
  const chips = assigned.map(c => `
    <span class="contact-chip">
      ${_esc(c.name)}
      <button class="chip-remove" onclick="window._adminRemoveContact('${c.id}')" aria-label="Remove">&times;</button>
    </span>
  `).join('');

  const typeLabel = { 'drop-off': 'Drop-off', 'collection': 'Collection', 'both': 'Both' };
  const shareUrl = `${location.origin}${location.pathname.replace('index.html', '')}viewer.html?id=${pt.id}`;

  document.getElementById('drawer-body').innerHTML = `
    <div class="form-group">
      <label class="form-label">Label <span style="color:var(--red)">*</span></label>
      <input class="form-input" id="field-label" value="${_esc(pt.label)}" maxlength="80" placeholder="e.g. Dock 1 – Receiving">
    </div>

    <div class="form-group">
      <label class="form-label">Type</label>
      <div style="display:flex;gap:8px">
        ${['drop-off','collection','both'].map(t => `
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer">
            <input type="radio" name="pt-type" value="${t}" ${pt.type===t?'checked':''} onchange="window._adminSetType('${t}')">
            ${typeLabel[t]}
          </label>
        `).join('')}
      </div>
    </div>

    <div class="form-group full">
      <label class="form-label">Contacts</label>
      <div id="contact-chips" style="margin-bottom:6px">${chips || '<span style="font-size:12px;color:var(--text-secondary)">None assigned</span>'}</div>
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
      <button class="btn-primary" style="width:auto;padding:9px 18px" onclick="window._adminSave()">Save point</button>
      <div class="share-row" style="flex:1;min-width:200px">
        <button class="btn-secondary" onclick="window._adminCopyLink()">Copy 2D link</button>
        <button class="btn-secondary" onclick="window._adminToggleQR()">QR code</button>
      </div>
      <button class="btn-primary danger" style="width:auto;padding:9px 14px" onclick="window._adminDelete()">Delete</button>
    </div>

    <div class="full" id="qr-section">
      <div id="qr-canvas-wrap"></div>
      <br>
      <button class="btn-secondary" style="width:auto" onclick="window._adminDownloadQR()">Download QR PNG</button>
    </div>
  `;
}

window._adminSetType = type => { if (_editingPoint) _editingPoint.type = type; };

window._adminAddContact = id => {
  if (!id || _editingContactIds.includes(id)) return;
  _editingContactIds.push(id);
  renderDrawerBody();
};

window._adminRemoveContact = id => {
  _editingContactIds = _editingContactIds.filter(c => c !== id);
  renderDrawerBody();
};

window._adminSave = async () => {
  if (!_editingPoint) return;
  const label = document.getElementById('field-label').value.trim();
  if (!label || label.length < 3) { showToast('Label must be at least 3 characters'); return; }
  if (_editingContactIds.length === 0) { showToast('Add at least 1 contact before saving'); return; }

  _editingPoint.label = label;
  _editingPoint.notes = document.getElementById('field-notes').value.trim();
  _editingPoint.contactIds = [..._editingContactIds];
  _editingPoint.updatedAt = new Date().toISOString();

  // Auto-calculate route through road network if roads are defined
  if (_roads.nodes.length > 0) {
    const boundsRes = await fetch('./assets/site-map-bounds.json');
    const bounds = await boundsRes.json();
    const route = findRoute(_roads, bounds.entryGate, _editingPoint.latlng);
    if (route) _editingPoint.routeWaypoints = route;
  }

  await savePoint(_editingPoint);
  const idx = _points.findIndex(p => p.id === _editingPoint.id);
  if (idx >= 0) _points[idx] = _editingPoint; else _points.push(_editingPoint);

  renderMarkers();
  renderPointList();
  renderDrawerBody();
  document.getElementById('drawer-title').textContent = _editingPoint.label;
  showToast('Point saved');
};

window._adminDelete = async () => {
  if (!_editingPoint) return;
  if (!confirm(`Delete "${_editingPoint.label}"?`)) return;
  await deletePoint(_editingPoint.id);
  _points = _points.filter(p => p.id !== _editingPoint.id);
  if (_markers[_editingPoint.id]) {
    _map.removeLayer(_markers[_editingPoint.id]);
    delete _markers[_editingPoint.id];
  }
  closeEditor();
  renderPointList();
  showToast('Point deleted');
};

window._adminCopyLink = () => {
  if (!_editingPoint) return;
  const url = `${location.origin}${location.pathname.replace('index.html', '')}viewer.html?id=${_editingPoint.id}`;
  navigator.clipboard.writeText(url).catch(() => {});
  showToast('2D link copied!');
};

window._adminToggleQR = () => {
  if (!_editingPoint) return;
  const sec = document.getElementById('qr-section');
  const visible = sec.classList.toggle('visible');
  if (visible) {
    const url = `${location.origin}${location.pathname.replace('index.html', '')}viewer.html?id=${_editingPoint.id}`;
    document.getElementById('qr-canvas-wrap').innerHTML = '';
    generateQR(url, 'qr-canvas-wrap');
  }
};

window._adminDownloadQR = () => {
  if (!_editingPoint) return;
  const url = `${location.origin}${location.pathname.replace('index.html', '')}viewer.html?id=${_editingPoint.id}`;
  downloadQR(url, `sitenav-${_editingPoint.id.slice(0,8)}.png`);
};

// ── Contact manager ────────────────────────────────────────────────────────

window.openContactManager = async () => {
  _contactsAll = await getContacts();
  renderContactTable('');
  document.getElementById('modal-backdrop').classList.add('open');
};

window.closeContactManager = () => {
  document.getElementById('modal-backdrop').classList.remove('open');
};

window.handleModalBackdrop = e => {
  if (e.target === document.getElementById('modal-backdrop')) closeContactManager();
};

window.renderContactTable = (filter = '') => {
  const q = (filter ?? '').toLowerCase();
  const rows = _contactsAll.filter(c =>
    !q || c.name.toLowerCase().includes(q) || c.role.toLowerCase().includes(q) || c.phone.includes(q)
  );
  // Orphan check: contacts assigned to 0 points
  const usedIds = new Set(_points.flatMap(p => p.contactIds));

  document.getElementById('contact-tbody').innerHTML = rows.map(c => {
    const isOrphan = !usedIds.has(c.id);
    return `<tr>
      <td>
        ${_esc(c.name)}
        ${isOrphan ? '<span class="orphan-badge">orphan</span>' : ''}
      </td>
      <td>${_esc(c.role)}</td>
      <td>${_esc(c.phone)}</td>
      <td>
        <input type="checkbox" ${c.active ? 'checked' : ''} onchange="window._adminToggleActive('${c.id}', this.checked)">
      </td>
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
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><input class="form-input" id="nc-name" placeholder="Full name" style="padding:5px 8px"></td>
    <td><input class="form-input" id="nc-role" placeholder="Role" style="padding:5px 8px"></td>
    <td><input class="form-input" id="nc-phone" placeholder="04xx xxx xxx" style="padding:5px 8px"></td>
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
    id: crypto.randomUUID(),
    name, role, phone,
    email: '',
    active: true,
    createdBy: window._spPageContextInfo?.userDisplayName ?? 'browser',
    createdAt: new Date().toISOString(),
  };
  await saveContact(contact);
  _contactsAll.push(contact);
  _contacts.push(contact);
  renderContactTable(document.getElementById('contact-search').value);
  showToast('Contact saved');
};

// ── Helpers ────────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

boot();

// ── Road editor ────────────────────────────────────────────────────────────

window.toggleRoadEditor = function() {
  _roadMode = !_roadMode;
  const btn = document.getElementById('btn-roads');
  btn.classList.toggle('active', _roadMode);
  btn.textContent = _roadMode ? 'Done editing roads' : 'Edit roads';
  document.getElementById('btn-save-roads').style.display = _roadMode ? '' : 'none';
  document.getElementById('btn-del-node').style.display  = _roadMode ? '' : 'none';
  _map.getContainer().style.cursor = _roadMode ? 'crosshair' : '';
  _renderRoadLayers();
  if (!_roadMode) _cancelRoadEdge();
};

function _renderRoadLayers() {
  if (_roadEdgeGroup) _map.removeLayer(_roadEdgeGroup);
  if (_roadNodeGroup) _map.removeLayer(_roadNodeGroup);
  _roadNodeLayers = {};

  const nodeMap = Object.fromEntries(_roads.nodes.map(n => [n.id, n]));

  // Edges
  _roadEdgeGroup = L.layerGroup();
  _roads.edges.forEach(edge => {
    const a = nodeMap[edge.from], b = nodeMap[edge.to];
    if (!a || !b) return;
    const color = edge.oneWay ? '#DC2626' : '#854F0B';
    _roadEdgeGroup.addLayer(L.polyline([a.latlng, b.latlng], { color, weight: 3, opacity: 0.75, interactive: true })
      .on('click', ev => { if (_roadMode) _onEdgeClick(edge, ev); }));
    // Arrow at midpoint
    const mid = [(a.latlng[0]+b.latlng[0])/2, (a.latlng[1]+b.latlng[1])/2];
    const angle = Math.atan2(b.latlng[0]-a.latlng[0], b.latlng[1]-a.latlng[1]) * 180 / Math.PI;
    _roadEdgeGroup.addLayer(L.marker(mid, {
      interactive: false,
      icon: L.divIcon({
        className: '',
        iconAnchor: [8, 8],
        html: `<div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:12px solid ${color};opacity:.85;transform:rotate(${angle-90}deg)"></div>`,
      }),
    }));
  });
  _roadEdgeGroup.addTo(_map);

  // Nodes
  _roadNodeGroup = L.layerGroup();
  _roads.nodes.forEach(node => {
    const m = L.circleMarker(node.latlng, {
      radius: _roadMode ? 7 : 4,
      color: '#2C2C2A', fillColor: '#fff', fillOpacity: 1, weight: 2,
    }).on('click', ev => { if (_roadMode) { L.DomEvent.stopPropagation(ev); _onNodeClick(node, ev); } });
    if (node.label) m.bindTooltip(node.label, { direction: 'top' });
    _roadNodeGroup.addLayer(m);
    _roadNodeLayers[node.id] = m;
  });
  _roadNodeGroup.addTo(_map);
}

function _onRoadMapClick(e) {
  // Check if we clicked near an existing node (snap)
  const SNAP_M = 15; // metres
  const clicked = e.latlng;
  const snapped = _roads.nodes.find(n => {
    const dl = L.latLng(n.latlng).distanceTo(clicked);
    return dl < SNAP_M;
  });

  if (snapped) {
    _onNodeClick(snapped, e);
    return;
  }

  // Create a new node
  const newNode = { id: `rn-${Date.now()}`, latlng: [clicked.lat, clicked.lng] };
  _roads.nodes.push(newNode);

  if (_roadPendingFrom) {
    // Complete edge from pending → new node
    _roads.edges.push({ id: `re-${Date.now()}`, from: _roadPendingFrom, to: newNode.id, oneWay: true });
    _roadPendingFrom = newNode.id; // chain: keep drawing from new node
  }

  _renderRoadLayers();
  _map.getContainer().style.cursor = 'crosshair';
  showToast(_roadPendingFrom ? 'Node added — click next node or empty space' : 'Node placed — click to start an edge');
}

function _onNodeClick(node, e) {
  if (!_roadPendingFrom) {
    // Start drawing an edge from this node
    _roadPendingFrom = node.id;
    _roadNodeLayers[node.id]?.setStyle({ color: '#185FA5', fillColor: '#185FA5' });
    showToast(`Drawing edge from "${node.label ?? node.id.slice(-4)}" — click destination node or map`);
  } else if (_roadPendingFrom === node.id) {
    // Cancel
    _cancelRoadEdge();
  } else {
    // Complete edge
    _roads.edges.push({ id: `re-${Date.now()}`, from: _roadPendingFrom, to: node.id, oneWay: true });
    _roadPendingFrom = node.id; // keep chaining
    _renderRoadLayers();
    _roadNodeLayers[node.id]?.setStyle({ color: '#185FA5', fillColor: '#185FA5' });
    showToast('Edge added — click next node to keep chaining, or Esc to stop');
  }
}

function _onEdgeClick(edge, e) {
  // Toggle one-way on click when in road mode
  edge.oneWay = !edge.oneWay;
  _renderRoadLayers();
  showToast(`Edge is now ${edge.oneWay ? 'one-way ↑' : 'two-way ↔'}`);
}

function _onMapMouseMove(e) {
  if (!_roadMode || !_roadPendingFrom) return;
  const fromNode = _roads.nodes.find(n => n.id === _roadPendingFrom);
  if (!fromNode) return;
  if (_roadDrawLine) _map.removeLayer(_roadDrawLine);
  _roadDrawLine = L.polyline([fromNode.latlng, [e.latlng.lat, e.latlng.lng]], {
    color: '#185FA5', weight: 2, dashArray: '5 5', opacity: 0.6, interactive: false,
  }).addTo(_map);
}

function _cancelRoadEdge() {
  _roadPendingFrom = null;
  if (_roadDrawLine) { _map.removeLayer(_roadDrawLine); _roadDrawLine = null; }
  _renderRoadLayers();
}

window.saveRoads = async () => {
  // In flat-JSON mode this is in-memory only; swap with your write API.
  console.log('Roads data (copy to data/roads.json):', JSON.stringify(_roads, null, 2));
  showToast('Roads saved (see console for JSON — paste into data/roads.json)');
};

window.deleteSelectedNode = () => {
  if (!_roadPendingFrom) { showToast('Click a node first to select it'); return; }
  _roads.nodes = _roads.nodes.filter(n => n.id !== _roadPendingFrom);
  _roads.edges = _roads.edges.filter(e => e.from !== _roadPendingFrom && e.to !== _roadPendingFrom);
  _roadPendingFrom = null;
  _renderRoadLayers();
  showToast('Node deleted');
};
