// Forrestdale site-entry requirements, transcribed from the approved matrix.
// Only these building IDs receive a PPE panel. Unlisted locations remain blank.
const FULL_PPE = Object.freeze(['boots', 'glasses', 'hiVis', 'longClothing']);
const PARTS_PPE = Object.freeze(['boots', 'hiVis']);

export const REQUIRED_PPE_BY_BUILDING_ID = Object.freeze({
  'bld-mining': FULL_PPE,
  'bld-module': FULL_PPE, // Module & Workshop
  'bld-reman': FULL_PPE,
  'bld-parts-receival': PARTS_PPE,
  'bld-parts-despatch': PARTS_PPE,
});

const PPE_ITEMS = Object.freeze({
  boots: { label: 'Safety boots', filename: 'safety-boots.svg' },
  glasses: { label: 'Safety glasses', filename: 'safety-glasses.svg' },
  hiVis: { label: 'Hi-vis clothing', filename: 'hi-vis.svg' },
  longClothing: { label: 'Long clothing', filename: 'long-clothing.svg' },
});

const ICON_BASE = './assets/ppe/';
let detailObserver = null;

export function requiredPpeForBuilding(buildingId, siteSlug) {
  if (siteSlug !== 'landcros' || typeof buildingId !== 'string') return null;
  return REQUIRED_PPE_BY_BUILDING_ID[buildingId] || null;
}

function createIcon(documentRef, filename) {
  const image = documentRef.createElement('img');
  image.src = ICON_BASE + filename;
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  image.width = 40;
  image.height = 40;
  image.decoding = 'async';
  return image;
}

function createPpeSection(documentRef, detailPanel) {
  const section = documentRef.createElement('section');
  section.id = 'detail-ppe';
  section.className = 'detail-section ppe-detail-section';
  section.setAttribute('aria-labelledby', 'detail-ppe-heading');
  section.hidden = true;

  const heading = documentRef.createElement('h3');
  heading.id = 'detail-ppe-heading';
  heading.className = 'ppe-section-title';
  heading.textContent = 'PPE REQUIREMENTS';

  const list = documentRef.createElement('ul');
  list.className = 'ppe-icon-grid';
  list.setAttribute('role', 'list');

  const ruleGroup = documentRef.createElement('div');
  ruleGroup.className = 'ppe-rule-group';
  ruleGroup.setAttribute('role', 'group');
  ruleGroup.setAttribute('aria-labelledby', 'ppe-rule-heading');
  const ruleHeading = documentRef.createElement('h4');
  ruleHeading.id = 'ppe-rule-heading';
  ruleHeading.className = 'ppe-rule-heading';
  ruleHeading.textContent = 'Site rule';
  const rule = documentRef.createElement('div');
  rule.className = 'ppe-site-rule';
  const ruleIcon = createIcon(documentRef, 'no-smoking.svg');
  const ruleText = documentRef.createElement('span');
  ruleText.textContent = 'No smoking';
  rule.append(ruleIcon, ruleText);
  ruleGroup.append(ruleHeading, rule);

  section.append(heading, list, ruleGroup);
  const hero = detailPanel.querySelector('.detail-hero');
  if (hero) hero.insertAdjacentElement('afterend', section);
  else detailPanel.appendChild(section);

  // Other shared detail types (scene pins, drop-off points, widgets) update the
  // same chip/panel. Clear stale PPE as soon as their heading or visibility changes.
  if (typeof MutationObserver !== 'undefined' && !detailObserver) {
    const chip = documentRef.getElementById('detail-chip');
    detailObserver = new MutationObserver(() => {
      const isBuilding = chip?.textContent?.trim().toLowerCase() === 'building';
      if (!detailPanel.classList.contains('visible') || !isBuilding) hideBuildingPpe(documentRef);
    });
    if (chip) detailObserver.observe(chip, { childList: true, characterData: true, subtree: true });
    detailObserver.observe(detailPanel, { attributes: true, attributeFilter: ['class'] });
  }
  return section;
}

export function hideBuildingPpe(documentRef = document) {
  const section = documentRef.getElementById('detail-ppe');
  if (!section) return;
  section.hidden = true;
  section.querySelector('.ppe-icon-grid')?.replaceChildren();
}

// Call from showBuildingDetail() after the building chip/name are assigned.
// No PPE is inferred for an unlisted ID or from a department-like display name.
export function renderBuildingPpe(properties, documentRef = document, siteSlug = '') {
  const items = requiredPpeForBuilding(properties?.id, siteSlug);
  if (!items) {
    hideBuildingPpe(documentRef);
    return false;
  }

  const detailPanel = documentRef.getElementById('point-detail');
  if (!detailPanel) return false;

  const section = documentRef.getElementById('detail-ppe') || createPpeSection(documentRef, detailPanel);
  const list = section.querySelector('.ppe-icon-grid');
  section.hidden = true;
  list.replaceChildren();

  for (const key of items) {
    const ppe = PPE_ITEMS[key];
    const cell = documentRef.createElement('li');
    cell.className = 'ppe-icon-cell';
    const label = documentRef.createElement('span');
    label.className = 'ppe-icon-label';
    label.textContent = ppe.label;
    cell.append(createIcon(documentRef, ppe.filename), label);
    list.appendChild(cell);
  }
  section.hidden = false;
  return true;
}
