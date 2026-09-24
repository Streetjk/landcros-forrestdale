// Shared SiteNav point-list card primitive for public and staff panels.

function asText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

/**
 * Builds one keyboard-accessible location row without interpreting user text as HTML.
 * The caller owns grouping, data selection and activation behavior.
 */
export function createPointListItem(doc, options = {}) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('createPointListItem requires a document-like object');
  }

  const label = asText(options.label, 'Location');
  const el = doc.createElement('button');
  el.type = 'button';
  el.className = `point-item${options.selected ? ' selected' : ''}`;
  // Accessibility contract shared by public/staff list cards, independent of page CSS.
  el.style.minHeight = '44px';
  el.dataset.ptId = asText(options.id);
  if (options.pinSource) el.dataset.pinSource = asText(options.pinSource);
  el.setAttribute('aria-label', label);
  if (options.selected) el.setAttribute('aria-current', 'true');

  const dot = doc.createElement('div');
  dot.className = 'pt-dot';
  dot.style.background = asText(options.dotColor, 'var(--text-tertiary)');

  const copy = doc.createElement('div');
  copy.style.flex = '1';
  copy.style.minWidth = '0';

  const labelEl = doc.createElement('div');
  labelEl.className = 'pt-label';
  labelEl.textContent = label;
  copy.appendChild(labelEl);

  if (options.subtitle !== null && options.subtitle !== undefined && asText(options.subtitle).trim()) {
    const subtitle = doc.createElement('div');
    subtitle.className = 'pt-sub';
    subtitle.textContent = asText(options.subtitle);
    copy.appendChild(subtitle);
  }

  el.appendChild(dot);
  el.appendChild(copy);

  if (options.trailing) {
    const arrow = doc.createElement('span');
    arrow.className = 'pt-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '›';
    el.appendChild(arrow);
  }

  if (typeof options.onActivate === 'function') {
    el.addEventListener('click', options.onActivate);
  }
  return el;
}
