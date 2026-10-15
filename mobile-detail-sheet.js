// Mobile visitor details: summary -> full -> dismissed. No data is written.
export function nextDetailState(current, event) {
  const state = current || { stage: 'idle', key: null };
  if (event.type === 'reset') return { stage: 'idle', key: null };
  if (event.type === 'dismiss') return { stage: 'closed', key: null };
  if (event.type === 'select') {
    const same = state.key === event.key && ['summary', 'full'].includes(state.stage);
    return { stage: same ? 'full' : 'summary', key: String(event.key) };
  }
  if (event.type === 'expand' && state.key) return { ...state, stage: 'full' };
  if (event.type === 'summary' && state.key) return { ...state, stage: 'summary' };
  return state;
}

// A drag, orbit, or two-finger gesture must not be mistaken for an empty-map tap.
export function trackMapTaps(canvas) {
  let gesture = null, last = null;
  const pointers = new Set();
  canvas.addEventListener('pointerdown', event => {
    pointers.add(event.pointerId);
    if (pointers.size === 1) gesture = { x:event.clientX, y:event.clientY, moved:false, multi:false };
    else if (gesture) gesture.multi = true;
    last = null;
  }, { passive:true });
  canvas.addEventListener('pointermove', event => {
    if (gesture && Math.hypot(event.clientX-gesture.x, event.clientY-gesture.y) > 8) gesture.moved = true;
  }, { passive:true });
  const finish = event => {
    if (!pointers.has(event.pointerId)) return;
    if (gesture && Math.hypot(event.clientX-gesture.x, event.clientY-gesture.y) > 8) gesture.moved = true;
    pointers.delete(event.pointerId);
    if (!pointers.size) {
      last = { valid:!!gesture && !gesture.moved && !gesture.multi && event.type !== 'pointercancel', at:Date.now() };
      gesture = null;
    }
  };
  window.addEventListener('pointerup', finish, { passive:true });
  window.addEventListener('pointercancel', finish, { passive:true });
  return event => event.detail === 0 || (!!last?.valid && Date.now()-last.at < 1000);
}

