# AGY_TASK: sitenav-phase4
baseline_tag: agy-baseline-20260612-231031
branch: main
failed_rounds: 0
diff_budget: 600 added / 3 files

## Goal
Implement three new features for SiteNav to push score to 9.5+/10:

1. **Guided Nav Tour** — implement `window.startNav()` (currently empty stub at viewer3d.js:911)
   using GSAP to fly the camera through `routeWaypoints3d`, driving the existing `#nav-progress` bar.
   Add a "Start Tour" button in the point-detail panel.

2. **Measurement Tool** — click-to-measure distance on the 3D scene using the existing `_pickGround`
   plane raycaster. Show distance in meters as a floating chip. Toggle via a toolbar button.

3. **Analytics Dashboard** — display per-pin visit counts from `GET /api/visits` inside admin3d.html
   as a simple table with total visits + per-pin bar-list.

## Files In Scope
- viewer3d.js
- viewer3d.html
- admin3d.js
- admin3d.html

## Forbidden Paths
- .env*
- .ssh/**
- sites/**/*.json
- sites/**/*.splat
- sites/**/*.ply
- server.js
- gallery.js
- gallery.html
- style.css
- db.js
- package-lock.json

## Acceptance Checks
```yaml
checks:
  - id: no_syntax_errors_viewer
    cmd: node --check /Users/ollama/src/SiteNav/landcros-forrestdale/viewer3d.js 2>&1
    expect: exit_0
    required: true

  - id: no_syntax_errors_admin
    cmd: node --check /Users/ollama/src/SiteNav/landcros-forrestdale/admin3d.js 2>&1
    expect: exit_0
    required: true

  - id: startNav_implemented
    cmd: grep -c "routeWaypoints3d\|nav-bar-fill\|gsap.to" /Users/ollama/src/SiteNav/landcros-forrestdale/viewer3d.js
    expect: exit_0
    required: true

  - id: measure_tool_exists
    cmd: grep -c "measure\|_measureMode\|_measurePts" /Users/ollama/src/SiteNav/landcros-forrestdale/viewer3d.js
    expect: exit_0
    required: true

  - id: analytics_in_admin
    cmd: grep -c "api/visits\|visits\|analytics" /Users/ollama/src/SiteNav/landcros-forrestdale/admin3d.js
    expect: exit_0
    required: true
```

## Risk Ledger
| ID | Description | Likelihood | Impact | Mitigation |
|----|-------------|------------|--------|------------|
| R1 | startNav conflicts with _camTween in selectPoint | Medium | High | Kill existing _camTween before starting tour; share interruptFlyTo pattern |
| R2 | _pickGround raycaster interferes with pin clicks in measure mode | Medium | Medium | In measure mode, stop propagation and disable pin selection |
| R3 | /api/visits returns 404 in static greenfields deploy | Low | Low | Catch fetch error, hide analytics tab gracefully |

---

## FEATURE 1: Guided Nav Tour (viewer3d.js + viewer3d.html)

### Context (read before coding)

The existing camera fly-to system uses GSAP (`gsap` is globally available, imported at line 1). 
The `_camTween` variable (line ~180) tracks the current tween. 
`selectPoint(pt)` at line ~744 is the fly-to-pin function — study its pattern.
The `interruptFlyTo` pattern at line ~839 shows how to make a tween interruptible.

`window.startNav = function() {};` is at line 911 — this is the stub to replace.

The `#nav-progress` HUD HTML exists in viewer3d.html:
```html
<div id="nav-progress">
  <div class="nav-label">Camera: <strong id="nav-pos-label">—</strong></div>
  <div class="nav-bar"><div class="nav-bar-fill" id="nav-bar-fill"></div></div>
</div>
```
The CSS: `#nav-progress { display: none; }` and `#nav-progress.visible { display: block; }`

Each pin in `points.json` has `routeWaypoints3d: []` (currently empty arrays — the tour should gracefully skip if empty).

### Implementation

**In viewer3d.js**, replace `window.startNav = function() {};` with:

