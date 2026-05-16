// Docket form, preview, print, and audit log.

import { getChangelog } from './db.js';

function _docketNo() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = String(Math.floor(Math.random() * 9000) + 1000);
  return `DCK-${ymd}-${rand}`;
}

function _escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CHIP_BG    = { 'drop-off': '#e6f1fb', 'collection': '#d1fae5', 'both': '#fef3c7' };
const CHIP_COLOR = { 'drop-off': '#185FA5', 'collection': '#1D9E75', 'both': '#854F0B' };
const CHIP_LABEL = { 'drop-off': 'Drop-off', 'collection': 'Collection', 'both': 'Drop-off & Collection' };

/**
 * buildDocketHTML(point, contacts, formData, photos) → HTML string
 * formData: { po, supplier, rego, qty, notes }
 * photos: [{ dataUrl, name }, ...]
 */
export function buildDocketHTML(point, contacts, formData, photos = []) {
  const { po, supplier, rego, qty, notes } = formData;
  const dNo = _docketNo();
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  const chipBg = CHIP_BG[point.type] ?? '#f3f4f6';
  const chipCol = CHIP_COLOR[point.type] ?? '#374151';
  const chipLabel = CHIP_LABEL[point.type] ?? point.type;

  const photoImgs = photos.map(p =>
    `<img style="width:80px;height:80px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb;margin:3px" src="${p.dataUrl}" alt="photo">`
  ).join('');

  const contactCards = contacts.map(c => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:#f9fafb;border-radius:8px;margin-bottom:6px">
      <div style="width:34px;height:34px;border-radius:50%;background:#dbeafe;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#185FA5;flex-shrink:0">
        ${_escapeHTML(c.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase())}
      </div>
      <div>
        <div style="font-weight:600">${_escapeHTML(c.name)}</div>
        <div style="font-size:12px;color:#6b7280">${_escapeHTML(c.role)}</div>
        <div style="font-size:12px;color:#1D9E75;font-weight:500">${_escapeHTML(c.phone)}</div>
      </div>
    </div>
  `).join('');

  return `
<div style="font-family:system-ui,sans-serif;font-size:13px;color:#111827;max-width:520px;margin:0 auto">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;border-bottom:2px solid #185FA5;margin-bottom:14px">
    <div>
      <div style="font-size:18px;font-weight:700;color:#185FA5">SiteNav Docket</div>
      <div style="font-size:11px;color:#9ca3af;font-family:monospace;margin-top:2px">${dNo}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:12px;color:#6b7280">${dateStr}</div>
      <div style="font-size:12px;color:#6b7280">${timeStr}</div>
    </div>
  </div>

  <div style="margin-bottom:12px">
    <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;color:#9ca3af;margin-bottom:4px">Location</div>
    <div style="display:flex;align-items:center;gap:8px">
      <div style="font-size:15px;font-weight:600">${_escapeHTML(point.label)}</div>
      <span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;background:${chipBg};color:${chipCol};border:1px solid ${chipCol}40">${chipLabel}</span>
    </div>
    ${point.notes ? `<div style="font-size:12px;color:#6b7280;margin-top:4px">${_escapeHTML(point.notes)}</div>` : ''}
  </div>

  <hr style="border:none;border-top:1px solid #f3f4f6;margin:12px 0">

  <div style="margin-bottom:12px">
    <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;color:#9ca3af;margin-bottom:8px">Delivery details</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr><td style="padding:4px 0;color:#6b7280;width:130px;font-weight:500">PO / Reference</td>
          <td style="padding:4px 0;font-weight:700;color:${po ? '#111827' : '#d1d5db'}">${po ? _escapeHTML(po) : '—'}</td></tr>
      ${supplier ? `<tr><td style="padding:4px 0;color:#6b7280;font-weight:500">Supplier / Carrier</td><td style="padding:4px 0">${_escapeHTML(supplier)}</td></tr>` : ''}
      ${rego ? `<tr><td style="padding:4px 0;color:#6b7280;font-weight:500">Vehicle rego</td><td style="padding:4px 0;font-family:monospace;font-weight:600">${_escapeHTML(rego.toUpperCase())}</td></tr>` : ''}
      ${qty ? `<tr><td style="padding:4px 0;color:#6b7280;font-weight:500">Items / pallets</td><td style="padding:4px 0">${_escapeHTML(qty)}</td></tr>` : ''}
      ${notes ? `<tr><td style="padding:4px 0;color:#6b7280;font-weight:500;vertical-align:top">Notes</td><td style="padding:4px 0">${_escapeHTML(notes)}</td></tr>` : ''}
    </table>
  </div>

  <hr style="border:none;border-top:1px solid #f3f4f6;margin:12px 0">

  <div style="margin-bottom:12px">
    <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;color:#9ca3af;margin-bottom:8px">Site contacts</div>
    ${contactCards}
  </div>

  ${photos.length > 0 ? `
  <hr style="border:none;border-top:1px solid #f3f4f6;margin:12px 0">
  <div style="margin-bottom:12px">
    <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;color:#9ca3af;margin-bottom:8px">Attached photos (${photos.length})</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">${photoImgs}</div>
  </div>
  ` : ''}

  <hr style="border:none;border-top:1px solid #f3f4f6;margin:12px 0">

  <div style="display:flex;gap:16px;margin-top:8px">
    <div style="flex:1">
      <div style="font-size:11px;color:#9ca3af;margin-bottom:4px">Received by (print name)</div>
      <div style="border-bottom:1px solid #d1d5db;height:28px"></div>
    </div>
    <div style="flex:1">
      <div style="font-size:11px;color:#9ca3af;margin-bottom:4px">Signature</div>
      <div style="border-bottom:1px solid #d1d5db;height:28px"></div>
    </div>
    <div style="width:80px">
      <div style="font-size:11px;color:#9ca3af;margin-bottom:4px">Date</div>
      <div style="border-bottom:1px solid #d1d5db;height:28px"></div>
    </div>
  </div>
  <div style="font-size:10px;color:#d1d5db;text-align:center;margin-top:16px">
    Generated by SiteNav · ${dNo}
  </div>
</div>`;
}

/**
 * printDocket(point, contacts, formData, photos) → opens print window
 */
export function printDocket(point, contacts, formData, photos = []) {
  if (!formData.po?.trim()) {
    throw new Error('PO / Reference number is required before printing.');
  }
  const html = buildDocketHTML(point, contacts, formData, photos);
  const win = window.open('', '_blank', 'width=680,height=900');
  win.document.write(`<!DOCTYPE html><html><head>
    <title>Docket — ${_escapeHTML(formData.po)}</title>
    <style>
      body { margin: 0; padding: 28px; font-family: system-ui, sans-serif; }
      @page { size: A4; margin: 20mm; }
      @media print { body { padding: 0; } }
    </style>
  </head><body>${html}<script>window.onload=()=>{window.print();}<\/script></body></html>`);
  win.document.close();
}
