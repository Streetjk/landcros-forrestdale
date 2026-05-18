// Shared Leaflet map initialisation, road network rendering, and route animation.
// Depends on Leaflet being loaded globally (L).

let _boundsData = null;

async function _loadBounds() {
  if (_boundsData) return _boundsData;
  const res = await fetch('./assets/site-map-bounds.json');
  _boundsData = await res.json();
  return _boundsData;
}

export const SITE_BOUNDS       = await _loadBounds().then(d => d.bounds);
export const ENTRY_GATE_LATLNG = await _loadBounds().then(d => d.entryGate);
export const EXIT_GATE_LATLNG  = await _loadBounds().then(d => d.exitGate ?? d.gate2 ?? d.gate1);

// Inverse of viewer3d.js latlngToScene — converts Three.js world pos3d → [lat, lng].
// Scene is mapped: x ∈ [-20,20] = lng range, z ∈ [-15,15] = lat range (inverted).
function _sceneToLatlng(pos3d) {
  const [[swLat, swLng], [neLat, neLng]] = SITE_BOUNDS;
  const lat = swLat + (-pos3d.z / 30 + 0.5) * (neLat - swLat);
  const lng = swLng + ( pos3d.x / 40 + 0.5) * (neLng - swLng);
  return [lat, lng];
}

// Returns true when GeoJSON geometry coordinates are still placeholder zeros.
function _isPlaceholderGeom(feature) {
  const coords = feature.geometry?.coordinates?.[0];
  return !coords || coords.every(([x, y]) => x === 0 && y === 0);
}

/**
 * initMap(containerId, options) → { map, imageOverlay, buildingLayer }
 */
export async function initMap(containerId, options = {}) {
  const bounds = await _loadBounds();
  const leafletBounds = L.latLngBounds(bounds.bounds[0], bounds.bounds[1]);

  // Custom CRS: linear pixel mapping for pseudo-coordinates (not real GPS).
  // These fake coords were designed for L.CRS.Simple; EPSG3857 distorts them.
  // Transformation maps [swLng..neLng] → [0..imgW] and [neLat..swLat] → [0..imgH].
  const [[swLat, swLng], [neLat, neLng]] = bounds.bounds;
  const imgW = 1934, imgH = 1236;  // satellite.png dimensions
  const scaleX = imgW / (neLng - swLng);
  const scaleY = imgH / (neLat - swLat);
  const SiteMapCRS = L.Util.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(scaleX, -scaleX * swLng, -scaleY, scaleY * neLat),
  });

  const map = L.map(containerId, {
    crs: SiteMapCRS,
    minZoom: -3,
    maxZoom: 4,
    maxBounds: leafletBounds.pad(0.3),
    maxBoundsViscosity: 0.85,
    zoomSnap: 0.25,
  });

  let imageOverlay = null;
  const imageCandidates = options.imagePath
    ? [options.imagePath]
    : ['./assets/satellite.png', './assets/site-map.png', './assets/site-map.jpg', './assets/site-map.webp'];
  try {
    for (const p of imageCandidates) {
      const check = await fetch(p, { method: 'HEAD' });
      if (check.ok) { imageOverlay = L.imageOverlay(p, leafletBounds).addTo(map); break; }
    }
  } catch {}

  map.fitBounds(leafletBounds);

  // Building footprints + labels
  let buildingLayer = null;
  try {
    const geoRes = await fetch('./data/buildings.geojson');
    const geoData = await geoRes.json();
    // Only pass features with real polygon geometry to L.geoJSON (skip placeholders).
    const realGeo = { ...geoData, features: geoData.features.filter(f => !_isPlaceholderGeom(f)) };
    buildingLayer = L.geoJSON(realGeo, {
      style: { fillColor: '#378ADD', fillOpacity: 0.15, color: '#185FA5', weight: 1 },
      onEachFeature(feature, layer) {
        const p = feature.properties;
        if (p?.name) {
          const tip = p.department ? `<b>${p.name}</b><br><span style="color:#5F5E5A">${p.department}</span>` : `<b>${p.name}</b>`;
          layer.bindTooltip(tip, { permanent: false, sticky: true });
        }
        layer.on('mouseover', () => layer.setStyle({ fillOpacity: 0.3 }));
        layer.on('mouseout',  () => layer.setStyle({ fillOpacity: 0.15 }));
      },
    }).addTo(map);

    // Building name labels — use polygon centroid if available, else convert pos3d.
    geoData.features.forEach(f => {
      const p = f.properties;
      if (!p?.name || !f.geometry) return;
      let lat, lng;
      if (_isPlaceholderGeom(f) && p.pos3d) {
        [lat, lng] = _sceneToLatlng(p.pos3d);
      } else {
        const coords = f.geometry.coordinates[0];
        lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
        lng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
      }
      L.marker([lat, lng], {
        icon: L.divIcon({
          className: '',
          iconAnchor: [60, 16],
          html: `<div style="
            background:rgba(24,95,165,0.85);color:#fff;
            font:600 10px 'DM Sans',sans-serif;letter-spacing:0.05em;
            padding:3px 8px;border-radius:5px;white-space:nowrap;
            text-align:center;pointer-events:none
          ">${p.name}${p.department ? `<br><span style="font-weight:400;opacity:0.85">${p.department}</span>` : ''}</div>`,
        }),
      }).addTo(map);
    });

    // Loading zones
    renderLoadingZones(map, geoData);
  } catch {}

  return { map, imageOverlay, buildingLayer };
}

