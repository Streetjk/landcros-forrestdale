# AGY_TASK: sitenav-upgrade
baseline_tag: agy-baseline-20260612-231031
baseline_sha: 9a5f008b792242e6d684de7f044656087c35eacd
branch: main
created_at: 2026-06-12T15:10:31Z
failed_rounds: 0
diff_budget: 800 added / 8 files

## Goal
Upgrade SiteNav landcros-forrestdale from 6.5/10 to 9.5+/10 by:
1. Fixing the broken QR deep-link fly-to (headline feature, completely broken)
2. Fixing the `sn_splat_rot` visitor localStorage override that corrupts the scene
3. Adding ADMIN_TOKEN auth guard on `/api/write` and the admin UI gate
4. Applying a unified CSS token layer + Spatial UI dark design system across all pages
5. Redesigning 7 UI components with the design patterns below (exact CSS provided)

## Files In Scope
- viewer3d.js
- viewer3d.html
- admin3d.html
- admin3d.js
- gallery.html
- gallery.js
- server.js
- db.js
- style.css

## Forbidden Paths
- .env*
- .ssh/**
- migrations/**
- deploy/**
- secrets/**
- production_config/**
- infra/**
- package-lock.json
- render.yaml
- sites/**/*.splat
- sites/**/*.ply

## Acceptance Checks
```yaml
checks:
  - id: server_starts
    cmd: cd /Users/ollama/src/SiteNav/landcros-forrestdale && node -e "const s=require('./server'); setTimeout(()=>process.exit(0),500)" 2>&1
    expect: exit_0
    required: true

  - id: no_syntax_errors_viewer
    cmd: node --check /Users/ollama/src/SiteNav/landcros-forrestdale/viewer3d.js 2>&1
    expect: exit_0
    required: true

  - id: no_syntax_errors_admin
    cmd: node --check /Users/ollama/src/SiteNav/landcros-forrestdale/admin3d.js 2>&1
    expect: exit_0
    required: true

  - id: no_syntax_errors_gallery
    cmd: node --check /Users/ollama/src/SiteNav/landcros-forrestdale/gallery.js 2>&1
    expect: exit_0
    required: true

  - id: api_write_auth_check
    cmd: |
      cd /Users/ollama/src/SiteNav/landcros-forrestdale
      SITE=landcros PORT=3099 ADMIN_TOKEN=testtoken123 node server.js &
      PID=$!
      sleep 1
      CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3099/api/write \
        -H "Content-Type: application/json" \
        -d '{"file":"points.json","data":[]}')
      kill $PID 2>/dev/null
      echo "status: $CODE"
      [ "$CODE" = "401" ] && exit 0 || exit 1
    expect: exit_0
    required: true

  - id: css_token_present
    cmd: grep -c "\-\-color-primary" /Users/ollama/src/SiteNav/landcros-forrestdale/style.css
    expect: exit_0
    required: true
```

## Risk Ledger
| ID | Description | Likelihood | Impact | Mitigation |
|----|-------------|------------|--------|------------|
| R1 | Auth guard locks out the admin if ADMIN_TOKEN env not set on Render | Medium | High | Server returns 503 with clear message when ADMIN_TOKEN unset; doc in README |
| R2 | CSS token layer breaks existing light-theme styles | Medium | Medium | Keep all existing selectors; only replace `:root` values and remove duplicated inline tokens |
| R3 | QR fly-to fires before pins are rendered | Low | Medium | Wrap in existing boot sequencing after renderPins() completes |
| R4 | sn_splat_rot fix removes editor's ability to persist rotation | Low | Low | Debug-mode users can still use it; only blocked for non-debug visitors |

---

## PHASE 1: CODE CORRECTNESS (do these first)

### Fix 1.1 — QR deep-link fly-to (viewer3d.js)

**Problem**: `viewer3d.js:152-157` reads `?id=` only to increment the visit counter. `admin3d.js:519,527,533` generates QR codes pointing to `viewer3d.html?id=<id>` but the viewer ignores the id for navigation. The entire "scan QR → fly to pin" feature is broken.

**Fix**: In `viewer3d.js` in the `boot()` function, after `renderPins(points)` is called (around line 2346), add code to check for `?id=` and call `selectPoint()`:

```js
// After renderPins(points) call in boot():
const _deepId = _params.get('id');
if (_deepId) {
  const _deepPt = points.find(p => p.id === _deepId);
  if (_deepPt) {
    setTimeout(() => selectPoint(_deepPt), 800);
  }
}
```

Do NOT add new camera math — just reuse `selectPoint()` which is already at line 744.