```js
window.startNav = function(pt) {
  // pt is the currently selected point (passed from the "Start Tour" button)
  const waypoints = pt?.routeWaypoints3d || [];
  const navBar = document.getElementById('nav-bar-fill');
  const navLabel = document.getElementById('nav-pos-label');
  const navProgress = document.getElementById('nav-progress');

  // If no waypoints, just fly to the pin (which selectPoint already did)
  if (!waypoints.length) {
    if (navLabel) navLabel.textContent = pt?.label || 'Destination';
    if (navProgress) navProgress.classList.add('visible');
    if (navBar) navBar.style.width = '100%';
    setTimeout(() => navProgress?.classList.remove('visible'), 2500);
    return;
  }

  // Kill any existing camera tween
  if (_camTween) { _camTween.kill(); _camTween = null; }

  if (navProgress) navProgress.classList.add('visible');
  if (navLabel) navLabel.textContent = 'Starting tour…';

  // Build a GSAP timeline that visits each waypoint in sequence
  const tl = gsap.timeline({
    onComplete() {
      controls.enabled = true;
      _camAnimating = false;
      if (navProgress) navProgress.classList.remove('visible');
      controls.removeEventListener('start', interruptTour);
    },
  });

  const interruptTour = () => {
    tl.kill();
    controls.removeEventListener('start', interruptTour);
    controls.enabled = true;
    _camAnimating = false;
    if (navProgress) navProgress.classList.remove('visible');
  };

  controls.addEventListener('start', interruptTour);
  controls.enabled = false;
  _camAnimating = true;

  const total = waypoints.length;
  waypoints.forEach((wp, i) => {
    const pos = new THREE.Vector3(wp.x ?? wp[0], wp.y ?? wp[1], wp.z ?? wp[2]);
    const prog = { t: 0 };
    const startPos = i === 0 ? camera.position.clone() : null; // first = current pos
    tl.to(prog, {
      t: 1,
      duration: 2.5,
      ease: 'power2.inOut',
      onStart() {
        if (navLabel) navLabel.textContent = `Waypoint ${i + 1} / ${total}`;
        if (navBar) navBar.style.width = `${Math.round((i / total) * 100)}%`;
      },
      onUpdate() {
        const from = startPos || camera.position;
        camera.position.lerp(pos, prog.t);
        controls.target.lerp(pos, prog.t * 0.3);
      },
      onComplete() {
        if (navBar) navBar.style.width = `${Math.round(((i + 1) / total) * 100)}%`;
        if (i === total - 1 && navLabel) navLabel.textContent = pt?.label || 'Arrived';
      },
    }, i === 0 ? '>' : '+=0.3');
  });
};
```

**In viewer3d.html**, find the `#point-detail` panel (around line 1005) which contains the "Contacts" section. After the contacts section, add a "Start Tour" button:

```html
<div class="detail-section" id="detail-nav-section" style="display:none">
  <button class="btn-nav-tour" onclick="window.startNav(window._selectedPt)">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    Start Tour
  </button>
</div>
```

Add CSS for the button in viewer3d.html inline styles:
```css
.btn-nav-tour {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 16px; border: none; border-radius: var(--radius-sm);
  background: var(--color-primary); color: var(--color-text);
  font-family: var(--font-sans); font-size: var(--text-sm);
  font-weight: var(--weight-semibold); cursor: pointer;
  transition: background var(--dur-base);
}
.btn-nav-tour:hover { background: var(--color-secondary); }
```

In `viewer3d.js`, in `selectPoint(pt)`, store the selected point for the nav button:
- Add `window._selectedPt = pt;` near the start of selectPoint (after the null check)
- Show `#detail-nav-section` if `pt.routeWaypoints3d?.length > 0`, hide it otherwise

---

## FEATURE 2: Measurement Tool (viewer3d.js + viewer3d.html)

### Context

`_pickGround` is a `THREE.Mesh` (a large invisible plane) at line ~241, used for raycasting click positions to 3D coordinates. `_raycaster` is at line ~723.