/**
 * renderLoadingZones(map, geoData) — draw hatched loading-zone polygons.
 * Returns the Leaflet layer group so the caller can remove/re-add it.
 */
export function renderLoadingZones(map, geoData) {
  const group = L.layerGroup();
  geoData.features.forEach(f => {
    const lz = f.properties?.loadingZone;
    if (!lz) return;
    const color = lz.color ?? '#185FA5';
    const poly = L.polygon(lz.latlng, {
      color,
      weight: 2,
      dashArray: '4 4',
      fillColor: color,
      fillOpacity: 0.18,
    });
    if (lz.label) {
      poly.bindTooltip(`<b>Loading zone</b><br>${lz.label}`, { sticky: true });
    }
    group.addLayer(poly);
  });
  group.addTo(map);
  return group;
}

/**
 * renderRoadNetwork(map, roads) → { nodeGroup, edgeGroup }
 * Draws road edges (coloured by oneWay) and nodes as small circles.
 * Returns groups so the admin editor can remove/redraw them.
 */
export function renderRoadNetwork(map, roads, options = {}) {
  const { interactive = false } = options;
  const nodeMap = Object.fromEntries(roads.nodes.map(n => [n.id, n]));

  const edgeGroup = L.layerGroup();
  roads.edges.forEach(edge => {
    const a = nodeMap[edge.from];
    const b = nodeMap[edge.to];
    if (!a || !b) return;

    const color = edge.oneWay ? '#DC2626' : '#854F0B';
    const line = L.polyline([a.latlng, b.latlng], {
      color,
      weight: 3,
      opacity: 0.7,
      interactive,
    });
    edgeGroup.addLayer(line);

    // Direction arrow at midpoint
    const mid = [
      (a.latlng[0] + b.latlng[0]) / 2,
      (a.latlng[1] + b.latlng[1]) / 2,
    ];
    const angle = Math.atan2(b.latlng[0] - a.latlng[0], b.latlng[1] - a.latlng[1]) * 180 / Math.PI;
    edgeGroup.addLayer(L.marker(mid, {
      icon: L.divIcon({
        className: '',
        iconAnchor: [8, 8],
        html: `<div style="
          width:0;height:0;
          border-left:7px solid transparent;
          border-right:7px solid transparent;
          border-bottom:13px solid ${color};
          opacity:0.85;
          transform:rotate(${angle - 90}deg);
          transform-origin:center;
        "></div>`,
      }),
      interactive,
    }));
  });

  const nodeGroup = L.layerGroup();
  roads.nodes.forEach(node => {
    const circle = L.circleMarker(node.latlng, {
      radius: 5,
      color: '#2C2C2A',
      fillColor: '#fff',
      fillOpacity: 1,
      weight: 2,
      interactive,
    });
    if (node.label) circle.bindTooltip(node.label, { permanent: false, direction: 'top' });
    nodeGroup.addLayer(circle);
  });

  edgeGroup.addTo(map);
  nodeGroup.addTo(map);
  return { nodeGroup, edgeGroup };
}

/**
 * animateRoute(map, waypoints, options) → { stop, restart, line, traveller }
 * waypoints: array of [lat, lng] pairs
 */
export function animateRoute(map, waypoints, options = {}) {
  const {
    color = '#185FA5',
    weight = 4,
    dashArray = '8 8',
    animationDurationMs = 3000,
  } = options;

  const latlngs = waypoints.map(w => L.latLng(w[0], w[1]));

  const line = L.polyline(latlngs, {
    color, weight, dashArray, lineCap: 'round', lineJoin: 'round',
  }).addTo(map);

  const traveller = L.circleMarker(latlngs[0], {
    radius: 7, color, fillColor: color, fillOpacity: 1, weight: 2,
  }).addTo(map);

  const totalPoints = latlngs.length;
  let rafId = null, startTs = null, running = false;

  function _lerp(a, b, t) {
    return L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t);
  }

  function _step(ts) {
    if (!running) return;
    if (!startTs) startTs = ts;
    const progress = Math.min((ts - startTs) / animationDurationMs, 1);
    const rawIdx = progress * (totalPoints - 1);
    const idx = Math.min(Math.floor(rawIdx), totalPoints - 2);
    traveller.setLatLng(_lerp(latlngs[idx], latlngs[Math.min(idx + 1, totalPoints - 1)], rawIdx - idx));
    if (progress < 1) rafId = requestAnimationFrame(_step);
    else running = false;
  }

  function stop()    { running = false; if (rafId) cancelAnimationFrame(rafId); }
  function restart() { stop(); startTs = null; running = true; rafId = requestAnimationFrame(_step); }

  restart();
  return { stop, restart, line, traveller };
}
