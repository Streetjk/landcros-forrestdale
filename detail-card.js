// Shared SiteNav read-only detail-card DOM primitives.
// Callers supply already-projected/sanitized data. Dynamic values are written
// with textContent/attributes only and are never interpreted as HTML.

function asText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function initials(name) {
  return asText(name, 'Contact')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part[0] || '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'C';
}

function createPhoneIcon(doc) {
  if (typeof doc.createElementNS !== 'function') return null;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = doc.createElementNS(ns, 'path');
  path.setAttribute('d', 'M5.5 2.5c.5 1 1 2.5.5 3.5L4.5 7c1 2 2.5 3.5 4.5 4.5l1-1.5c1-.5 2.5 0 3.5.5v2.5C13.5 13.5 12 14 11 14 6 14 2 10 2 5c0-1 .5-2.5 1.5-2.5h2z');
  svg.appendChild(path);
  return svg;
}

export function createDetailPhoneLink(doc, phone, options = {}) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('createDetailPhoneLink requires a document-like object');
  }
  if (!phone || typeof phone !== 'object' || typeof phone.href !== 'string' || typeof phone.display !== 'string') {
    return null;
  }
  if (!/^tel:\+?\d{3,18}$/.test(phone.href)) return null;

  const link = doc.createElement('a');
  link.className = 'contact-phone-3d';
  link.href = phone.href;
  if (options.ariaLabel) link.setAttribute('aria-label', asText(options.ariaLabel));
  if (options.touchTarget) {
    link.style.minHeight = '44px';
    link.style.display = 'inline-flex';
    link.style.alignItems = 'center';
  }

  if (options.icon !== false) {
    const icon = createPhoneIcon(doc);
    if (icon) link.appendChild(icon);
  }
  link.appendChild(doc.createTextNode(asText(phone.display)));
  return link;
}

export function createDetailContactCard(doc, contact = {}) {
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError('createDetailContactCard requires a document-like object');
  }

  const card = doc.createElement('div');
  card.className = 'contact-card-3d';

  const avatar = doc.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = initials(contact.name);
  avatar.setAttribute('aria-hidden', 'true');

  const info = doc.createElement('div');
  const name = doc.createElement('div');
  name.className = 'contact-name-3d';
  name.textContent = asText(contact.name, 'Contact');
  const role = doc.createElement('div');
  role.className = 'contact-role-3d';
  role.textContent = asText(contact.role);
  info.appendChild(name);
  info.appendChild(role);

  const phone = createDetailPhoneLink(doc, contact.phone);
  if (phone) info.appendChild(phone);

  card.appendChild(avatar);
  card.appendChild(info);
  return card;
}

export function renderDetailContacts(doc, container, options = {}) {
  if (!doc || typeof doc.createElement !== 'function' || !container || typeof container.replaceChildren !== 'function') {
    throw new TypeError('renderDetailContacts requires document-like and container elements');
  }

  const contacts = Array.isArray(options.contacts) ? options.contacts : [];
  container.replaceChildren();

  if (contacts.length) {
    for (const contact of contacts) container.appendChild(createDetailContactCard(doc, contact));
    return { kind: 'contacts', count: contacts.length };
  }

  const fallback = createDetailPhoneLink(doc, options.fallbackPhone, {
    ariaLabel: options.fallbackAriaLabel,
    touchTarget: Boolean(options.touchTarget),
  });
  if (fallback) {
    const card = doc.createElement('div');
    card.className = 'contact-card-3d';
    const info = doc.createElement('div');
    info.appendChild(fallback);
    card.appendChild(info);
    container.appendChild(card);
    return { kind: 'phone', count: 1 };
  }

  if (options.emptyText !== null) {
    const empty = doc.createElement('p');
    empty.className = 'detail-empty';
    empty.style.fontSize = '13px';
    empty.style.color = 'var(--text-secondary)';
    empty.textContent = asText(options.emptyText, 'No contacts assigned.');
    container.appendChild(empty);
  }
  return { kind: 'empty', count: 0 };
}
