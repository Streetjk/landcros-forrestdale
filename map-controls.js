// Small DOM-only contract for SiteNav map controls. Renderer/camera ownership stays
// in viewer3d.js; this module only keeps accessible control state consistent.

export function mapControlLabel(control = {}) {
  const label = typeof control?.label === 'string' ? control.label.trim() : '';
  if (label) return label;
  if (control?.action === 'fullscreen') return 'Fullscreen map';
  if (control?.action === 'autopan') return 'Auto-pan map';
  const id = typeof control?.id === 'string' ? control.id.trim() : '';
  return id ? `Camera view: ${id}` : 'Camera view';
}

export function syncPressedButton(button, active) {
  if (!button) return false;
  const pressed = Boolean(active);
  button.classList?.toggle?.('active', pressed);
  button.setAttribute?.('aria-pressed', String(pressed));
  return pressed;
}

export function syncPressedButtons(root, selector, active) {
  if (!root || typeof root.querySelectorAll !== 'function') return 0;
  const buttons = Array.from(root.querySelectorAll(selector));
  for (const button of buttons) syncPressedButton(button, active);
  return buttons.length;
}
