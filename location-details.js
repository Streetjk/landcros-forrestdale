// location-details.js - Metadata validator and safe DOM renderer for building details

const RASTER_EXT_RE = /\.(jpe?g|png|webp|avif|gif)$/i;

/**
 * Sanitizes a telephone string into a safe tel: URL and display value.
 * Rejects control characters, HTML tags, protocol injections, or non-phone input.
 * @param {unknown} phone
 * @returns {{ display: string, href: string } | null}
 */
export function sanitizePhone(phone) {
  if (typeof phone !== 'string' || /[\x00-\x1F\x7F]/.test(phone)) return null;
  const trimmed = phone.trim();
  if (!trimmed) return null;
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return null;
  if (/[<>:;]/.test(trimmed)) return null;
  if (!/^\+?[\d\s().-]{3,30}$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 3 || digits.length > 18) return null;
  const telDigits = (trimmed.startsWith('+') ? '+' : '') + digits;
  return {
    display: trimmed,
    href: `tel:${telDigits}`,
  };
}

/**
 * Validates that an image URL is an allowed HTTPS raster image
 * or safe same-origin relative raster image path. Rejects javascript:, data:,
 * blob:, protocol-relative, and control-character URLs.
 * @param {unknown} url
 * @returns {string | null}
 */
export function sanitizeImageUrl(url) {
  if (typeof url !== 'string' || /[\x00-\x1F\x7F\\]/.test(url)) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (/[\x00-\x1F\x7F\s]/.test(trimmed)) return null;
  if (trimmed.startsWith('//')) return null;
  if (/^(javascript|data|blob|file|ftp):/i.test(trimmed)) return null;

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/i.test(trimmed)) {
    if (!/^https:/i.test(trimmed)) return null;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
      if (!RASTER_EXT_RE.test(parsed.pathname)) return null;
      return parsed.href;
    } catch {
      return null;
    }
  }

  const pathname = trimmed.split(/[?#]/)[0];
  if (!RASTER_EXT_RE.test(pathname)) return null;
  return trimmed;
}

/**
 * Validates building properties.details contract.
 * Contract: { description, phone, image, imageAlt }, all optional.
 * @param {unknown} details
 * @returns {{ description: string | null, phone: { display: string, href: string } | null, image: string | null, imageAlt: string | null }}
 */
export function validateBuildingDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return {
      description: null,
      phone: null,
      image: null,
      imageAlt: null,
    };
  }

  const description = typeof details.description === 'string' && details.description.trim()
    ? details.description.trim()
    : null;
  const phone = sanitizePhone(details.phone);
  const image = sanitizeImageUrl(details.image);
  const imageAlt = image && typeof details.imageAlt === 'string' && details.imageAlt.trim()
    ? details.imageAlt.trim()
    : (image ? 'Building photo' : null);

  return {
    description,
    phone,
    image,
    imageAlt,
  };
}

/**
 * Renders validated building details safely into the existing detail panel DOM.
 * Reuses #detail-chip, #detail-label, #detail-notes, #detail-photos, and #detail-contacts.
 * Does not leak private contacts directory.
 * @param {object} building - GeoJSON feature or properties object
 * @param {Function} openDetailPanel - Chrome panel opening callback (_openDetailPanel)
 */
export function showBuildingDetail(building, openDetailPanel) {
  if (typeof document === 'undefined') return;
  const detailPanel = document.getElementById('point-detail');
  if (!detailPanel) return;
  detailPanel.classList.add('public-location-detail');

  const p = building?.properties || building || {};
  const details = validateBuildingDetails(p.details);
  const title = p.name || p.labelText || 'Building';

  const chip = document.getElementById('detail-chip');
  if (chip) {
    chip.className = 'chip';
    chip.textContent = 'Building';
  }

  const label = document.getElementById('detail-label');
  if (label) {
    label.textContent = title;
  }

  const notes = document.getElementById('detail-notes');
  if (notes) {
    notes.textContent = details.description || '';
  }

  const navSection = document.getElementById('detail-nav-section');
  if (navSection) navSection.style.display = 'none';

  let photoGrid = document.getElementById('detail-photos');
  if (!photoGrid && notes && details.image) {
    photoGrid = document.createElement('div');
    photoGrid.id = 'detail-photos';
    photoGrid.style.cssText = 'display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-top:10px;';
    notes.insertAdjacentElement('afterend', photoGrid);
  }

  if (photoGrid) {
    photoGrid.replaceChildren();
    if (details.image) {
      photoGrid.style.display = 'block';
      const img = document.createElement('img');
      img.src = details.image;
      img.alt = details.imageAlt || 'Building photo';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.style.cssText = 'width:100%;max-height:200px;object-fit:cover;border-radius:6px;display:block;';
      img.onerror = () => {
        img.remove();
        if (photoGrid.children.length === 0) photoGrid.style.display = 'none';
      };
      photoGrid.appendChild(img);
    } else {
      photoGrid.style.display = 'none';
    }
  }

  const contactsEl = document.getElementById('detail-contacts');
  const contactsSection = contactsEl?.closest('.detail-section');
  if (contactsEl) {
    contactsEl.replaceChildren();
    if (details.phone) {
      const a = document.createElement('a');
      a.href = details.phone.href;
      a.textContent = details.phone.display;
      a.className = 'contact-phone-3d';
      a.setAttribute('aria-label', `Call main contact ${details.phone.display}`);
      a.style.cssText = 'min-height:44px;display:inline-flex;align-items:center;';
      contactsEl.appendChild(a);
      if (contactsSection) contactsSection.style.display = '';
    } else {
      if (contactsSection) contactsSection.style.display = 'none';
    }
  }

  if (typeof openDetailPanel === 'function') {
    openDetailPanel();
  }
}