### Fix 1.5 — Stop sn_splat_rot visitor override (viewer3d.js)

**Problem**: `viewer3d.js:2176-2177` applies a visitor's stale `localStorage.sn_splat_rot` over the config value — a visitor who once opened debug mode gets a permanently misrotated scene.

**Fix**: Gate the localStorage read on `_debugMode`:
- Find `const savedRot = _lsGet('sn_splat_rot', null)` (at ~line 2176) 
- Change to: `const savedRot = _debugMode ? _lsGet('sn_splat_rot', null) : null;`
- Also find any other `_lsGet('sn_splat_rot'` calls (at ~2211) and apply same gate.

### Fix 1.2 + 1.3 — Auth for /api/write (server.js + admin3d.html + db.js)

**server.js changes**:
1. Near the top (after the `require()` calls, around line 17), add:
   ```js
   const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
   ```

2. In the `/api/write` handler (around line 91), add auth check at the TOP of the handler, before any file operations:
   ```js
   app.post('/api/write', (req, res) => {
     if (!ADMIN_TOKEN) return res.status(503).json({ error: 'Write API disabled: set ADMIN_TOKEN env var' });
     const token = req.headers['x-admin-token'] || '';
     if (!token || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
     // ... existing handler code continues unchanged ...
   });
   ```
   Note: use simple string equality `token !== ADMIN_TOKEN` — crypto.timingSafeEqual adds complexity without meaningful benefit for a single-token setup.

3. Add a new `/api/auth-check` endpoint before the static file handlers:
   ```js
   app.get('/api/auth-check', (req, res) => {
     if (!ADMIN_TOKEN) return res.status(503).json({ ok: false });
     const token = req.headers['x-admin-token'] || '';
     res.json({ ok: token === ADMIN_TOKEN });
   });
   ```

**db.js changes**:
- In `_writeJSON` function, add the `x-admin-token` header to the POST:
  Find the `fetch('/api/write', { method: 'POST', ...` call and add:
  ```js
  headers: { 'Content-Type': 'application/json', 'x-admin-token': window.__SN_ADMIN_TOKEN || '' },
  ```

**admin3d.html changes**:
- Add an auth gate overlay. Insert this HTML before the `<script type="module">` tags at the bottom:
  ```html
  <div id="sn-auth-gate" style="position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,0.97);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font-family:Inter,system-ui,sans-serif;color:#fff;">
    <h2 style="margin:0;font-size:1.25rem;font-weight:600;">SiteNav Admin</h2>
    <p style="margin:0;color:#94A3B8;font-size:0.875rem;">Enter the admin token to continue</p>
    <input id="sn-token-input" type="password" placeholder="Admin token" autocomplete="current-password"
      style="padding:8px 12px;border:1px solid rgba(255,255,255,0.12);border-radius:8px;background:#192134;color:#fff;font-size:0.875rem;width:260px;outline:none;" />
    <button id="sn-token-submit"
      style="padding:8px 24px;background:#0F766E;border:none;border-radius:8px;color:#fff;font-weight:600;cursor:pointer;font-size:0.875rem;">
      Enter
    </button>
    <p id="sn-token-error" style="margin:0;color:#DC2626;font-size:0.875rem;display:none;">Invalid token</p>
  </div>
  <script>
  (function() {
    const gate = document.getElementById('sn-auth-gate');
    const input = document.getElementById('sn-token-input');
    const btn = document.getElementById('sn-token-submit');
    const err = document.getElementById('sn-token-error');
    async function tryToken() {
      const t = input.value.trim();
      if (!t) return;
      try {
        const r = await fetch('/api/auth-check', { headers: { 'x-admin-token': t } });
        const d = await r.json();
        if (d.ok) { window.__SN_ADMIN_TOKEN = t; gate.remove(); }
        else { err.style.display = ''; input.select(); }
      } catch(e) { err.style.display = ''; }
    }
    btn.onclick = tryToken;
    input.onkeydown = e => { if (e.key === 'Enter') tryToken(); };
    input.focus();
  })();
  </script>
  ```

---

## PHASE 3: UX/UI VISUAL REDESIGN

### Fix 3.1 — Unified CSS Token Layer

Replace the current `:root { }` block in `style.css` with the following. Keep all existing selectors below it — do NOT delete them. Add the Inter Google Fonts import at the very top of style.css:

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');