The `latlngToScene()` function at line 25 does the coordinate conversion — it uses `* 40` and `* 30` scale constants. The inverse is used in admin3d.js. The scene-to-real-world distance scale is approximately: 1 scene unit ≈ `bounds_width_meters / 40` meters. From config, use `_cfg.plane.scale` to get [width_m, height_m] which maps to the [40, 30] scene units.

### Implementation

**In viewer3d.js**, add a measurement system. Place this code in a new section near the raycaster/click handling code (after line ~730):

```js
// ── Measurement tool ─────────────────────────────────────────────────────
let _measureMode = false;
let _measurePts = []; // up to 2 THREE.Vector3 world positions
let _measureLine = null;
let _measureMarkers = [];
let _measureChip = null;

function _initMeasure() {
  _measureChip = document.getElementById('measure-chip');
}

function _toggleMeasure(on) {
  _measureMode = on;
  _clearMeasure();
  const btn = document.getElementById('btn-measure');
  if (btn) btn.classList.toggle('active', on);
  if (_measureChip) _measureChip.style.display = on ? 'flex' : 'none';
  if (_measureChip && on) _measureChip.textContent = 'Click two points to measure';
}

function _clearMeasure() {
  _measurePts = [];
  if (_measureLine) { scene.remove(_measureLine); _measureLine = null; }
  _measureMarkers.forEach(m => scene.remove(m));
  _measureMarkers = [];
}

function _addMeasurePoint(worldPos) {
  if (_measurePts.length >= 2) _clearMeasure();
  _measurePts.push(worldPos.clone());

  // Sphere marker
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0x14B8A6 })
  );
  sphere.position.copy(worldPos);
  scene.add(sphere);
  _measureMarkers.push(sphere);

  if (_measurePts.length === 2) {
    // Draw line between the two points
    const geo = new THREE.BufferGeometry().setFromPoints(_measurePts);
    _measureLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x14B8A6, linewidth: 2 }));
    scene.add(_measureLine);

    // Compute real-world distance using scene scale
    const sceneDist = _measurePts[0].distanceTo(_measurePts[1]);
    // Scene is mapped: 40 scene units ≈ planeScaleX meters (from config)
    const planeScale = _cfg.plane?.scale || [62, 39.5];
    const metersPerUnit = planeScale[0] / 40;
    const meters = sceneDist * metersPerUnit;
    if (_measureChip) {
      _measureChip.textContent = meters >= 1000
        ? `${(meters / 1000).toFixed(2)} km`
        : `${meters.toFixed(1)} m`;
    }
  }
}
```

Wire the measurement tool into the existing click handler. Find the section in `viewer3d.js` where `_raycaster.setFromCamera` is called for ground clicks (around line 1362) and add at the top of the click handler:

```js
// Measurement mode intercepts all clicks
if (_measureMode) {
  _raycaster.setFromCamera(_pointer, camera);
  const hits = _raycaster.intersectObject(_pickGround);
  if (hits.length) _addMeasurePoint(hits[0].point);
  return; // don't select pins in measure mode
}
```

Call `_initMeasure()` in `boot()` after scene setup.

**In viewer3d.html**, add the measure chip and button:

Add to inline styles:
```css
#measure-chip {
  position: fixed; bottom: calc(80px + var(--safe-bottom)); left: 50%;
  transform: translateX(-50%);
  display: none; align-items: center; gap: 8px;
  padding: 8px 16px; border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--glass-surface); backdrop-filter: var(--glass-blur);
  font-size: var(--text-sm); font-weight: var(--weight-semibold);
  color: var(--color-text); z-index: var(--z-controls);
  box-shadow: var(--shadow-2);
}
#btn-measure { cursor: pointer; }
#btn-measure.active { background: var(--color-primary); color: var(--color-text); }
```

Add HTML elements (near the cam-presets nav or the viewer-header actions):
```html
<div id="measure-chip"></div>
```