export function createMobileDetailSheet({ onDismiss = () => {}, enabled = () => true } = {}) {
  let state = { stage:'idle', key:null };
  let ui = null;
  let syncQueued = false;
  const compact = () => window.innerWidth <= 1024 && enabled();
  const el = id => document.getElementById(id);
  const usable = () => compact() && el('side-panel') && el('point-detail');

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function ensure() {
    if (ui) return ui;
    const panel = el('side-panel'), detail = el('point-detail'), app = el('app');
    if (!panel || !detail || !app) return null;
    const header = make('div','sn-detail-header');
    header.id = 'sn-detail-header';
    const expand = make('button','sn-detail-expand','View full details');
    expand.type = 'button'; expand.id = 'sn-detail-expand';
    expand.setAttribute('aria-controls','point-detail');
    expand.addEventListener('click', () => change({type:state.stage === 'full' ? 'summary' : 'expand'}));
    const close = make('button','sn-detail-close','×');
    close.type = 'button'; close.id = 'sn-detail-close';
    close.setAttribute('aria-label','Close location details');
    close.addEventListener('click', dismiss);
    header.append(expand, close);
    const summary = make('button','sn-detail-summary');
    summary.id = 'sn-detail-summary'; summary.type = 'button';
    summary.setAttribute('aria-controls','point-detail');
    summary.setAttribute('aria-expanded','false');
    const text = make('span','sn-summary-text');
    const kind = make('span','sn-summary-kind');
    const title = make('span','sn-summary-title');
    const description = make('span','sn-summary-description');
    text.append(kind,title,description);
    const picture = make('span','sn-summary-picture');
    const image = make('img','sn-summary-image');
    image.crossOrigin = 'anonymous'; image.referrerPolicy = 'no-referrer';
    image.decoding = 'async'; image.loading = 'eager';
    const photoCount = make('span','sn-summary-photo-count');
    picture.append(image,photoCount);
    const footer = make('span','sn-summary-footer','View full details →');
    summary.append(text,picture,footer);
    summary.addEventListener('click', () => change({type:'expand'}));
    image.addEventListener('error', () => { picture.hidden = true; summary.classList.remove('has-photo'); });
    panel.insertBefore(header,detail);
    panel.insertBefore(summary,detail);
    const browse = make('button','sn-details-browse','Locations');
    browse.id = 'sn-details-browse'; browse.type = 'button';
    browse.setAttribute('aria-label','Open locations');
    browse.addEventListener('click', browseLocations);
    app.appendChild(browse);
    ui = { panel, detail, app, header, expand, close, summary, title, kind, description,
      picture, image, photoCount, footer, browse };
    const observer = new MutationObserver(() => {
      if (syncQueued) return;
      syncQueued = true;
      queueMicrotask(() => { syncQueued = false; refresh(); });
    });
    observer.observe(detail,{subtree:true,childList:true,characterData:true,attributes:true,
      attributeFilter:['src','hidden']});
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => updateHeight()).observe(panel);
    }
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && compact() && ['summary','full'].includes(state.stage)) dismiss();
    });
    return ui;
  }

  function updateHeight() {
    if (!ui || !compact() || !['summary','full'].includes(state.stage)) return;
    ui.app.style.setProperty('--sn-active-detail-height', Math.round(ui.panel.getBoundingClientRect().height)+'px');
  }
  function refresh() {
    if (!ui || !state.key) return;
    const {detail,title,kind,description,picture,image,photoCount,summary,footer,expand} = ui;
    const titleText = el('detail-label')?.textContent?.trim() || 'Location';
    title.textContent = titleText;
    kind.textContent = el('detail-chip')?.textContent?.trim() || 'Location';
    description.textContent = el('detail-notes')?.textContent?.trim() || 'Tap to view location details.';
    summary.setAttribute('aria-label','View full details for '+titleText);
    const candidates = [...detail.querySelectorAll('#detail-scene-photo[src], #detail-photo[src], #detail-photos img[src]')]
      .filter(img => !img.closest('[hidden]') && img.parentElement?.style.display !== 'none');
    const source = candidates[0];
    const count = detail.querySelectorAll('.scene-gallery-thumb').length || candidates.length;
    picture.hidden = !source;
    summary.classList.toggle('has-photo', !!source);
    if (source) {
      // Use only the image already authorized and rendered by the detail card.
      const url = source.getAttribute('src');
      if (image.getAttribute('src') !== url) image.src = url;
      image.alt = source.alt || titleText;
      photoCount.textContent = count+' photo'+(count === 1 ? '' : 's');
    } else image.removeAttribute('src');
    footer.textContent = 'View full details' + (count ? ' · '+count+' photo'+(count===1?'':'s') : '') + ' →';
    expand.textContent = state.stage === 'full' ? '⌄  Summary' : '⌃  Full details';
    expand.setAttribute('aria-expanded',String(state.stage==='full'));
    expand.setAttribute('aria-label',state.stage==='full'?'Collapse to summary':'Expand full location details');
    requestAnimationFrame(updateHeight);
  }

  function apply() {
    const parts = ensure();
    if (!parts) return;
    const {app,panel,detail} = parts;
    const selected = compact() && ['summary','full'].includes(state.stage);
    app.classList.toggle('sn-details-active',selected);
    app.classList.toggle('sn-details-full',selected && state.stage==='full');
    app.classList.toggle('sn-details-dismissed',compact() && state.stage==='closed');
    if (selected) {
      panel.dataset.detailStage = state.stage;
      panel.classList.remove('panel-folded');
      panel.classList.toggle('sheet-mid',state.stage==='summary');
      panel.classList.toggle('sheet-full',state.stage==='full');
      panel.classList.add('detail-open');
      detail.classList.add('visible');
      detail.style.removeProperty('height');
      app.classList.add('sheet-open');
      window._updateCamPresetsBottom?.();
    } else {
      delete panel.dataset.detailStage;
      if (!compact() && state.key) app.classList.add('panel-open');
    }
    refresh();
  }
  function change(event) {
    const previous = state;
    state = nextDetailState(state,event);
    apply();
    if (ui && state.stage === 'full' && previous.stage !== 'full') ui.detail.scrollTop = 0;
  }
  function open(key) {
    if (!usable()) return false;
    // New selections always start in summary even after an expanded card.
    state = {stage:'summary',key:String(key)};
    if (el('detail-notes')?.querySelector('form,textarea,input,select')) state.stage='full';
    apply();
    if (ui) ui.detail.scrollTop = 0;
    return true;
  }
  function repeat(key) {
    if (!usable() || state.key !== String(key) || !['summary','full'].includes(state.stage)) return false;
    change({type:'expand'});
    return true;
  }
  function browseLocations() {
    const parts = ensure();
    if (!parts) return false;
    reset();
    parts.panel.classList.remove('panel-folded','sheet-full');
    parts.panel.classList.add('sheet-mid');
    window.SiteNavPanelState?.openDetail?.();
    window._updateCamPresetsBottom?.();
    return true;
  }
  function reset() {
    state = {stage:'idle',key:null};
    if (!ui) return;
    delete ui.panel.dataset.detailStage;
    ui.app.classList.remove('sn-details-active','sn-details-full','sn-details-dismissed');
    ui.image.removeAttribute('src');
    ui.detail.scrollTop = 0;
  }
  function dismiss() {
    if (!usable() || !['summary','full'].includes(state.stage)) return false;
    // Existing code cancels detail-photo requests and clears pin highlights.
    onDismiss();
    state = {stage:'closed',key:null};
    apply();
    return true;
  }
  window.addEventListener('resize', () => { if (ui) apply(); });
  return Object.freeze({open,repeat,reset,dismiss,browseLocations,refresh,snapshot:()=>({...state}),isCompact:compact});
}