:root {
  /* Color */
  --color-primary: #0F766E;
  --color-secondary: #14B8A6;
  --color-accent: #0369A1;
  --color-bg: #0F172A;
  --color-surface: #192134;
  --color-surface-2: #1E2A3F;
  --color-border: rgba(255, 255, 255, 0.08);
  --color-text: #FFFFFF;
  --color-text-muted: #94A3B8;
  --color-destructive: #DC2626;
  --glass-surface: rgba(25, 33, 52, 0.85);
  --glass-surface-light: rgba(30, 42, 63, 0.72);
  --glass-blur: blur(12px) saturate(140%);

  /* Spacing */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;  --space-4: 16px;
  --space-5: 24px; --space-6: 32px; --space-7: 48px;

  /* Typography */
  --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
  --text-xs: 0.75rem; --text-sm: 0.875rem; --text-base: 1rem;
  --text-lg: 1.125rem; --text-xl: 1.375rem;
  --leading: 1.5;
  --weight-light: 300; --weight-regular: 400; --weight-medium: 500; --weight-semibold: 600;

  /* Elevation */
  --shadow-1: 0 1px 2px rgba(0,0,0,0.3);
  --shadow-2: 0 4px 12px rgba(0,0,0,0.35);
  --shadow-3: 0 8px 24px rgba(0,0,0,0.40);
  --shadow-4: 0 16px 48px rgba(0,0,0,0.50);
  --glow-primary: 0 0 0 1px rgba(20,184,166,0.4), 0 0 16px rgba(20,184,166,0.25);

  /* Radii */
  --radius-sm: 6px; --radius-md: 10px; --radius-lg: 16px; --radius-pill: 999px;

  /* Motion */
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --dur-fast: 150ms; --dur-base: 200ms; --dur-slow: 300ms;

  /* Z-index */
  --z-canvas: 0; --z-pins: 10; --z-controls: 20; --z-header: 30;
  --z-panel: 40; --z-scrim: 50; --z-sheet: 60; --z-dropdown: 70; --z-toast: 80;

  /* Safe areas */
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --safe-top: env(safe-area-inset-top, 0px);

  /* Legacy aliases (keeps existing code working) */
  --primary: var(--color-primary);
  --secondary: var(--color-secondary);
  --surface: var(--color-surface);
  --bg: var(--color-bg);
}

body {
  margin: 0;
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: var(--leading);
  color: var(--color-text);
  background: var(--color-bg);
  -webkit-font-smoothing: antialiased;
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
```

IMPORTANT: Keep all existing CSS rules after this block. Only replace/add the `:root{}` and `body{}` blocks.

### Fix 3.2 — Pin Label Component (viewer3d.html + viewer3d.js)

In `viewer3d.html`, add this CSS to the inline `<style>` block (or append to style.css):

```css
.pin-label {
  --pin-dist: 0;
  position: absolute;
  z-index: var(--z-pins);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 220px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-secondary);
  border-radius: var(--radius-md);
  background: var(--glass-surface-light);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: var(--shadow-2);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  white-space: nowrap;
  cursor: pointer;
  opacity: calc(1 - var(--pin-dist) * 0.65);
  transform: translate(-50%, -100%) translateY(-8px);
  transition: opacity var(--dur-base) var(--ease-out), box-shadow var(--dur-base) var(--ease-out);
  pointer-events: auto;
  user-select: none;
}
.pin-label .pin-desc { display: none; font-size: var(--text-xs); color: var(--color-text-muted); white-space: normal; margin-top: var(--space-1); }
.pin-label:hover, .pin-label:focus-visible { opacity: 1; flex-direction: column; align-items: flex-start; white-space: normal; box-shadow: var(--shadow-3); z-index: calc(var(--z-pins) + 1); outline: none; }
.pin-label:hover .pin-desc, .pin-label:focus-visible .pin-desc { display: block; }
.pin-label.occluded { opacity: 0.2; pointer-events: none; box-shadow: none; }
.pin-label.selected { opacity: 1; border-left-color: var(--color-secondary); background: var(--glass-surface); box-shadow: var(--glow-primary), var(--shadow-3); }
@media (max-width: 767px) {
  .pin-label { min-height: 44px; padding: var(--space-3) var(--space-4); }
}
```

In `viewer3d.js`, in the function that creates CSS2D label elements (around `_makeLabelCSS2D` or `renderPins`), update label elements to use `.pin-label` class and include the `pin-desc` span. Also in the render loop (throttled), add distance-based fade:
```js
// In the per-frame update loop, for each label:
const dist = camera.position.distanceTo(pinWorldPos) / 100; // normalize to 0-1
labelEl.style.setProperty('--pin-dist', Math.min(dist, 1).toFixed(2));
```

### Fix 3.3 — Camera Preset Buttons (viewer3d.html)

Find the `.cam-preset-btn` CSS in `viewer3d.html`'s inline style. Replace or supplement with:

```css
.camera-presets {
  position: fixed;
  right: var(--space-4);
  bottom: calc(var(--space-4) + var(--safe-bottom));
  z-index: var(--z-controls);
  display: flex;
  gap: var(--space-1);
  padding: var(--space-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--glass-surface);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: var(--shadow-2);
}
.cam-preset-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  cursor: pointer;
  transition: background var(--dur-base) var(--ease-out), color var(--dur-base) var(--ease-out), box-shadow var(--dur-base) var(--ease-out);
}
.cam-preset-btn:hover { background: var(--color-surface-2); color: var(--color-text); }
.cam-preset-btn.active { background: var(--color-primary); color: var(--color-text); box-shadow: var(--glow-primary); }
.cam-preset-btn:focus-visible { outline: 2px solid var(--color-secondary); outline-offset: 1px; }
@media (max-width: 767px) {
  .cam-preset-btn { padding: var(--space-3); }
  .cam-preset-btn .preset-label { display: none; }
}
```

If the camera preset buttons container already has a different class/id, wrap them in a `<nav class="camera-presets">` container in the HTML.

### Fix 3.4 — Mobile Bottom Sheet (viewer3d.html)

Find `#side-panel` or the bottom sheet CSS in the inline styles. Add/replace:

