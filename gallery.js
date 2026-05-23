/* SiteNav Gallery — model selection and comparison launcher */

const selected = new Map();   // id → order (1-based)
let models = [];
let maxCompare = 2;
let selectionOrder = 0;

const grid = document.getElementById('model-grid');
const actionBar = document.getElementById('action-bar');
const btnView = document.getElementById('btn-view');
const btnCompare = document.getElementById('btn-compare');
const btnClear = document.getElementById('btn-clear');
const selCount = document.getElementById('sel-count');
const selSummary = document.getElementById('sel-summary');
const toastEl = document.getElementById('toast');
const toolbarLabel = document.getElementById('toolbar-label');

/* ── SVG templates ──────────────────────────────── */
const SVG_CHECK = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3.5 8.5 6.5 11.5 12.5 5.5"/></svg>`;

const SVG_3D_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 2L2 7l10 5 10-5-10-5z"/>
  <path d="M2 17l10 5 10-5"/>
  <path d="M2 12l10 5 10-5"/>
</svg>`;

/* ── Boot ───────────────────────────────────────── */
async function boot() {
  showSkeletons(3);

  let cfg;
  try {
    const resp = await fetch('./data/config.json');
    cfg = await resp.json();
  } catch {
    cfg = {};
  }

  // Header
  document.getElementById('site-title').textContent = cfg.site?.name || 'SiteNav';
  document.getElementById('site-address').textContent = cfg.site?.address || '';
  const logo = document.getElementById('logo');
  if (cfg.site?.logo) {
    logo.src = cfg.site.logo;
  } else {
    logo.style.display = 'none';
  }

  models = cfg.models || [];
  maxCompare = cfg.comparison?.maxModels ?? 2;

  // Update toolbar label with count
  toolbarLabel.textContent = models.length === 1
    ? '1 model'
    : `${models.length} models`;

  // Clear skeletons
  grid.innerHTML = '';

  // Empty state
  if (!models.length) {
    showEmptyState();
    return;
  }

  // Single-model shortcut: hide comparison flow, go straight to viewer
  if (models.length === 1) {
    document.getElementById('intro').querySelector('.guide').style.display = 'none';
    document.getElementById('intro').querySelector('p').textContent =
      'Click the model below to launch the 3D viewer.';
  }

  // Render cards
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const card = createCard(m, i);
    grid.appendChild(card);
  }

  // Auto-select comparison defaults
  const defaultIds = cfg.comparison?.defaultModelIds || [];
  if (defaultIds.length >= 2 && cfg.scene?.type === 'comparison-only') {
    for (const id of defaultIds) toggle(id);
  }

  // Event listeners
  btnView.addEventListener('click', openView);
  btnCompare.addEventListener('click', openCompare);
  btnClear.addEventListener('click', clearAll);
}

/* ── Card creation ──────────────────────────────── */
function createCard(m, index) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.id = m.id;
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `Select ${m.label}`);
  card.style.animationDelay = `${index * 60}ms`;

  // Thumbnail wrapper
  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'thumb-wrap';

  if (m.thumbnail) {
    // Show skeleton while loading
    const skeleton = document.createElement('div');
    skeleton.className = 'thumb-skeleton';
    thumbWrap.appendChild(skeleton);

    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = m.label;
    img.loading = 'lazy';
    img.src = m.thumbnail;
    img.style.position = 'absolute';
    img.style.inset = '0';
    img.style.opacity = '0';
    img.style.transition = 'opacity 0.3s ease';
    thumbWrap.style.position = 'relative';
    img.onload = () => {
      img.style.opacity = '1';
      skeleton.remove();
      img.style.position = '';
      img.style.inset = '';
    };
    img.onerror = () => {
      skeleton.remove();
      thumbWrap.innerHTML = '';
      thumbWrap.appendChild(createFallbackThumb(m.label));
    };
    thumbWrap.appendChild(img);
  } else {
    thumbWrap.appendChild(createFallbackThumb(m.label));
  }

  // Overlay for selected state
  const overlay = document.createElement('div');
  overlay.className = 'thumb-overlay';
  thumbWrap.appendChild(overlay);

  card.appendChild(thumbWrap);

  // Info area
  const info = document.createElement('div');
  info.className = 'info';

  const infoTop = document.createElement('div');
  infoTop.className = 'info-top';

  const title = document.createElement('h3');
  title.textContent = m.label;
  infoTop.appendChild(title);

  // Tag (first tag from array)
  if (m.tags && m.tags.length) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = m.tags[0];
    infoTop.appendChild(tag);
  }

  info.appendChild(infoTop);

  if (m.description) {
    const desc = document.createElement('p');
    desc.className = 'desc';
    desc.textContent = m.description;
    info.appendChild(desc);
  }

  // Meta row
  const meta = document.createElement('div');
  meta.className = 'meta';
  if (m.splat) {
    const ext = m.splat.split('.').pop().toUpperCase();
    const metaItem = document.createElement('span');
    metaItem.className = 'meta-item';
    metaItem.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><polyline points="10 2 10 5 13 5"/></svg>`;
    metaItem.appendChild(document.createTextNode(` .${ext.toLowerCase()}`));
    meta.appendChild(metaItem);
  }
  if (meta.children.length) info.appendChild(meta);

  card.appendChild(info);

  // Check indicator
  const check = document.createElement('div');
  check.className = 'check';
  check.innerHTML = SVG_CHECK;
  card.appendChild(check);

  // Selection order badge
  const selOrder = document.createElement('div');
  selOrder.className = 'sel-order';
  card.appendChild(selOrder);

  // Quick action hint
  const quickAction = document.createElement('div');
  quickAction.className = 'quick-action';
  quickAction.textContent = 'Double-click to view';
  card.appendChild(quickAction);

  // Click to toggle
  card.addEventListener('click', () => toggle(m.id));

  // Double-click to open directly
  card.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (!selected.has(m.id)) {
      clearAll();
      toggle(m.id);
    }
    openView();
  });

  // Keyboard support
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(m.id);
    }
  });

  return card;
}

