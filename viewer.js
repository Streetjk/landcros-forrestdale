import { getPoint, getContacts } from './db.js';
import { initMap, animateRoute, ENTRY_GATE_LATLNG, EXIT_GATE_LATLNG } from './map.js';

const params = new URLSearchParams(location.search);
const pointId = params.get('id');

let _navCtrl = null;

async function boot() {
  const { map } = await initMap('map');

  if (!pointId) { showError(); return; }

  const [point, contacts] = await Promise.all([getPoint(pointId), getContacts()]);
  if (!point) { showError(); return; }

  const assigned = point.contactIds.map(id => contacts.find(c => c.id === id)).filter(Boolean);

  // Pulsing marker at point
  const pinColors = { 'drop-off': '#185FA5', 'collection': '#1D9E75', 'both': '#854F0B' };
  const color = pinColors[point.type] ?? '#185FA5';
  const marker = L.circleMarker(point.latlng, {
    radius: 11,
    color,
    fillColor: color,
    fillOpacity: 0.9,
    weight: 3,
  }).addTo(map).bindTooltip(point.label, { permanent: true, direction: 'top', offset: [0, -16] });

  map.setView(point.latlng, 1);

  // Gate flags
  [
    { latlng: await ENTRY_GATE_LATLNG, label: '▶ Entry', color: '#1D9E75' },
    { latlng: await EXIT_GATE_LATLNG,  label: 'Exit ▶',  color: '#DC2626' },
  ].forEach(g => {
    L.marker(g.latlng, {
      icon: L.divIcon({
        className: '',
        html: `<div style="background:${g.color};color:#fff;font-size:11px;font-weight:600;padding:3px 8px;border-radius:6px;white-space:nowrap">${g.label}</div>`,
        iconAnchor: [30, 14],
      }),
    }).addTo(map);
  });

  // Info panel
  const chipClass = { 'drop-off': 'chip-dropoff', 'collection': 'chip-collection', 'both': 'chip-both' };
  const chipLabel = { 'drop-off': 'Drop-off', 'collection': 'Collection', 'both': 'Drop-off & Collection' };
  document.getElementById('type-chip').className = `chip ${chipClass[point.type] ?? ''}`;
  document.getElementById('type-chip').textContent = chipLabel[point.type] ?? point.type;
  document.getElementById('point-label').textContent = point.label;
  document.getElementById('point-notes').textContent = point.notes ?? '';

  document.getElementById('contacts-list').innerHTML = assigned.map(c => {
    const initials = c.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    return `
      <div class="contact-card">
        <div class="contact-avatar">${initials}</div>
        <div style="flex:1">
          <div class="contact-name">${_esc(c.name)}</div>
          <div class="contact-role">${_esc(c.role)}</div>
          <a class="contact-phone-link" href="tel:${c.phone.replace(/\s/g, '')}">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5.5 2.5c.5 1 1 2.5.5 3.5L4.5 7c1 2 2.5 3.5 4.5 4.5l1-1.5c1-.5 2.5 0 3.5.5v2.5C13.5 13.5 12 14 11 14 6 14 2 10 2 5c0-1 .5-2.5 1.5-2.5h2z"/></svg>
            ${_esc(c.phone)}
          </a>
        </div>
      </div>
    `;
  }).join('') || '<p style="color:var(--text-secondary);font-size:13px">No contacts assigned.</p>';

  if (point.routeWaypoints?.length > 1) {
    document.getElementById('btn-nav').style.display = 'flex';
  }

  // Store point + map for nav
  window._viewerPoint = point;
  window._viewerMap = map;
}

window.startNav = async () => {
  const point = window._viewerPoint;
  const map = window._viewerMap;
  if (!point || !map) return;

  if (_navCtrl) { _navCtrl.restart(); return; }

  const entry = await ENTRY_GATE_LATLNG;
  const exit  = await EXIT_GATE_LATLNG;
  const waypoints = [entry, ...point.routeWaypoints, exit];

  map.dragging.enable();

  _navCtrl = animateRoute(map, waypoints, {
    color: '#185FA5',
    weight: 4,
    dashArray: '8 8',
    animationDurationMs: 4000,
  });

  // Step-by-step directions (bearing-derived)
  const steps = _buildSteps(waypoints);
  const stepList = document.getElementById('step-list');
  stepList.style.display = 'block';
  stepList.innerHTML = steps.map(s => `<li>${s}</li>`).join('');

  document.getElementById('btn-nav').textContent = '↺ Replay';
  document.getElementById('btn-nav').onclick = () => _navCtrl.restart();
};

function _buildSteps(waypoints) {
  const DIRS = ['N','NE','E','SE','S','SW','W','NW'];
  const steps = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const [lat1, lng1] = Array.isArray(waypoints[i]) ? waypoints[i] : [waypoints[i].lat, waypoints[i].lng];
    const [lat2, lng2] = Array.isArray(waypoints[i+1]) ? waypoints[i+1] : [waypoints[i+1].lat, waypoints[i+1].lng];
    const bearing = Math.atan2(lng2 - lng1, lat2 - lat1) * 180 / Math.PI;
    const dir = DIRS[Math.round(((bearing + 360) % 360) / 45) % 8];
    const label = i === 0 ? 'Enter via entry gate' : i === waypoints.length - 2 ? 'Exit via exit gate' : `Continue ${dir}`;
    steps.push(label);
  }
  return steps;
}

function showError() {
  document.getElementById('point-view').style.display = 'none';
  document.getElementById('error-view').style.display = 'block';
}

function _esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

boot();