```css
.bottom-sheet-scrim {
  position: fixed; inset: 0; z-index: var(--z-scrim);
  background: rgba(15,23,42,0.55); opacity: 0; pointer-events: none;
  transition: opacity var(--dur-slow) var(--ease-out);
}
.bottom-sheet-scrim.visible { opacity: 1; pointer-events: auto; }

#side-panel, .bottom-sheet {
  position: fixed; left: 0; right: 0; bottom: 0;
  z-index: var(--z-sheet);
  display: flex; flex-direction: column;
  height: calc(56px + var(--safe-bottom));
  border: 1px solid var(--color-border);
  border-bottom: none;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  background: var(--glass-surface);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: var(--shadow-4);
  padding-bottom: var(--safe-bottom);
  transition: height var(--dur-slow) var(--ease-spring);
  will-change: height;
}
.bottom-sheet-handle {
  flex-shrink: 0; display: flex; align-items: center; justify-content: center; height: 28px; cursor: grab;
}
.bottom-sheet-handle::before {
  content: ''; width: 36px; height: 4px; border-radius: var(--radius-pill);
  background: var(--color-text-muted); opacity: 0.5;
}
#side-panel.sheet-mid, .bottom-sheet.half  { height: 40vh; }
#side-panel.sheet-full, .bottom-sheet.full { height: 90vh; }
```

Add a `.bottom-sheet-handle` div as the first child of `#side-panel` in the HTML if it doesn't exist.

### Fix 3.5 — Gallery Cards + Timeline Scrubber (gallery.html)

In `gallery.html`'s inline styles, add/replace the card and scrubber CSS:

```css
.gallery-card {
  position: relative; overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--glass-surface-light);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: var(--shadow-2); cursor: pointer;
  transition: transform var(--dur-base) var(--ease-out), box-shadow var(--dur-base) var(--ease-out), border-color var(--dur-base) var(--ease-out);
}
.gallery-card .date-badge {
  position: absolute; top: var(--space-2); right: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm); background: var(--glass-surface);
  backdrop-filter: var(--glass-blur);
  font-size: var(--text-xs); font-weight: var(--weight-semibold); color: var(--color-text);
}
.gallery-card:hover { transform: translateY(-4px); box-shadow: var(--shadow-3); border-color: rgba(20,184,166,0.35); }
.gallery-card.active { border-color: var(--color-secondary); box-shadow: var(--glow-primary), var(--shadow-3); }

.timeline-scrubber {
  position: relative; height: 48px; margin: var(--space-4) var(--space-5);
  touch-action: none; user-select: none;
}
.timeline-track {
  position: absolute; top: 50%; left: 0; right: 0; height: 4px;
  transform: translateY(-50%); border-radius: var(--radius-pill);
  background: var(--color-surface-2); box-shadow: inset 0 1px 2px rgba(0,0,0,0.5);
}
.timeline-track::before {
  content: ''; position: absolute; inset: 0 auto 0 0;
  width: calc(var(--progress, 0) * 1%); border-radius: inherit;
  background: var(--color-primary);
}
.timeline-tick {
  position: absolute; top: 50%; width: 10px; height: 10px;
  transform: translate(-50%, -50%); border-radius: 50%;
  border: 2px solid var(--color-text-muted); background: var(--color-bg);
  cursor: pointer;
  transition: border-color var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out);
}
.timeline-tick:hover { border-color: var(--color-secondary); }
.timeline-tick.active { border-color: var(--color-secondary); background: var(--color-secondary); transform: translate(-50%, -50%) scale(1.2); }
.timeline-tick .tick-date {
  position: absolute; top: calc(100% + var(--space-2)); left: 50%; transform: translateX(-50%);
  font-size: var(--text-xs); color: var(--color-text-muted); white-space: nowrap;
}
.timeline-tick.active .tick-date { color: var(--color-secondary); font-weight: var(--weight-semibold); }
.timeline-knob {
  position: absolute; top: 50%; width: 20px; height: 20px;
  transform: translate(-50%, -50%); border-radius: 50%;
  border: 3px solid var(--color-secondary); background: var(--color-surface);
  box-shadow: var(--shadow-2); cursor: grab;
  transition: box-shadow var(--dur-base) var(--ease-out);
}
.timeline-knob:active { cursor: grabbing; box-shadow: var(--glow-primary), var(--shadow-2); }
```