function createFallbackThumb(label) {
  const fb = document.createElement('div');
  fb.className = 'thumb-fallback';

  const icon = document.createElement('div');
  icon.className = 'icon-3d';
  icon.innerHTML = SVG_3D_ICON;
  fb.appendChild(icon);

  const lbl = document.createElement('span');
  lbl.className = 'fallback-label';
  lbl.textContent = label || '3D Model';
  fb.appendChild(lbl);

  return fb;
}

/* ── Skeleton loading ───────────────────────────── */
function showSkeletons(count) {
  grid.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const skel = document.createElement('div');
    skel.className = 'skeleton-card';
    skel.innerHTML = `
      <div class="skel-thumb"></div>
      <div class="skel-body">
        <div class="skel-line"></div>
        <div class="skel-line"></div>
      </div>`;
    grid.appendChild(skel);
  }
}

/* ── Empty state ────────────────────────────────── */
function showEmptyState() {
  grid.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.innerHTML = `
    <div class="empty-icon">
      ${SVG_3D_ICON}
    </div>
    <h3>No models yet</h3>
    <p>Add drone scan models to <code>config.json</code> to see them here. Each model needs an ID, label, and a <code>.splat</code> or <code>.ply</code> file path.</p>
  `;
  // Replace the grid with the empty state
  grid.style.display = 'none';
  grid.parentElement.insertBefore(empty, grid.nextSibling);

  // Also hide intro guide since there's nothing to do
  const guide = document.querySelector('.intro .guide');
  if (guide) guide.style.display = 'none';
}

/* ── Selection logic ────────────────────────────── */
function toggle(id) {
  if (selected.has(id)) {
    selected.delete(id);
    document.querySelector(`.card[data-id="${id}"]`)?.classList.remove('selected');
    reorderBadges();
  } else {
    if (selected.size >= maxCompare) {
      // Bump oldest: remove first entry
      const firstId = selected.keys().next().value;
      selected.delete(firstId);
      const oldCard = document.querySelector(`.card[data-id="${firstId}"]`);
      if (oldCard) {
        oldCard.classList.remove('selected');
        // Bump animation
        oldCard.style.animation = 'none';
        oldCard.offsetHeight; // reflow
        oldCard.style.animation = '';
      }
      showToast(`Replaced "${getModelLabel(firstId)}" selection`);
    }
    selectionOrder++;
    selected.set(id, selectionOrder);
    document.querySelector(`.card[data-id="${id}"]`)?.classList.add('selected');
    reorderBadges();
  }
  updateUI();
}

function reorderBadges() {
  let order = 1;
  for (const [id] of selected) {
    const card = document.querySelector(`.card[data-id="${id}"]`);
    if (card) {
      const badge = card.querySelector('.sel-order');
      badge.textContent = order;
    }
    order++;
  }
}

function getModelLabel(id) {
  return models.find(m => m.id === id)?.label || id;
}

function clearAll() {
  for (const [id] of selected) {
    document.querySelector(`.card[data-id="${id}"]`)?.classList.remove('selected');
  }
  selected.clear();
  selectionOrder = 0;
  updateUI();
}

/* ── UI update ──────────────────────────────────── */
function updateUI() {
  const n = selected.size;

  // Action bar visibility
  actionBar.classList.toggle('visible', n > 0);

  // Buttons
  btnView.style.display = n === 1 ? '' : 'none';
  btnCompare.style.display = n >= 2 ? '' : 'none';
  btnCompare.disabled = n < 2;

  // Clear button
  btnClear.classList.toggle('visible', n > 0);

  // Selection count in toolbar
  if (n === 0) {
    selCount.textContent = '';
  } else if (n === 1) {
    selCount.textContent = '1 selected';
  } else {
    selCount.textContent = `${n} selected`;
  }

  // Action bar summary
  if (n === 1) {
    const label = getModelLabel(selected.keys().next().value);
    selSummary.innerHTML = `<strong>${esc(label)}</strong> selected`;
  } else if (n === 2) {
    const ids = [...selected.keys()];
    selSummary.innerHTML = `<strong>${esc(getModelLabel(ids[0]))}</strong> vs <strong>${esc(getModelLabel(ids[1]))}</strong>`;
  } else {
    selSummary.textContent = '';
  }
}

/* ── Navigation ─────────────────────────────────── */
function openView() {
  const id = selected.keys().next().value;
  if (!id) return;
  location.href = `viewer3d.html?model=${encodeURIComponent(id)}`;
}

function openCompare() {
  const ids = [...selected.keys()].map(id => encodeURIComponent(id)).join(',');
  location.href = `viewer3d.html?models=${ids}&compare=true`;
}

/* ── Toast ──────────────────────────────────────── */
let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
  }, 2000);
}

/* ── Utilities ──────────────────────────────────── */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ── Init ───────────────────────────────────────── */
boot();