Add a measure button to the camera presets nav or viewer-header actions:
```html
<button class="cam-preset-btn" id="btn-measure" title="Measure distance" 
        onclick="window._v3d && _toggleMeasure(!_measureMode)">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M2 12h20"/><path d="M12 2v20"/><path d="M2 7h5"/><path d="M17 7h5"/><path d="M2 17h5"/><path d="M17 17h5"/>
  </svg>
  <span class="preset-label">Measure</span>
</button>
```

Expose `_toggleMeasure` on `window` so the button's onclick can reach it:
In viewer3d.js after `_initMeasure()` is defined, add: `window._toggleMeasure = _toggleMeasure;`

---

## FEATURE 3: Analytics Dashboard (admin3d.js + admin3d.html)

### Context

`GET /api/visits` already exists in server.js and returns:
```json
{ "total": 42, "firstVisit": "2026-06-01T...", "lastVisit": "2026-06-12T...", "points": { "<pin-id>": 5, ... } }
```

Points are loaded in admin3d.js. There's already a `_pins` or similar data structure. 
The admin has multiple sections — add an "Analytics" section.

### Implementation

**In admin3d.js**, add a function to load and render analytics:

```js
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
    document.querySelectorAll('[data-pin-id]').forEach(el => {
      pinLabels[el.dataset.pinId] = el.dataset.pinLabel || el.dataset.pinId;
    });
    const pointRows = Object.entries(data.points || {})
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => {
        const label = pinLabels[id] || id;
        const pct = data.total ? Math.round((count / data.total) * 100) : 0;
        return `<div class="analytics-row">
          <span class="analytics-label" title="${label}">${label}</span>
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
```

Call `_loadAnalytics()` from the admin's initialization code (after auth gate passes, e.g., at the end of the existing init block).

**In admin3d.html**, add an analytics section. Find a good location in the admin panel (after the existing pin editor sections) and add:

```html
<div class="admin-section" id="analytics-section">
  <h3>Analytics</h3>
  <div id="analytics-panel" style="min-height:40px">
    <p style="color:var(--color-text-muted);font-size:0.875rem">Loading…</p>
  </div>
  <button class="btn-secondary" onclick="_loadAnalytics()" style="margin-top:8px;font-size:0.75rem">Refresh</button>
</div>
```

Add CSS in admin3d.html inline styles:
```css
.analytics-summary { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-bottom: 12px; font-size: 0.75rem; color: var(--color-text-muted); }
.analytics-summary strong { color: var(--color-text); font-weight: 600; }
.analytics-stat-sep { color: var(--color-border); }
.analytics-row { display: grid; grid-template-columns: 1fr 2fr auto; align-items: center; gap: 8px; margin-bottom: 6px; }
.analytics-label { font-size: 0.75rem; color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.analytics-bar-wrap { height: 6px; background: var(--color-surface-2); border-radius: var(--radius-pill); overflow: hidden; }
.analytics-bar { height: 100%; background: var(--color-primary); border-radius: var(--radius-pill); transition: width 0.4s var(--ease-out); }
.analytics-count { font-size: 0.75rem; font-weight: 600; color: var(--color-text); text-align: right; min-width: 24px; }
```

Also expose `_loadAnalytics` on window so the Refresh button's onclick works:
In admin3d.js after the function definition: `window._loadAnalytics = _loadAnalytics;`

---

## IMPORTANT RULES FOR AGY

1. Do NOT modify server.js, gallery.js, style.css — they are forbidden for this task.
2. For the guided tour, use the exact GSAP `gsap.timeline()` API — GSAP is already imported as a global.
3. The measurement tool onclick must call `window._toggleMeasure` (not `_toggleMeasure` directly) since it's called from HTML.
4. The analytics `innerHTML` is built from server data via `JSON.parse` — strings must be escaped. Use textContent where constructing individual elements, or escape values in template literals: replace `<`, `>`, `&`, `"` characters. The `label` field comes from `data.points` keys (which are UUIDs) and is safe, but pin labels from the DOM are user-controlled and should be used carefully.
5. Run all 5 acceptance checks before declaring done.
6. Do NOT use `innerHTML` with unsanitized user data (pin labels). Build analytics rows with textContent or escape the label before interpolating into HTML.