Also add the `.date-badge` span inside each gallery card in `gallery.js` where cards are rendered (check for a `renderCards` or similar function). If models have a `date`/`label` field, render it as `<span class="date-badge">${model.label || model.id}</span>`.

### Fix 3.6 — Viewer Header Bar (viewer3d.html)

Add a slim header bar at the top of the 3D viewer. In `viewer3d.html`, add this HTML near the top of the `<body>` (before the canvas wrapper), and add the CSS to the inline styles:

HTML to add:
```html
<header class="viewer-header" id="viewer-header">
  <div class="viewer-header-logo">SiteNav</div>
  <div class="viewer-header-site" id="header-site-name"></div>
  <div class="viewer-header-actions">
    <button class="viewer-header-btn" id="header-share-btn" aria-label="Share view" title="Share">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>
    </button>
  </div>
</header>
```

CSS to add:
```css
.viewer-header {
  position: fixed; top: 0; left: 0; right: 0;
  z-index: var(--z-header);
  display: flex; align-items: center;
  height: calc(48px + var(--safe-top));
  padding: var(--safe-top) var(--space-4) 0;
  border-bottom: 1px solid var(--color-border);
  background: linear-gradient(rgba(15,23,42,0.7), rgba(15,23,42,0.4));
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  pointer-events: none;
}
.viewer-header > * { pointer-events: auto; }
.viewer-header-logo { flex: 1; font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--color-text); }
.viewer-header-site { flex: 2; text-align: center; font-size: var(--text-sm); color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.viewer-header-actions { flex: 1; display: flex; justify-content: flex-end; gap: var(--space-2); }
.viewer-header-btn {
  display: grid; place-items: center; width: 36px; height: 36px;
  border: none; border-radius: var(--radius-sm);
  background: transparent; color: var(--color-text-muted); cursor: pointer;
  transition: background var(--dur-base) var(--ease-out), color var(--dur-base) var(--ease-out);
}
.viewer-header-btn:hover { background: var(--color-surface-2); color: var(--color-text); }
@media (max-width: 767px) {
  .viewer-header { height: calc(40px + var(--safe-top)); }
  .viewer-header-site { display: none; }
}
```

In `viewer3d.js` boot(), after config is loaded, set the site name:
```js
const headerSiteName = document.getElementById('header-site-name');
if (headerSiteName && _cfg.site && _cfg.site.name) headerSiteName.textContent = _cfg.site.name;
```

For the share button, wire it to the existing share functionality (or use `navigator.share`):
```js
const headerShareBtn = document.getElementById('header-share-btn');
if (headerShareBtn) {
  headerShareBtn.addEventListener('click', () => {
    if (navigator.share) {
      navigator.share({ title: document.title, url: location.href });
    } else if (window._copyShareLink) {
      window._copyShareLink();
    }
  });
}
```

---

## IMPORTANT RULES FOR AGY

1. Do NOT remove existing functionality. Only add/modify as specified.
2. Do NOT change file structure, imports, or module system.
3. The CSS token layer uses `--legacy aliases` so existing code keeps working. Don't rename existing CSS variables — only add new ones.
4. For the auth gate (Fix 1.3), it must appear BEFORE the module scripts in admin3d.html — add it before the `<script type="module">` tags so it blocks execution.
5. The bottom sheet CSS uses `#side-panel` as the selector to match the existing ID — don't change the HTML ID.
6. Test the acceptance checks before declaring done.
7. Be precise — use the exact line references from the Goal section, not approximate guesses.
